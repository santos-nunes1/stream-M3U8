package com.streamcorsario.tv;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private PlayerView playerView;
    private ExoPlayer player;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.web);
        playerView = findViewById(R.id.player);
        playerView.setUseController(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new PlayerBridge(), "AndroidPlayer");
        webView.loadUrl("file:///android_asset/index.html");
        webView.requestFocus();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && playerView.getVisibility() == View.VISIBLE) {
            webView.evaluateJavascript(
                    "window.__tvStopFromAndroid && window.__tvStopFromAndroid()",
                    null
            );
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void startPlayback(String url) {
        stopPlayback();
        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);
        playerView.setVisibility(View.VISIBLE);
        player.setMediaItem(MediaItem.fromUri(url));
        player.prepare();
        player.setPlayWhenReady(true);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                webView.evaluateJavascript(
                        "window.__tvStopFromAndroid && window.__tvStopFromAndroid()",
                        null
                );
            }
        });
    }

    private void stopPlayback() {
        playerView.setVisibility(View.GONE);
        playerView.setPlayer(null);
        if (player != null) {
            player.release();
            player = null;
        }
    }

    @Override
    protected void onStop() {
        if (player != null) {
            player.pause();
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        stopPlayback();
        webView.destroy();
        super.onDestroy();
    }

    private class PlayerBridge {
        @JavascriptInterface
        public void play(String url) {
            runOnUiThread(() -> startPlayback(url));
        }

        @JavascriptInterface
        public void stop() {
            runOnUiThread(MainActivity.this::stopPlayback);
        }
    }
}
