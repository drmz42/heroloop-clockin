package xyz.heroloop.seeker;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

/**
 * HeroLoop Seeker: the game in one full-screen WebView, no browser UI.
 * The user agent carries "Solana Mobile Web Shell", which lets the page's Mobile Wallet
 * Adapter talk to any installed Solana wallet app (Phantom, Solflare, Backpack, Seed Vault);
 * Android shows its own chooser when several are installed. Pages of the game host stay in
 * the app; wallet links go to the wallet app; any other link opens outside the app.
 */
public class MainActivity extends Activity {
    private static final int WALLET_REQUEST = 7001;
    private static final int BRAND_DARK = 0xFF070606;
    private static final int BRAND_GOLD = 0xFFD6C4A0;
    // The launch screen waits for React to mount the game; after this long it offers Retry.
    private static final long READY_STALL_MS = 20_000;
    private static final long READY_POLL_MS = 250;
    private static final long READY_GIVE_UP_MS = 90_000;
    private static final long BACK_EXIT_WINDOW_MS = 2_000;
    private static final String READY_PROBE =
        "(function(){var r=document.getElementById('root');return !!(r&&r.childElementCount>0);})()";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView webView;
    // Launch/error overlay: shown until the game UI is ready, and again for a failed page load.
    private View launchView;
    private ProgressBar launchSpinner;
    private TextView launchMessage;
    private Button launchRetry;
    private boolean gameReady;
    private boolean pageFailed;
    private boolean walletInFront;
    private long loadStartedAt;
    private long lastBackAt;
    private ConnectivityManager.NetworkCallback networkCallback;
    // Unpadded system areas in physical pixels, published to the page by pushInsets().
    private int safeTop, safeRight, safeBottom, safeLeft;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF070606);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Android 15 draws apps edge to edge; the container is padded for visible bars and the keyboard.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF070606);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(buildLaunchView(), new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Draw behind the camera cutout; the inset padding below keeps the game clear of it.
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                // Only the keyboard is handled natively. Status bar, camera cutout and gesture bar
                // are passed to the page as CSS variables (pushInsets), so the web layout decides the
                // spacing and changes to it ship without a new APK.
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                Insets cutout = insets.getInsets(WindowInsets.Type.displayCutout());
                view.setPadding(0, 0, 0, ime.bottom);
                safeTop = Math.max(bars.top, cutout.top);
                safeRight = Math.max(bars.right, cutout.right);
                safeBottom = ime.bottom > 0 ? 0 : Math.max(bars.bottom, cutout.bottom);
                safeLeft = Math.max(bars.left, cutout.left);
                pushInsets();
                return WindowInsets.CONSUMED;
            });
        }
        // The renderer keeps the app's priority while hidden (the wallet is in front).
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // The wallet socket is ws://localhost from an https page; Chromium treats loopback as
        // trustworthy, this only keeps older WebViews from refusing it as mixed content.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString()
            + " Solana Mobile Web Shell HeroLoopApp/" + BuildConfig.VERSION_NAME
            + " HeroLoopAppCode/" + BuildConfig.VERSION_CODE);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageFailed = false;
                if (!gameReady) loadStartedAt = SystemClock.uptimeMillis();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pushInsets();
                // onPageFinished only means the HTML arrived; the overlay stays until React mounts.
                if (!gameReady && !pageFailed) pollReady();
            }

            // Only a failed main page replaces the game; a missing image or API call does not.
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showLoadError("No connection. Check your internet and try again.");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                    showLoadError("HeroLoop servers are not responding. Please try again in a moment.");
                }
            }

            // Certificate errors are never bypassed.
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showLoadError("Secure connection failed. Check your network and try again.");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Subframe (iframe) navigation is never intercepted.
                if (!request.isForMainFrame()) return false;
                return route(request.getUrl());
            }
        });

        loadStartedAt = SystemClock.uptimeMillis();
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(BuildConfig.GAME_URL);
        }
        applyImmersive();
        watchNetwork();
    }

    // Sets --hl-app-safe-{top,right,bottom,left} (CSS px) on <html> for the web layout.
    private void pushInsets() {
        if (webView == null) return;
        float density = getResources().getDisplayMetrics().density;
        String script = String.format(Locale.ROOT,
            "(function(s){s.setProperty('--hl-app-safe-top','%dpx');s.setProperty('--hl-app-safe-right','%dpx');"
                + "s.setProperty('--hl-app-safe-bottom','%dpx');s.setProperty('--hl-app-safe-left','%dpx');})"
                + "(document.documentElement.style)",
            Math.round(safeTop / density), Math.round(safeRight / density),
            Math.round(safeBottom / density), Math.round(safeLeft / density));
        webView.evaluateJavascript(script, null);
    }

    private View buildLaunchView() {
        float dp = getResources().getDisplayMetrics().density;
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(BRAND_DARK);
        overlay.setClickable(true);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        int side = Math.round(32 * dp);
        column.setPadding(side, 0, side, 0);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_maskable);
        logo.setContentDescription("HeroLoop");
        column.addView(logo, new LinearLayout.LayoutParams(Math.round(112 * dp), Math.round(112 * dp)));

        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(BRAND_GOLD));
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(Math.round(28 * dp), Math.round(28 * dp));
        spinnerParams.topMargin = Math.round(28 * dp);
        column.addView(spinner, spinnerParams);
        launchSpinner = spinner;

        TextView message = new TextView(this);
        message.setTextColor(BRAND_GOLD);
        message.setTextSize(15);
        message.setGravity(Gravity.CENTER);
        message.setVisibility(View.GONE);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        messageParams.topMargin = Math.round(24 * dp);
        column.addView(message, messageParams);
        launchMessage = message;

        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setAllCaps(false);
        retry.setTextColor(BRAND_DARK);
        retry.setBackgroundTintList(ColorStateList.valueOf(BRAND_GOLD));
        retry.setMinWidth(Math.round(160 * dp));
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(view -> retryLoad());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, Math.round(48 * dp));
        retryParams.topMargin = Math.round(20 * dp);
        column.addView(retry, retryParams);
        launchRetry = retry;

        overlay.addView(column, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        TextView version = new TextView(this);
        version.setTextColor(0x8CD6C4A0);
        version.setTextSize(11);
        version.setGravity(Gravity.CENTER_HORIZONTAL);
        version.setText("HeroLoop · App " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")");
        FrameLayout.LayoutParams versionParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        versionParams.bottomMargin = Math.round(28 * dp);
        overlay.addView(version, versionParams);

        launchView = overlay;
        return overlay;
    }

    // Polls until the React app has mounted, then reveals the game. A stall offers Retry but
    // keeps waiting, so a slow network still lands in the game without a tap.
    private void pollReady() {
        main.removeCallbacks(readyPoll);
        main.post(readyPoll);
    }

    private final Runnable readyPoll = new Runnable() {
        @Override
        public void run() {
            if (gameReady || pageFailed || webView == null) return;
            webView.evaluateJavascript(READY_PROBE, value -> {
                if (gameReady || pageFailed) return;
                if ("true".equals(value)) {
                    revealGame();
                    return;
                }
                long waited = SystemClock.uptimeMillis() - loadStartedAt;
                if (waited >= READY_STALL_MS && launchRetry.getVisibility() != View.VISIBLE) {
                    showLaunchMessage("Loading is taking longer than usual.", true);
                }
                if (waited < READY_GIVE_UP_MS) main.postDelayed(readyPoll, READY_POLL_MS);
            });
        }
    };

    private void revealGame() {
        gameReady = true;
        AppUpdater.check(this, false);
        main.removeCallbacks(readyPoll);
        launchView.animate().alpha(0f).setDuration(220).withEndAction(() -> {
            launchView.setVisibility(View.GONE);
            launchView.setAlpha(1f);
        }).start();
    }

    private void showLoadError(String text) {
        pageFailed = true;
        gameReady = false;
        main.removeCallbacks(readyPoll);
        launchView.animate().cancel();
        launchView.setAlpha(1f);
        launchView.setVisibility(View.VISIBLE);
        showLaunchMessage(text, false);
    }

    private void showLaunchMessage(String text, boolean keepSpinner) {
        launchMessage.setText(text);
        launchMessage.setVisibility(View.VISIBLE);
        launchRetry.setVisibility(View.VISIBLE);
        launchSpinner.setVisibility(keepSpinner ? View.VISIBLE : View.GONE);
    }

    // Retry reloads the same game origin; cookies, storage and the linked account are untouched.
    private void retryLoad() {
        pageFailed = false;
        gameReady = false;
        loadStartedAt = SystemClock.uptimeMillis();
        launchMessage.setVisibility(View.GONE);
        launchRetry.setVisibility(View.GONE);
        launchSpinner.setVisibility(View.VISIBLE);
        launchView.setVisibility(View.VISIBLE);
        String url = webView.getUrl();
        if (url != null && Uri.parse(url).getHost() != null
                && BuildConfig.GAME_HOST.equalsIgnoreCase(Uri.parse(url).getHost())) {
            webView.reload();
        } else {
            webView.loadUrl(BuildConfig.GAME_URL);
        }
    }

    // When the network comes back while the error screen is up, retry without a tap.
    private void watchNetwork() {
        ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                main.post(() -> {
                    if (pageFailed && !isFinishing()) retryLoad();
                });
            }
        };
        try {
            connectivity.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException error) {
            networkCallback = null;
        }
    }

    // Full screen: status and navigation bars stay hidden and return briefly on an edge swipe.
    // Older Android versions keep their bars, because their fullscreen flags break adjustResize.
    private void applyImmersive() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller == null) return;
        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    // Mirrors the official Solana Mobile web shell (npx solana-mobile webshell init,
    // WebShellViewClient): docs/game/seeker-android-build.md.
    private boolean route(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "solana-wallet":
                // Plain ACTION_VIEW, no CATEGORY_BROWSABLE: a wallet whose intent filter lacks
                // BROWSABLE (Seed Vault) must still match.
                if (launchWallet(new Intent(Intent.ACTION_VIEW, uri))) {
                    // Mobile Wallet Adapter treats a page "blur" within 3 s as proof that a wallet
                    // app answered; a WebView never blurs on its own.
                    webView.evaluateJavascript("window.dispatchEvent(new Event('blur'))", null);
                } else {
                    Toast.makeText(this, "Install a Solana wallet app (Seed Vault, Phantom, Solflare, Backpack) to sign in.", Toast.LENGTH_LONG).show();
                }
                return true;
            case "intent":
                launchIntentUri(uri.toString());
                return true;
            case "blob":
            case "javascript":
                return false;
            case "http":
            case "https":
                // The published APK is installed by the app itself (AppUpdater), never in the WebView.
                if (AppUpdater.isUpdateLink(uri)) {
                    AppUpdater.check(this, true);
                    return true;
                }
                if (BuildConfig.GAME_HOST.equalsIgnoreCase(uri.getHost())) return false;
                launch(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            default:
                launch(new Intent(Intent.ACTION_VIEW, uri));
                return true;
        }
    }

    // A page-controlled intent: only implicit, browsable targets, never explicit components,
    // selectors or URI permission grants; the fallback is honoured only for http(s).
    private void launchIntentUri(String url) {
        try {
            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            intent.removeFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            if (launch(intent)) return;
            String fallback = intent.getStringExtra("browser_fallback_url");
            if (fallback == null) return;
            Uri fallbackUri = Uri.parse(fallback);
            String fallbackScheme = fallbackUri.getScheme() == null ? "" : fallbackUri.getScheme().toLowerCase(Locale.ROOT);
            if ("http".equals(fallbackScheme) || "https".equals(fallbackScheme)) {
                launch(new Intent(Intent.ACTION_VIEW, fallbackUri));
            }
        } catch (Exception ignored) {
            // A malformed link is ignored rather than crashing the game.
        }
    }

    // For result, so the wallet can read the calling package and verify HeroLoop's identity
    // (Digital Asset Links of the game host); the result itself is not used.
    private boolean launchWallet(Intent intent) {
        try {
            walletInFront = true;
            WalletSessionService.start(this);
            startActivityForResult(intent, WALLET_REQUEST);
            return true;
        } catch (ActivityNotFoundException | SecurityException error) {
            walletInFront = false;
            WalletSessionService.stop(this);
            return false;
        }
    }

    private boolean launch(Intent intent) {
        try {
            startActivity(intent);
            return true;
        } catch (ActivityNotFoundException | SecurityException error) {
            return false;
        }
    }

    // Back: leaves an error/launch screen, then walks the game's history, and exits only on a
    // second press so a stray swipe does not close the game.
    @Override
    public void onBackPressed() {
        if (!gameReady) {
            super.onBackPressed();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastBackAt < BACK_EXIT_WINDOW_MS) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "Press Back again to exit HeroLoop", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    // While a wallet app is in front the WebView is never paused: the page must keep its Mobile
    // Wallet Adapter session alive (fetch the challenge, send the signing request). Otherwise
    // WebView.onPause() marks the page hidden so music and animations stop; JavaScript timers
    // (pauseTimers) are never paused, and server timers are unaffected either way.
    @Override
    protected void onResume() {
        super.onResume();
        walletInFront = false;
        WalletSessionService.stop(this);
        webView.onResume();
        applyImmersive();
        // Back from the "install unknown apps" setting: continue the update the player asked for.
        if (gameReady) AppUpdater.check(this, false);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        if (!walletInFront) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (networkCallback != null) {
            ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            try {
                if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // Already unregistered.
            }
        }
        webView.destroy();
        super.onDestroy();
    }
}
