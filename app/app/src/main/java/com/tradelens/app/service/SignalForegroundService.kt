package com.tradelens.app.service

import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.tradelens.app.MainActivity
import com.tradelens.app.R
import com.tradelens.app.core.alerts.NotificationChannels
import com.tradelens.app.core.alerts.SignalAlerts
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.MarketSocket
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Keeps the live connection open while the app is in the background, and posts a notification for each signal.
 * It shows one persistent low-priority notification ("TradeLens is watching the market"), as foreground services must.
 * The connection reconnects by itself (MarketSocket backs off from 1s to 30s). Started and stopped by
 * [com.tradelens.app.core.alerts.BackgroundServiceController].
 */
@AndroidEntryPoint
class SignalForegroundService : Service() {
    @Inject lateinit var socket: MarketSocket
    @Inject lateinit var alerts: SignalAlerts

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var listener: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.ensure(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        enterForeground()
        if (listener?.isActive != true) {
            listener = scope.launch {
                Log.i(TAG, "watching for signals")
                socket.signalFeed().collect { event ->
                    when (event) {
                        is LiveEvent.SignalEvent -> alerts.handle(event.signal)
                        is LiveEvent.SignalUpdate -> alerts.handleUpdate(event.signal, event.change)
                        else -> Unit
                    }
                }
            }
        }
        return START_STICKY
    }

    private fun enterForeground() {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, NotificationChannels.WATCHING)
            .setSmallIcon(R.drawable.ic_stat_signal)
            .setContentTitle(getString(R.string.watching_notification_title))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    /** Android 15 limits dataSync foreground services to about 6 hours a day; stop cleanly when told. Reopening the app restarts it. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "dataSync foreground service timed out, stopping")
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        Log.i(TAG, "stopped watching")
        super.onDestroy()
    }

    private companion object {
        const val TAG = "TradeLensService"
        const val NOTIFICATION_ID = 1001
    }
}
