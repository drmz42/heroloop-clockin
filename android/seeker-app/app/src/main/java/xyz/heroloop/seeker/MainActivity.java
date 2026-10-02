package xyz.heroloop.seeker;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
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
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF070606);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Android 15 draws apps edge to edge; keep the game clear of the status bar, the display
        // cutout and the gesture/navigation bar on every version by padding its container.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF070606);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
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
            + " Solana Mobile Web Shell HeroLoopApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Subframe (iframe) navigation is never intercepted.
                if (!request.isForMainFrame()) return false;
                return route(request.getUrl());
            }
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(BuildConfig.GAME_URL);
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
            WalletSessionService.start(this);
            startActivityForResult(intent, WALLET_REQUEST);
            return true;
        } catch (ActivityNotFoundException | SecurityException error) {
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

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    // The WebView is not paused: while the wallet app is in front, the page must keep its
    // Mobile Wallet Adapter session alive (fetch the challenge, send the signing request).
    @Override
    protected void onResume() {
        super.onResume();
        WalletSessionService.stop(this);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }
}
