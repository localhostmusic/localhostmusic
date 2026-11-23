package io.github.localhostmusic;

import android.content.ComponentName;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

// Native audio bridge for Android. The player lives in PlaybackService (a
// MediaSessionService) so playback survives backgrounding. This plugin is a
// MediaController on that session: JS AudioEngine calls become player commands,
// player callbacks become JS events.
@CapacitorPlugin(name = "LhmAudio")
@UnstableApi
public class LhmAudioPlugin extends Plugin {
    private MediaController controller;
    private ListenableFuture<MediaController> controllerFuture;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Handler ticker;
    private boolean hasUpcoming = false;
    // No events until JS has called in once. Events fired while the WebView is still
    // booting hit an uninitialised Capacitor bridge.
    private volatile boolean jsReady = false;

    private void emit(String event, JSObject data) {
        if (jsReady) notifyListeners(event, data);
    }

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            emit(isPlaying ? "play" : "pause", new JSObject());
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            JSObject buf = new JSObject();
            buf.put("buffering", state == Player.STATE_BUFFERING);
            emit("buffering", buf);
            if (state == Player.STATE_READY) {
                emitDuration();
            } else if (state == Player.STATE_ENDED) {
                emit("ended", new JSObject());
            }
        }

        @Override
        public void onMediaItemTransition(MediaItem item, int reason) {
            // AUTO: the current track finished and the player advanced gaplessly to the
            // queued one. Tell JS so the provider moves its cursor. Skips don't come
            // through here.
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                hasUpcoming = false;
                if (controller != null && controller.getCurrentMediaItemIndex() > 0) {
                    controller.removeMediaItems(0, controller.getCurrentMediaItemIndex());
                }
                emitDuration();
                emit("trackChanged", new JSObject());
            }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            JSObject o = new JSObject();
            o.put("message", error.getMessage());
            emit("audioerror", o);
        }
    };

    @Override
    public void load() {
        main.post(() -> {
            // Lock screen, notification and Bluetooth next/prev go through the JS queue
            // (PlayerProvider), not a player seek. The service calls these and they
            // are relayed to JS as events.
            PlaybackService.onNext = () -> main.post(() -> emit("remoteNext", new JSObject()));
            PlaybackService.onPrev = () -> main.post(() -> emit("remotePrev", new JSObject()));

            SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
            controllerFuture = new MediaController.Builder(getContext(), token).buildAsync();
            controllerFuture.addListener(() -> {
                try {
                    controller = controllerFuture.get();
                    controller.addListener(playerListener);
                    startTicker();
                } catch (Exception e) {
                    // Service unavailable, playback won't work.
                }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    private void emitDuration() {
        if (controller == null) return;
        long dur = controller.getDuration();
        JSObject d = new JSObject();
        d.put("duration", dur > 0 && dur != androidx.media3.common.C.TIME_UNSET ? dur / 1000.0 : 0);
        emit("durationchange", d);
    }

    private void startTicker() {
        ticker = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (controller != null && controller.isPlaying()) {
                    JSObject o = new JSObject();
                    o.put("currentTime", controller.getCurrentPosition() / 1000.0);
                    o.put("buffered", controller.getBufferedPosition() / 1000.0);
                    emit("time", o);
                }
                ticker.postDelayed(this, 250);
            }
        };
        ticker.postDelayed(tick, 250);
    }

    // Build a MediaItem carrying the metadata the lock screen / notification shows.
    private MediaItem itemFor(String url, PluginCall call) {
        MediaMetadata.Builder m = new MediaMetadata.Builder();
        String title = call.getString("title");
        String artist = call.getString("artist");
        String album = call.getString("album");
        String artwork = call.getString("artworkUrl");
        if (title != null) m.setTitle(title);
        if (artist != null) m.setArtist(artist);
        if (album != null) m.setAlbumTitle(album);
        if (artwork != null) m.setArtworkUri(Uri.parse(artwork));
        return new MediaItem.Builder().setMediaId(url).setUri(url).setMediaMetadata(m.build()).build();
    }

    // Keep commands pending until the MediaSession controller is connected.
    // Resolving a no-op here loses cold-start Play/Seek commands permanently.
    private void withController(PluginCall call, Runnable command) {
        final long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        main.post(new Runnable() {
            public void run() {
                if (controller != null) {
                    try { command.run(); } catch (Exception e) { call.reject("Audio command failed", e); }
                } else if (android.os.SystemClock.elapsedRealtime() >= deadline ||
                           (controllerFuture != null && controllerFuture.isDone())) {
                    call.reject("Audio service could not connect. Try Play again.");
                } else main.postDelayed(this, 25);
            }
        });
    }

    @PluginMethod
    public void setPlaybackRate(PluginCall call) {
        double rate = call.getDouble("rate", 1.0);
        boolean preserve = Boolean.TRUE.equals(call.getBoolean("preservePitch", true));
        if (!Double.isFinite(rate) || rate < 0.25 || rate > 4) { call.reject("invalid rate"); return; }
        withController(call, () -> {
            controller.setPlaybackParameters(new androidx.media3.common.PlaybackParameters((float) rate, preserve ? 1f : (float) rate));
            call.resolve();
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        jsReady = true;
        String url = call.getString("url");
        double resumeAt = call.getDouble("resumeAt", 0.0);
        boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", false));
        if (url == null) { call.reject("url required"); return; }
        withController(call, () -> {
            hasUpcoming = false;
            controller.setMediaItem(itemFor(url, call));
            controller.prepare();
            if (resumeAt > 0) controller.seekTo((long) (resumeAt * 1000));
            controller.setPlayWhenReady(autoplay);
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) { jsReady = true; withController(call, () -> { if (controller.getPlaybackState() == Player.STATE_IDLE) controller.prepare(); controller.play(); call.resolve(); }); }

    @PluginMethod
    public void pause(PluginCall call) { jsReady = true; withController(call, () -> { if (controller != null) controller.pause(); call.resolve(); }); }

    @PluginMethod
    public void seek(PluginCall call) {
        jsReady = true;
        double t = call.getDouble("position", 0.0);
        withController(call, () -> { if (controller != null) controller.seekTo((long) (t * 1000)); call.resolve(); });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        jsReady = true;
        double v = call.getDouble("volume", 1.0);
        withController(call, () -> { if (controller != null) controller.setVolume((float) v); call.resolve(); });
    }

    @PluginMethod
    public void setUpcoming(PluginCall call) {
        jsReady = true;
        String url = call.getString("url"); // null clears
        withController(call, () -> {
            int count = controller.getMediaItemCount();
            int cur = controller.getCurrentMediaItemIndex();
            if (count > cur + 1) controller.removeMediaItems(cur + 1, count);
            hasUpcoming = false;
            if (url != null) {
                controller.addMediaItem(itemFor(url, call));
                hasUpcoming = true;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void goToUpcoming(PluginCall call) {
        jsReady = true;
        String url = call.getString("url");
        boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", true));
        withController(call, () -> {
            if (hasUpcoming && controller.getMediaItemCount() > controller.getCurrentMediaItemIndex() + 1 &&
                controller.getMediaItemAt(controller.getCurrentMediaItemIndex() + 1).mediaId.equals(url)) {
                // Advance to the buffered next track by removing the current item. Not
                // seekToNext(): the service intercepts that and routes it back to JS,
                // which would loop.
                controller.removeMediaItem(controller.getCurrentMediaItemIndex());
                if (autoplay) controller.play();
                hasUpcoming = false;
            } else if (url != null) {
                hasUpcoming = false;
                controller.setMediaItem(itemFor(url, call));
                controller.prepare();
                controller.setPlayWhenReady(autoplay);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        jsReady = true;
        withController(call, () -> {
            if (controller != null) { controller.stop(); controller.clearMediaItems(); }
            hasUpcoming = false;
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withController(call, () -> {
            JSObject o = new JSObject();
            if (controller != null) {
                o.put("currentTime", controller.getCurrentPosition() / 1000.0);
                long dur = controller.getDuration();
                o.put("duration", dur > 0 && dur != androidx.media3.common.C.TIME_UNSET ? dur / 1000.0 : 0);
                o.put("paused", !controller.isPlaying());
                o.put("ready", controller.getPlaybackState() == Player.STATE_READY);
            }
            call.resolve(o);
        });
    }

    @Override
    protected void handleOnDestroy() {
        PlaybackService.onNext = null;
        PlaybackService.onPrev = null;
        main.post(() -> {
            if (ticker != null) ticker.removeCallbacksAndMessages(null);
            if (controller != null) { controller.removeListener(playerListener); controller.release(); controller = null; }
            if (controllerFuture != null) { MediaController.releaseFuture(controllerFuture); }
        });
    }
}
