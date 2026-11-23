package io.github.localhostmusic;

import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import java.util.Collections;

// Foreground media service. ExoPlayer lives here, not in the plugin, so that
// MediaSessionService manages background playback and the notification, and any
// MediaController (the plugin, the lock screen, Bluetooth) can drive the session.
@UnstableApi
public class PlaybackService extends MediaSessionService {
    @Nullable
    private MediaSession session;

    // The queue lives in JS (PlayerProvider), so next/prev from the notification, lock
    // screen or Bluetooth go through it. The plugin (same process) sets these and the
    // ForwardingPlayer below calls them instead of seeking. In-app skips don't call
    // seekTo* (see the plugin), so there is no loop.
    public interface SkipHandler { void onSkip(); }
    @Nullable public static volatile SkipHandler onNext;
    @Nullable public static volatile SkipHandler onPrev;

    @Override
    public void onCreate() {
        super.onCreate();

        // ExoPlayer's HTTP stack doesn't share the WebView cookie jar. Read each request's
        // cookie from the WebView CookieManager at open time, so it survives a re-login.
        DataSource.Factory http = new DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true);
        DataSource.Factory authed = new ResolvingDataSource.Factory(http, dataSpec -> {
            String cookie = CookieManager.getInstance().getCookie(dataSpec.uri.toString());
            if (cookie != null) {
                return dataSpec.withAdditionalHeaders(Collections.singletonMap("Cookie", cookie));
            }
            return dataSpec;
        });

        ExoPlayer player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(authed))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(), /* handleAudioFocus= */ true)
                .setHandleAudioBecomingNoisy(true)
                .build();

        // Route next/prev through JS, and always advertise the buttons so the
        // notification shows them even with a short ExoPlayer playlist.
        Player routed = new ForwardingPlayer(player) {
            @Override public Commands getAvailableCommands() {
                return super.getAvailableCommands().buildUpon()
                        .add(COMMAND_SEEK_TO_NEXT).add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                        .add(COMMAND_SEEK_TO_PREVIOUS).add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                        .build();
            }
            @Override public void seekToNext() { fire(onNext); }
            @Override public void seekToNextMediaItem() { fire(onNext); }
            @Override public void seekToPrevious() { fire(onPrev); }
            @Override public void seekToPreviousMediaItem() { fire(onPrev); }
            private void fire(@Nullable SkipHandler h) { if (h != null) h.onSkip(); }
        };

        session = new MediaSession.Builder(this, routed).build();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(android.content.Intent rootIntent) {
        if (session != null) {
            Player player = session.getPlayer();
            if (!player.getPlayWhenReady() || player.getMediaItemCount() == 0) {
                stopSelf();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        onNext = null;
        onPrev = null;
        super.onDestroy();
    }
}
