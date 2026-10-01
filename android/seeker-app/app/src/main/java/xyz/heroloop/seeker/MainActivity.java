package xyz.heroloop.seeker;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * HeroLoop Seeker: the game in one full-screen WebView, no browser UI.
 * The user agent carries "Solana Mobile Web Shell", which lets the page's Mobile Wallet
 * Adapter talk to any installed Solana wallet app (Phantom, Solflare, Backpack, Seed Vault);
 * Android shows its own chooser when several are installed. Pages of the game host stay in
 * the app; wallet links go to the wallet app; any other link opens outside the app.
 */
public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF070606);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUserAgentString(settings.getUserAgentString()
            + " Solana Mobile Web Shell HeroLoopApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return route(request.getUrl());
            }
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(BuildConfig.GAME_URL);
    }

    private boolean route(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (("https".equals(scheme)) && BuildConfig.GAME_HOST.equals(uri.getHost())) return false;
        try {
            Intent intent = "intent".equals(scheme)
                ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                : new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            startActivity(intent);
            // Mobile Wallet Adapter treats a page "blur" within 3 s as proof that a wallet
            // app answered; tell the page explicitly, since a WebView may not blur on its own.
            if ("solana-wallet".equals(scheme)) webView.evaluateJavascript("window.dispatchEvent(new Event('blur'))", null);
        } catch (ActivityNotFoundException error) {
            if ("solana-wallet".equals(scheme)) {
                Toast.makeText(this, "Install a Solana wallet app (Phantom, Solflare, Backpack) to sign in.", Toast.LENGTH_LONG).show();
            }
        } catch (Exception ignored) {
            // A malformed link is ignored rather than crashing the game.
        }
        return true;
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

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }
}
