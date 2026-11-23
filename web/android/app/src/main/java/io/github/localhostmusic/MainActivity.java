package io.github.localhostmusic;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native audio bridge before the Capacitor bridge starts.
        registerPlugin(LhmAudioPlugin.class);
        // The WebView loads the user's own server; the address comes from the
        // first-run screen (ServerSetupActivity), not from the build.
        String server = ServerSetupActivity.savedUrl(this);
        if (server != null) config = new CapConfig.Builder(this).setServerUrl(server).create();
        super.onCreate(savedInstanceState);
        if (server == null) {
            startActivity(new Intent(this, ServerSetupActivity.class));
            finish();
        }
    }
}
