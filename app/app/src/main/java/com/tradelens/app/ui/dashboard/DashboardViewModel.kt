package com.tradelens.app.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.data.dashboard.DashboardResponse
import com.tradelens.app.data.dashboard.crossedPivot
import com.tradelens.app.data.dashboard.referencePrice
import com.tradelens.app.data.dashboard.withCandle
import com.tradelens.app.data.dashboard.withSignal
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.MarketRepository
import com.tradelens.app.data.market.MarketSocket
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.state.AppState
import com.tradelens.app.state.ConnectionStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Result of the last GET /health: reachable or not, and how long it took. */
data class ServerHealth(
    val ok: Boolean,
    val millis: Long,
    /** Null on an older server that does not report it. */
    val live: Boolean? = null,
    val provider: String? = null,
    val reason: String? = null,
)

data class DashboardUiState(
    /** First load, nothing to show yet: skeletons. */
    val loading: Boolean = true,
    /** Reloading while content is on screen (pull to refresh). */
    val refreshing: Boolean = false,
    val data: DashboardResponse? = null,
    val error: AppError? = null,
    val health: ServerHealth? = null,
    /** Epoch millis of the last load or live update shown. */
    val lastUpdateMs: Long = 0,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val market: MarketRepository,
    private val socket: MarketSocket,
    private val appState: AppState,
    settings: SettingsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state: StateFlow<DashboardUiState> = _state.asStateFlow()

    val connection: StateFlow<ConnectionStatus> = appState.connectionStatus

    /** Only an admin has a Server section to go to. */
    val isAdmin: StateFlow<Boolean> =
        settings.session.map { it?.role == "admin" }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    /** Name of the signed-in user, or null for a guest. */
    val userName: StateFlow<String?> =
        settings.session.map { it?.name?.ifBlank { it.email } }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** 24h reference price per symbol from the last full load, so live prices can update the 24h change. */
    private var references: Map<String, Double> = emptyMap()
    private var lastLoadMs = 0L

    init {
        refresh()
    }

    /** Reloads everything. Existing cards stay on screen while it runs. */
    fun refresh() {
        viewModelScope.launch {
            _state.update { if (it.data == null) it.copy(loading = true, error = null) else it.copy(refreshing = true, error = null) }
            when (val result = market.dashboard()) {
                is AppResult.Success -> {
                    references = result.data.symbols.mapNotNull { s ->
                        referencePrice(s.price, s.changePercent24h)?.let { s.symbol to it }
                    }.toMap()
                    lastLoadMs = System.currentTimeMillis()
                    _state.update { it.copy(loading = false, refreshing = false, data = result.data, error = null, lastUpdateMs = lastLoadMs) }
                }
                is AppResult.Error -> _state.update { it.copy(loading = false, refreshing = false, error = result.error) }
                AppResult.Loading -> Unit
            }
            // Timed after the dashboard request, so the number reflects the server, not that heavier request.
            _state.update { it.copy(health = measureHealth()) }
        }
    }

    /** Called each time the screen comes to the foreground: reload if what is shown has gone stale. */
    fun refreshIfStale(maxAgeMs: Long = 20_000) {
        val s = _state.value
        if (s.loading || s.refreshing) return
        if (s.data == null || System.currentTimeMillis() - lastLoadMs > maxAgeMs) refresh()
    }

    /**
     * Listens for live candles and signals and updates the matching card in place. Suspends until cancelled,
     * so the screen runs it only while visible. Restarts when the set of symbols changes.
     */
    suspend fun runLive() {
        _state.map { st -> st.data?.symbols?.map { it.symbol }.orEmpty() }.distinctUntilChanged().collectLatest { symbols ->
            if (symbols.isEmpty()) return@collectLatest
            socket.dashboardEvents(symbols).collect { event -> apply(event) }
        }
    }

    private fun apply(event: LiveEvent) {
        val now = System.currentTimeMillis()
        var staleCard = false
        _state.update { st ->
            val data = st.data ?: return@update st
            when (event) {
                is LiveEvent.CandleUpdate -> {
                    val card = data.symbols.find { it.symbol == event.symbol } ?: return@update st
                    staleCard = card.crossedPivot(event.candle.close)
                    st.copy(data = data.withCandle(event.symbol, event.candle, references[event.symbol]), lastUpdateMs = now)
                }
                is LiveEvent.SignalEvent -> st.copy(data = data.withSignal(event.signal, now), lastUpdateMs = now)
                is LiveEvent.SignalUpdate -> st
            }
        }
        // The nearest support/resistance changed: fetch fresh pivots (at most every 10 seconds).
        if (staleCard && now - lastLoadMs > 10_000) {
            lastLoadMs = now
            refresh()
        }
    }

    private suspend fun measureHealth(): ServerHealth {
        val start = System.nanoTime()
        val result = market.checkHealth()
        val millis = (System.nanoTime() - start) / 1_000_000
        return when (result) {
            is AppResult.Success -> ServerHealth(true, millis, result.data.live, result.data.activeProvider, result.data.reason)
            else -> ServerHealth(false, millis)
        }
    }

    /** "Check server": Settings should open scrolled to its Server section. */
    fun checkServer() = appState.requestServerSection()
}
