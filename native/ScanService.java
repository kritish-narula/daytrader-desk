package com.boomai.daytraderdesk;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/** Keeps the app process alive while a scan / watch runs in the background.
 *  Declared with stopWithTask=true: swiping the app out of Recents stops it. */
public class ScanService extends Service {
    static final String CH = "scan";
    private PowerManager.WakeLock lock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Working in the background";
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null)
            nm.createNotificationChannel(new NotificationChannel(CH, "Background scan", NotificationManager.IMPORTANCE_LOW));
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CH)
            .setSmallIcon(getApplicationInfo().icon).setContentTitle("DayTrader Desk").setContentText(text)
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(pi).setPriority(NotificationCompat.PRIORITY_LOW).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(7, n);
        if (lock == null) {
            lock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dtd:scan");
            lock.acquire(3 * 60 * 60 * 1000L);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) { stopSelf(); }

    @Override
    public void onDestroy() {
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
