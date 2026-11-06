package com.tradelens.app.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.core.alerts.AlertQueue
import com.tradelens.app.core.alerts.BackgroundServiceController
import com.tradelens.app.core.alerts.SignalAlerts
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.market.MarketRepository
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.MarketSocket
import com.tradelens.app.data.settings.LocalPrefs
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.data.settings.SettingsSyncer
import com.tradelens.app.state.AppState
import com.tradelens.app.state.ConnectionStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** What the app shows first. */
enum class AppGate {
    /** Still reading what the app remembers. */
    Loading,

    /** No session and no guest choice yet (fresh install, or just signed out). */
    Login,

    /** Signed in, or continuing as a guest. */
    Ready,
}

/** The rule for [AppGate]: a session or an explicit "continue as guest" gets in; otherwise the login screen. */
fun gateFor(signedIn: Boolean, guestChosen: Boolean): AppGate = if (signedIn || guestChosen) AppGate.Ready else AppGate.Login

@HiltViewModel
class MainViewModel @Inject constructor(
    val appState: AppState,
    private val market: MarketRepository,
    private val syncer: SettingsSyncer,
    private val settings: SettingsRepository,
    private val socket: MarketSocket,
    private val alerts: SignalAlerts,
    val alertQueue: AlertQueue,
    private val backgroundService: BackgroundServiceController,
) : ViewModel() {

    /** Null until the saved preferences have loaded. Drives theme and language. */
    val prefs: StateFlow<LocalPrefs?> =
        settings.prefs.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Splash until the saved session and choice are read, then login or the app. */
    val gate: StateFlow<AppGate> = combine(settings.session, settings.guestChosen) { session, guest ->
        gateFor(session != null, guest)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, AppGate.Loading)

    /** False until the user has answered the first-launch notification question; null while loading. */
    val notificationPromptDone: StateFlow<Boolean?> =
        settings.notificationPromptDone.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _pendingChart = MutableStateFlow<String?>(null)

    /** A symbol whose chart should be opened (from an alert popup or a tapped notification). */
    val pendingChart: StateFlow<String?> = _pendingChart.asStateFlow()

    init {
        refreshConnection()
        // Sync server settings on app start. Offline, the cached copy keeps being used.
        viewModelScope.launch { syncer.sync() }
        // While the app is open, listen for signals: popup, sound, vibration and notification.
        // (When it is in the background, the foreground service does this instead.)
        viewModelScope.launch {
            socket.signalFeed().collect { event ->
                when (event) {
                    is LiveEvent.SignalEvent -> alerts.handle(event.signal)
                    is LiveEvent.SignalUpdate -> alerts.handleUpdate(event.signal, event.change)
                    else -> Unit
                }
            }
        }
    }

    fun openChart(symbol: String) {
        if (symbol in MarketConfig.symbols) _pendingChart.value = symbol
    }

    fun consumePendingChart() {
        _pendingChart.value = null
    }

    fun markNotificationPromptDone() {
        viewModelScope.launch { settings.setNotificationPromptDone() }
        onNotificationPermissionChanged()
    }

    /** The notification permission may have just been granted: make the background watcher post its notification. */
    fun onNotificationPermissionChanged() = backgroundService.refresh()

    /** Pings /health and reflects the result in [AppState] (the live feed arrives in a later phase). */
    fun refreshConnection() {
        viewModelScope.launch {
            appState.setConnectionStatus(ConnectionStatus.Reconnecting)
            appState.setConnectionStatus(
                if (market.checkHealth() is AppResult.Success) ConnectionStatus.Live else ConnectionStatus.Offline,
            )
        }
    }
}
