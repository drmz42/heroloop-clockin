package xyz.heroloop.seeker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps HeroLoop running while a wallet app is in front. The page holds the Mobile Wallet
 * Adapter session (connect, load the sign-in message, sign); Android freezes a background app
 * within seconds, and a frozen page never receives the wallet's answer. A short foreground
 * service lasts at most two minutes and stops as soon as HeroLoop is back in front.
 */
public class WalletSessionService extends Service {
    private static final String CHANNEL = "wallet-session";
    private static final long MAX_MS = 120_000;
    private final Handler handler = new Handler(Looper.getMainLooper());

    static void start(Context context) {
        try {
            Intent intent = new Intent(context, WalletSessionService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (RuntimeException ignored) {
            // Starting is best effort; a fast wallet answers without it.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, WalletSessionService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            } else {
                startForeground(1, notification);
            }
        } catch (RuntimeException error) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::stopSelf, MAX_MS);
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL) == null) {
                manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Wallet sign-in", NotificationManager.IMPORTANCE_LOW));
            }
            builder = new Notification.Builder(this, CHANNEL);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("HeroLoop")
            .setContentText("Waiting for your wallet…")
            .setOngoing(true)
            .build();
    }

    // Android 14+: a short service must stop when its time is up, or the app is stopped.
    @Override
    public void onTimeout(int startId) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
