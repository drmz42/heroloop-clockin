package xyz.heroloop.seeker;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Self-update while HeroLoop is distributed outside a store: reads the public
 * https://heroloop.xyz/download/latest.json (ops/install-vps2-apk-download.sh), downloads a newer
 * APK over HTTPS, checks its size and SHA-256 against the manifest and hands it to Android's
 * PackageInstaller. Android itself refuses an APK signed with another key or a lower versionCode.
 * The first update needs the player to allow "install unknown apps" for HeroLoop and to confirm;
 * from Android 12, once HeroLoop installed itself, later updates may install without a prompt.
 */
final class AppUpdater {
    static final String ACTION_STATUS = "xyz.heroloop.seeker.UPDATE_STATUS";
    private static final String MANIFEST_URL = "https://heroloop.xyz/download/latest.json";
    private static final String DOWNLOAD_BASE = "https://heroloop.xyz/download/";
    private static final Pattern FILE_NAME = Pattern.compile("^heroloop-seeker-[0-9A-Za-z.+-]{1,40}-[0-9]{1,9}\\.apk$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MAX_APK_BYTES = 64L * 1024 * 1024;
    private static final long MAX_MANIFEST_BYTES = 16 * 1024;

    private static boolean running;
    private static boolean awaitingPermission;

    private AppUpdater() {}

    /** Checks for a newer APK and installs it. Safe to call repeatedly; one run at a time. */
    static synchronized void check(Activity activity, boolean fromTap) {
        if (running) {
            if (fromTap) toast(activity, "The update is downloading…");
            return;
        }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            // Only ask from a tap or a resume right after the settings screen, never by surprise.
            if (!fromTap && !awaitingPermission) return;
            awaitingPermission = true;
            if (fromTap) {
                toast(activity, "Allow HeroLoop to install updates, then come back.");
                try {
                    activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
                } catch (RuntimeException ignored) {
                    toast(activity, "Open Settings › Apps › HeroLoop › Install unknown apps.");
                }
            }
            return;
        }
        awaitingPermission = false;
        running = true;
        Context app = activity.getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String failure = null;
            String fallback = null;
            try {
                JSONObject latest = new JSONObject(new String(read(MANIFEST_URL, MAX_MANIFEST_BYTES), "UTF-8"));
                int code = latest.getInt("versionCode");
                if (code <= BuildConfig.VERSION_CODE) {
                    if (fromTap) failure = "HeroLoop is up to date.";
                    return;
                }
                String fileName = latest.getString("fileName");
                String sha256 = latest.getString("sha256").toLowerCase(Locale.ROOT);
                long size = latest.getLong("sizeBytes");
                if (!FILE_NAME.matcher(fileName).matches() || !SHA256.matcher(sha256).matches()
                        || size < 1 || size > MAX_APK_BYTES) {
                    throw new IllegalStateException("bad manifest");
                }
                fallback = DOWNLOAD_BASE + fileName;
                main.post(() -> toast(app, "Downloading HeroLoop update…"));
                File apk = new File(app.getCacheDir(), "update.apk");
                download(DOWNLOAD_BASE + fileName, apk, size);
                if (apk.length() != size || !sha256.equals(digest(apk))) {
                    apk.delete();
                    throw new IllegalStateException("checksum mismatch");
                }
                install(app, apk);
            } catch (Exception error) {
                failure = "Update failed. Check your connection and try again.";
            } finally {
                String message = failure;
                String browserUrl = failure != null && fromTap ? fallback : null;
                main.post(() -> {
                    synchronized (AppUpdater.class) { running = false; }
                    if (message != null) toast(app, message);
                    // A tapped update that failed in the app still reaches the player through the browser.
                    if (browserUrl != null) openInBrowser(app, browserUrl);
                });
            }
        }, "heroloop-update").start();
    }

    /** True when the page asked for the published APK; the native updater handles it. */
    static boolean isUpdateLink(Uri uri) {
        return "https".equals(uri.getScheme())
            && "heroloop.xyz".equalsIgnoreCase(uri.getHost())
            && uri.getPath() != null
            && uri.getPath().startsWith("/download/")
            && FILE_NAME.matcher(uri.getPath().substring("/download/".length())).matches();
    }

    private static void install(Context context, File apk) throws Exception {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
            new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (InputStream in = new FileInputStream(apk);
                 OutputStream out = session.openWrite("heroloop.apk", 0, apk.length())) {
                copy(in, out, apk.length());
                session.fsync(out);
            }
            Intent status = new Intent(context, UpdateStatusReceiver.class).setAction(ACTION_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).getIntentSender());
        } finally {
            apk.delete();
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        if (connection.getResponseCode() != 200) {
            connection.disconnect();
            throw new IllegalStateException("HTTP " + connection.getResponseCode());
        }
        return connection;
    }

    private static byte[] read(String url, long limit) throws Exception {
        HttpURLConnection connection = open(url);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            copy(in, out, limit);
            return out.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private static void download(String url, File target, long size) throws Exception {
        HttpURLConnection connection = open(url);
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
            copy(in, out, size);
        } finally {
            connection.disconnect();
        }
    }

    private static void copy(InputStream in, OutputStream out, long limit) throws Exception {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int n; (n = in.read(buffer)) != -1; ) {
            total += n;
            if (total > limit) throw new IllegalStateException("too large");
            out.write(buffer, 0, n);
        }
    }

    private static String digest(File file) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) != -1; ) sha.update(buffer, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : sha.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    private static void openInBrowser(Context context, String url) {
        Intent browser = Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_BROWSER);
        browser.setAction(Intent.ACTION_VIEW);
        browser.setData(Uri.parse(url));
        browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(browser);
        } catch (RuntimeException ignored) {
            toast(context, "Download the update in your browser: " + url);
        }
    }

    private static void toast(Context context, String text) {
        Toast.makeText(context, text, Toast.LENGTH_LONG).show();
    }

    /** PackageInstaller result: shows Android's confirmation when it is required. */
    public static final class UpdateStatusReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        context.startActivity(confirm);
                    } catch (RuntimeException ignored) {
                        toast(context, "Open HeroLoop again to finish the update.");
                    }
                }
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                toast(context, "Update was not installed. Tap Download update to try again.");
            }
        }
    }
}
