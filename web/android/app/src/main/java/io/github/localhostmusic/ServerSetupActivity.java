package io.github.localhostmusic;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * First-run "where is your Localhost Music server?" screen.
 *
 * The app is only a shell around a self-hosted server, so there is no address
 * to ship. The answer is kept in SharedPreferences; MainActivity reads it on
 * every start and sends the user here when it is missing.
 */
public class ServerSetupActivity extends Activity {
    public static final String EXTRA_MESSAGE = "message";
    private static final String PREFS = "lhm";
    private static final String KEY = "server_url";

    private EditText input;
    private TextView status;
    private Button connect;

    /** The saved server origin (no trailing slash), or null before setup. */
    public static String savedUrl(Context c) {
        String v = c.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY, null);
        return v == null || v.isEmpty() ? null : v;
    }

    /** "music.example.com/" -> "https://music.example.com"; null when unusable. */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "https://" + s;
        try {
            URL u = new URL(s);
            if (u.getHost() == null || u.getHost().isEmpty()) return null;
            String port = u.getPort() == -1 ? "" : ":" + u.getPort();
            return u.getProtocol().toLowerCase() + "://" + u.getHost() + port;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (24 * d);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(0xFF0A0A0C);

        LinearLayout.LayoutParams row = new LinearLayout.LayoutParams((int) Math.min(
            getResources().getDisplayMetrics().widthPixels - 2 * pad, 480 * d),
            LinearLayout.LayoutParams.WRAP_CONTENT);
        row.topMargin = (int) (14 * d);

        TextView title = new TextView(this);
        title.setText("Connect to your Localhost Music server");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title, row);

        TextView hint = new TextView(this);
        hint.setText("Enter the address you use to open Localhost Music in a browser, "
            + "for example https://music.example.com or http://192.168.1.20:8585");
        hint.setTextColor(0xFFA0A0A8);
        hint.setTextSize(14);
        box.addView(hint, row);

        input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setHint("https://");
        input.setTextColor(0xFFFFFFFF);
        input.setHintTextColor(0xFF70707A);
        String current = savedUrl(this);
        if (current != null) input.setText(current);
        input.setOnEditorActionListener((v, action, ev) -> {
            if (action == EditorInfo.IME_ACTION_GO || action == EditorInfo.IME_ACTION_DONE) { tryConnect(); return true; }
            return false;
        });
        box.addView(input, row);

        connect = new Button(this);
        connect.setText("Connect");
        connect.setOnClickListener(v -> tryConnect());
        box.addView(connect, row);

        status = new TextView(this);
        status.setTextColor(0xFFFF8A80);
        status.setTextSize(14);
        String message = getIntent().getStringExtra(EXTRA_MESSAGE);
        if (message != null) status.setText(message);
        box.addView(status, row);

        setContentView(box);
        input.requestFocus();
    }

    private void tryConnect() {
        final String url = normalize(input.getText().toString());
        if (url == null) { status.setText("That doesn't look like a server address."); return; }
        connect.setEnabled(false);
        status.setTextColor(0xFFA0A0A8);
        status.setText("Checking " + url + " …");
        final Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            final String problem = probe(url);
            main.post(() -> {
                if (isFinishing()) return;
                connect.setEnabled(true);
                if (problem != null) {
                    status.setTextColor(0xFFFF8A80);
                    status.setText(problem);
                    return;
                }
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY, url).apply();
                Intent i = new Intent(this, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(i);
                finish();
            });
        }).start();
    }

    /** Null when a Localhost Music server answers at this address, otherwise what went wrong. */
    private static String probe(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/health").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            int code = c.getResponseCode();
            if (code != 200) return "Something answered at " + url + ", but it isn't a Localhost Music server (HTTP " + code + ").";
            java.io.InputStream in = c.getInputStream();
            byte[] buf = new byte[256];
            int n = in.read(buf);
            in.close();
            String body = n > 0 ? new String(buf, 0, n, "UTF-8") : "";
            if (!body.contains("\"status\"")) return "Something answered at " + url + ", but it isn't a Localhost Music server.";
            return null;
        } catch (Exception e) {
            String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            return "Couldn't reach " + url + " (" + why + ").";
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
