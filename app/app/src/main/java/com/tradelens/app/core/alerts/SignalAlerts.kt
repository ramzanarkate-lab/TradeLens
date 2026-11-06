package com.tradelens.app.core.alerts

import android.content.Context
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.StatusChangeDto
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The one path every signal takes, real or test, from the app or from the background service:
 *  - popup (when enabled and the app is on screen), queued so two never overlap
 *  - sound and vibration, following their switches
 *  - a notification (when allowed), which also works while the app is in the background
 * The same signal arriving twice (e.g. the app and the service both hear it) is handled once.
 */
@Singleton
class SignalAlerts @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: SettingsRepository,
    private val queue: AlertQueue,
    private val notifier: SignalNotifier,
) {
    private val seen = object : LinkedHashMap<String, Unit>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > 100
    }

    suspend fun handle(signal: SignalDto) {
        val first = synchronized(seen) { seen.put(signal.id, Unit) == null }
        if (!first) return
        val prefs = settings.prefs.first()
        val inForeground = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        Log.i(TAG, "signal ${signal.side} ${signal.symbol} test=${signal.test} foreground=$inForeground popup=${prefs.popup}")

        if (inForeground && prefs.popup) queue.offer(signal)
        if (prefs.sound || prefs.vibration) AlertEffects.play(context, prefs.sound, prefs.vibration)
        val posted = notifier.post(signal)
        Log.i(TAG, "notification posted=$posted")
    }

    /** A running signal reached a target or its stop: one notification (and sound), once per status. No popup. */
    suspend fun handleUpdate(signal: SignalDto, change: StatusChangeDto) {
        if (change.status !in NOTIFY_STATUSES) return
        val first = synchronized(seen) { seen.put("${signal.id}:${change.status}", Unit) == null }
        if (!first) return
        val prefs = settings.prefs.first()
        if (prefs.sound || prefs.vibration) AlertEffects.play(context, prefs.sound, prefs.vibration)
        notifier.postUpdate(signal, change)
    }

    private companion object {
        val NOTIFY_STATUSES = setOf("TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT", "BREAKEVEN_EXIT", "TIME_EXIT")
        const val TAG = "TradeLensAlerts"
    }
}
