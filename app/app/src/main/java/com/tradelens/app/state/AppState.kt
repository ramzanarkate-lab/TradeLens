package com.tradelens.app.state

import com.tradelens.app.BuildConfig
import com.tradelens.app.core.di.ApplicationScope
import com.tradelens.app.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

enum class ConnectionStatus { Live, Reconnecting, Offline }

/** App-wide state: connection status, the server URL in use, and the session token sent with API calls. */
@Singleton
class AppState @Inject constructor(
    settings: SettingsRepository,
    @ApplicationScope scope: CoroutineScope,
) {
    private val _connectionStatus = MutableStateFlow(ConnectionStatus.Offline)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _serverUrl = MutableStateFlow(BuildConfig.SERVER_URL)
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private val _authToken = MutableStateFlow<String?>(null)
    val authToken: StateFlow<String?> = _authToken.asStateFlow()

    private val _focusServerSection = MutableStateFlow(false)

    /** Set when another screen wants Settings to scroll to its Server section ("Check server"). */
    val focusServerSection: StateFlow<Boolean> = _focusServerSection.asStateFlow()

    fun requestServerSection() {
        _focusServerSection.value = true
    }

    fun serverSectionShown() {
        _focusServerSection.value = false
    }

    private val _chartSymbol = MutableStateFlow<String?>(null)

    /** The symbol shown on the chart screen, for the top app bar title. Set by the chart screen while it is on screen. */
    val chartSymbol: StateFlow<String?> = _chartSymbol.asStateFlow()

    fun setChartSymbol(symbol: String?) {
        _chartSymbol.value = symbol
    }

    init {
        // The address built into the app (BuildConfig) is used for everyone. Only a signed-in admin can override it
        // (saved on this device); for any other account a leftover override is ignored.
        scope.launch {
            combine(settings.serverUrlOverride, settings.session) { override, session -> override to session }.collect { (override, session) ->
                _serverUrl.value = override?.takeIf { it.isNotBlank() && session?.role == "admin" } ?: BuildConfig.SERVER_URL
            }
        }
        scope.launch { settings.session.collect { _authToken.value = it?.token } }
    }

    fun setConnectionStatus(status: ConnectionStatus) {
        _connectionStatus.value = status
    }

    /** Lets a caller make sure the token is in place before its first request (the collector above is asynchronous). */
    fun setAuthToken(token: String?) {
        _authToken.value = token
    }
}
