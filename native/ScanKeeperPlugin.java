package com.boomai.daytraderdesk;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "ScanKeeper", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class ScanKeeperPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), ScanService.class);
        i.putExtra("text", call.getString("text", "Scanning stocks…"));
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ScanService.class));
        call.resolve();
    }

    @PluginMethod
    public void requestNotify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permCb");
            return;
        }
        JSObject r = new JSObject(); r.put("granted", true); call.resolve(r);
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", getPermissionState("notifications") == PermissionState.GRANTED); call.resolve(r);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel("alerts") == null)
            nm.createNotificationChannel(new NotificationChannel("alerts", "Trade alerts", NotificationManager.IMPORTANCE_HIGH));
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Notification permission not granted"); return;
        }
        Intent open = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        if (open != null) open.putExtra("sym", call.getString("sym", ""));
        int id = call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        PendingIntent pi = PendingIntent.getActivity(getContext(), id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationManagerCompat.from(getContext()).notify(id, new NotificationCompat.Builder(getContext(), "alerts")
            .setSmallIcon(getContext().getApplicationInfo().icon).setContentTitle(call.getString("title", "DayTrader Desk"))
            .setContentText(call.getString("body", "")).setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "")))
            .setAutoCancel(true).setContentIntent(pi).setPriority(NotificationCompat.PRIORITY_HIGH).build());
        call.resolve();
    }

    /** Hide app content from Recents thumbnails and block screenshots. */
    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }
}
