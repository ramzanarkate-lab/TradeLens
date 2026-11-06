package com.tradelens.app.core.alerts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import com.tradelens.app.R

object NotificationChannels {
    /** Signal alerts: high importance so they appear prominently. */
    const val TRADE_SIGNALS = "trade_signals"

    /** The persistent "watching the market" notification of the background service: low importance, no interruption. */
    const val WATCHING = "market_watching"

    /** Safe to call repeatedly: creating a channel that exists is a no-op. */
    fun ensure(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val signals = NotificationChannel(
            TRADE_SIGNALS,
            context.getString(R.string.channel_trade_signals),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_trade_signals_description)
            // The app plays the sound and vibration itself, so the Settings switches are honored on every alert.
            setSound(null, null)
            enableVibration(false)
        }
        val watching = NotificationChannel(
            WATCHING,
            context.getString(R.string.channel_watching),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.channel_watching_description)
            setShowBadge(false)
        }
        manager.createNotificationChannels(listOf(signals, watching))
    }
}
