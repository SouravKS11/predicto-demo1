package com.digitalcode13.delivery;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * DC13 Delivery test app. One WebView that opens the live test environment
 * directly on this app's role (customer, driver or merchant). Each role is a
 * separate package, so each keeps its own login and storage on the device.
 */
public class MainActivity extends Activity {

    private static final int REQ_LOCATION = 41;
    private static final int REQ_FILE = 42;
    private static final String HOST = Uri.parse(BuildConfig.BASE_URL).getHost();

    private WebView web;
    private ProgressBar bar;
    private View offline;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (BuildConfig.WEB_DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0A08"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0A08"));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#FF5101")));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, dp(3));
        lp.gravity = Gravity.TOP;
        root.addView(bar, lp);

        offline = buildOfflineView();
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " DC13App/" + BuildConfig.FLAVOR);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleUrl(req.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                bar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) offline.setVisibility(View.VISIBLE);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                bar.setProgress(p);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                return openFileChooser(cb, params);
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (hasLocation()) {
                    cb.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = cb;
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            loadStart();
        }
    }

    private void loadStart() {
        offline.setVisibility(View.GONE);
        if (!isOnline()) {
            offline.setVisibility(View.VISIBLE);
            return;
        }
        web.loadUrl(BuildConfig.BASE_URL + BuildConfig.START_ROUTE);
    }

    /** Keep the test environment and its sign-in pages inside the app; send everything else to the phone. */
    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        String host = uri.getHost() == null ? "" : uri.getHost();
        if ((scheme.equals("https") || scheme.equals("http"))
                && (host.equals(HOST) || host.endsWith(".supabase.co"))) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
        }
        return true;
    }

    /** Photo proof, licence and document uploads: offer the gallery/files and, for images, the camera. */
    private boolean openFileChooser(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = cb;
        cameraUri = null;
        boolean images = false;
        String[] types = params.getAcceptTypes();
        if (types == null || types.length == 0) images = true;
        else for (String t : types) if (t == null || t.isEmpty() || t.startsWith("image")) images = true;

        Intent pick;
        try { pick = params.createIntent(); } catch (Exception e) { pick = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE); }
        Intent chooser = Intent.createChooser(pick, images ? "Add a photo" : "Choose a file");

        if (images) {
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, "dc13_" + System.currentTimeMillis() + ".jpg");
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DC13");
                try { cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v); } catch (Exception ignored) { }
                if (cameraUri != null) cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            }
            if (cam.resolveActivity(getPackageManager()) != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
        }
        try {
            startActivityForResult(chooser, REQ_FILE);
            return true;
        } catch (Exception e) {
            fileCallback = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (res == RESULT_OK) {
            if (data != null && (data.getData() != null || data.getClipData() != null)) {
                result = WebChromeClient.FileChooserParams.parseResult(res, data);
            } else if (cameraUri != null) {
                result = new Uri[]{cameraUri};
            } else if (data != null && data.getExtras() != null && data.getExtras().get("data") instanceof Bitmap) {
                try {
                    java.io.File f = new java.io.File(getCacheDir(), "dc13_photo_" + System.currentTimeMillis() + ".jpg");
                    java.io.FileOutputStream out = new java.io.FileOutputStream(f);
                    ((Bitmap) data.getExtras().get("data")).compress(Bitmap.CompressFormat.JPEG, 90, out);
                    out.close();
                    result = new Uri[]{Uri.fromFile(f)};
                } catch (Exception ignored) { }
            }
        } else if (cameraUri != null) {
            try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) { }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
        cameraUri = null;
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocation(), false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        NetworkInfo ni = cm.getActiveNetworkInfo();
        return ni != null && ni.isConnected();
    }

    private View buildOfflineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));
        box.setBackgroundColor(Color.parseColor("#0B0A08"));

        TextView title = new TextView(this);
        title.setText("You're offline");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView body = new TextView(this);
        body.setText("Connect to the internet to use the DC13 Delivery test environment.");
        body.setTextColor(Color.parseColor("#9C968B"));
        body.setTextSize(15);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(10), 0, dp(24));
        box.addView(body);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setAllCaps(false);
        retry.setTextColor(Color.parseColor("#0B0A08"));
        retry.setBackgroundColor(Color.parseColor("#FF5101"));
        retry.setOnClickListener(v -> {
            if (web.getUrl() == null) loadStart(); else { offline.setVisibility(View.GONE); web.reload(); }
        });
        box.addView(retry, new LinearLayout.LayoutParams(dp(180), dp(48)));
        return box;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
