package io.github.localhostmusic.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Android TV WebView host for Localhost Music's TV UI.
 *
 * Chrome/TWA on Android TV navigate pages with a mouse cursor. This captures the
 * remote's d-pad in dispatchKeyEvent and injects KeyboardEvents into the page, so
 * the page's own spatial navigation moves focus.
 */
public class MainActivity extends Activity {
    // "<server>/tv", from the first-run screen (ServerSetupActivity).
    private String URL;
    // Consecutive main-frame load failures; after a few, offer to change server.
    private int failures = 0;
    private WebView web;
    // The d-pad is captured only while the TV UI is active. On other screens (login,
    // on-screen keyboard) the WebView handles it so text fields and the IME work.
    private volatile boolean navActive = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String server = ServerSetupActivity.savedUrl(this);
        if (server == null) { openSetup(null); return; }
        URL = server + "/tv";
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // let audio play without a tap
        s.setUseWideViewPort(true);   // respect the page's viewport (render at 1920, not zoomed)
        s.setLoadWithOverviewMode(true);
        web.setBackgroundColor(0xFF0A0A0C);
        web.setWebViewClient(new LhmWebViewClient());
        web.addJavascriptInterface(new Bridge(), "LhmTV");
        setContentView(web);
        web.loadUrl(URL);
    }

    private void openSetup(String message) {
        Intent i = new Intent(this, ServerSetupActivity.class);
        if (message != null) i.putExtra(ServerSetupActivity.EXTRA_MESSAGE, message);
        startActivity(i);
        finish();
    }

    private class LhmWebViewClient extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            // onPageFinished also fires for the error page, so only a load that
            // produced a real document clears the failure count.
            if (view.getProgress() == 100 && view.getTitle() != null && view.getTitle().contains("Localhost Music")) failures = 0;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // A new document hasn't claimed the d-pad yet. Without this reset a hard
            // redirect (e.g. session expiry to login) leaves navActive true and every
            // key is swallowed on a page that isn't listening.
            navActive = false;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            // Keep the WebView (and the LhmTV JS bridge) on our own host only.
            String host = Uri.parse(url).getHost();
            String home = Uri.parse(URL).getHost();
            return host == null || !host.equalsIgnoreCase(home); // true = block
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // TV boots race Wi-Fi: retry the main frame instead of stranding the
            // user on the stock error page.
            // After a minute of that, the address itself is the likelier problem.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame() && web != null) {
                if (++failures >= 12) { openSetup("Couldn't reach " + URL.replace("/tv", "") + ". Check the address, or press Connect to try again."); return; }
                web.postDelayed(() -> { if (web != null) web.loadUrl(URL); }, 5000);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The default kills the app when the renderer is OOM-killed (routine on
            // 1 GB TV boxes). Rebuild the activity instead.
            recreate();
            return true;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // Off the TV UI (navActive false, e.g. login flow) Back should walk the
        // WebView history before exiting the app.
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // JS-callable bridge: the /tv UI flips this on while it owns d-pad navigation.
    private class Bridge {
        @JavascriptInterface
        public void setNavActive(boolean active) { navActive = active; }

        @JavascriptInterface
        public void exit() { runOnUiThread(() -> finish()); }

        @JavascriptInterface
        public void changeServer() { runOnUiThread(() -> openSetup(null)); }
    }

    // Send a synthetic keydown to the page; Localhost Music's useSpatialNav listens on window.
    private void injectKey(String key) {
        if (web == null) return;
        String js = "(function(){try{"
            + "var t=document.activeElement||document.body;"
            + "var e=new KeyboardEvent('keydown',{key:'" + key + "',code:'" + key
            + "',bubbles:true,cancelable:true});"
            + "t.dispatchEvent(e);}catch(_){}})();";
        web.evaluateJavascript(js, null);
    }

    private String map(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:    return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN:  return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT:  return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "ArrowRight";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:   return "Enter";
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Outside the TV UI the WebView handles the d-pad itself.
        if (!navActive) return super.dispatchKeyEvent(event);

        int code = event.getKeyCode();

        // Menu opens the server screen from anywhere in the TV UI.
        if (code == KeyEvent.KEYCODE_MENU) {
            if (event.getAction() == KeyEvent.ACTION_UP) openSetup(null);
            return true;
        }

        // Back navigates the TV screen stack (Escape). Exit the app via Home.
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) injectKey("Escape");
            return true;
        }

        String key = map(code);
        if (key != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) injectKey(key);
            return true; // consume so the system never shows a cursor
        }
        return super.dispatchKeyEvent(event);
    }
}
