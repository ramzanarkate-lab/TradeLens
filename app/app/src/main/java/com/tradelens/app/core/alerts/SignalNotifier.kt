package com.tradelens.app.core.alerts

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.tradelens.app.MainActivity
import com.tradelens.app.R
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.StatusChangeDto
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** True when the app may post notifications (always before Android 13, otherwise once the user allowed it). */
fun Context.canPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
        return false
    }
    return NotificationManagerCompat.from(this).areNotificationsEnabled()
}

@Singleton
class SignalNotifier @Inject constructor(@ApplicationContext private val context: Context) {

    /** "BTCUSDT BUY hit TP1 (+1.0R)". Tapping it opens the app on that symbol's chart. Returns false if not allowed. */
    @SuppressLint("MissingPermission") // checked by canPostNotifications()
    fun postUpdate(signal: SignalDto, change: StatusChangeDto): Boolean {
        if (!context.canPostNotifications()) return false
        NotificationChannels.ensure(context)
        val text = SignalNotificationText.update(signal, change)
        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN_SYMBOL, signal.symbol)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val id = (signal.id + change.status).hashCode()
        val tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, NotificationChannels.TRADE_SIGNALS)
            .setSmallIcon(R.drawable.ic_stat_signal)
            .setContentTitle(text.title)
            .setContentText(text.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setWhen(change.at)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        NotificationManagerCompat.from(context).notify(id, notification)
        return true
    }

    /** Posts "BUY BTCUSDT at 67,420" with the reason as text. Tapping it opens the app on that symbol's chart. Returns false if not allowed. */
    @SuppressLint("MissingPermission") // checked by canPostNotifications()
    fun post(signal: SignalDto): Boolean {
        if (!context.canPostNotifications()) return false
        NotificationChannels.ensure(context)
        val text = SignalNotificationText.of(signal)

        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN_SYMBOL, signal.symbol)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val id = signal.id.hashCode()
        val tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val notification = NotificationCompat.Builder(context, NotificationChannels.TRADE_SIGNALS)
            .setSmallIcon(R.drawable.ic_stat_signal)
            .setContentTitle(text.title)
            .setContentText(text.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setWhen(signal.createdAt)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        NotificationManagerCompat.from(context).notify(id, notification)
        return true
    }
}
