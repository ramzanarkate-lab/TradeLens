package com.tradelens.app.core.alerts

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.tradelens.app.core.di.ApplicationScope
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.service.SignalForegroundService
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Runs the background watcher exactly when "Background alerts" is on and the user is signed in. */
@Singleton
class BackgroundServiceController @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: SettingsRepository,
    @ApplicationScope private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch {
            combine(settings.prefs.map { it.backgroundService }, settings.session.map { it != null }) { enabled, signedIn ->
                enabled && signedIn
            }.distinctUntilChanged().collect { shouldRun -> if (shouldRun) startService() else stopService() }
        }
    }

    /**
     * Re-sends the start command if the watcher should be running. Needed because Android hides a foreground service's
     * notification while the notification permission is missing, and does not post it later when the permission is granted:
     * starting the service again makes it post the notification. Safe to call any time (it is a no-op when it should be off).
     */
    fun refresh() {
        scope.launch {
            val shouldRun = settings.prefs.first().backgroundService && settings.session.first() != null
            if (shouldRun) startService()
        }
    }

    private fun startService() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, SignalForegroundService::class.java))
            Log.i(TAG, "background watcher started")
        } catch (e: Exception) {
            // Android refuses to start a foreground service while the app is in the background (e.g. a cold start by the system).
            Log.w(TAG, "could not start the background watcher now: ${e.message}")
        }
    }

    private fun stopService() {
        context.stopService(Intent(context, SignalForegroundService::class.java))
        Log.i(TAG, "background watcher stopped")
    }

    private companion object {
        const val TAG = "TradeLensService"
    }
}
