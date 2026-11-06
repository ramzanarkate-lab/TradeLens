package com.tradelens.app.ui.signals

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.MarketSocket
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.data.signals.DateRange
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.SignalFilters
import com.tradelens.app.data.signals.SignalLock
import com.tradelens.app.data.signals.SignalRepository
import com.tradelens.app.data.signals.SignalStatsDto
import com.tradelens.app.data.signals.SignalsPage
import com.tradelens.app.ui.navigation.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Signals are loaded this many at a time. */
const val PAGE_SIZE = 20

data class SignalsUiState(
    /** First load, nothing to show yet. */
    val loading: Boolean = true,
    /** Pull to refresh in progress. */
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val signals: List<SignalDto> = emptyList(),
    val total: Int = 0,
    val hasMore: Boolean = false,
    /** True for a guest when more signals exist than the 5 they may see. */
    val guestLocked: Boolean = false,
    val role: String = "guest",
    val filters: SignalFilters = SignalFilters(),
    val stats: SignalStatsDto? = null,
    /** The signal whose detail sheet is open. */
    val selected: SignalDto? = null,
    /** When set, only this signal is shown (opened from the dashboard). */
    val filterId: String? = null,
    val error: AppError? = null,
    /** Set when the single signal opened from the dashboard is behind a sign-in. */
    val lock: SignalLock? = null,
)

@HiltViewModel
class SignalsViewModel @Inject constructor(
    saved: SavedStateHandle,
    private val repository: SignalRepository,
    private val settings: SettingsRepository,
    private val socket: MarketSocket,
) : ViewModel() {
    private val _state = MutableStateFlow(SignalsUiState(filterId = saved.get<String>(Routes.ARG_SIGNAL_ID)))
    val state: StateFlow<SignalsUiState> = _state.asStateFlow()

    init {
        // Load now, and again whenever the account changes (sign in, sign out, role change): a guest sees 5, a user the full history.
        viewModelScope.launch {
            settings.session.map { it?.userId to it?.role }.distinctUntilChanged().collect { load() }
        }
    }

    fun load(refreshing: Boolean = false) {
        viewModelScope.launch {
            _state.update { if (refreshing) it.copy(refreshing = true, error = null, lock = null) else it.copy(loading = it.signals.isEmpty(), error = null, lock = null) }
            val id = _state.value.filterId
            if (id != null) loadOne(id) else loadList()
        }
    }

    fun refresh() = load(refreshing = true)

    private suspend fun loadList() {
        val filters = _state.value.filters
        when (val r = repository.signals(limit = PAGE_SIZE, offset = 0, filters = filters)) {
            is AppResult.Success -> showPage(r.data, replace = true)
            is AppResult.Error -> _state.update { it.copy(loading = false, refreshing = false, error = r.error) }
            AppResult.Loading -> Unit
        }
        when (val s = repository.stats(filters)) {
            is AppResult.Success -> _state.update { it.copy(stats = s.data) }
            else -> Unit // the list is still useful without the numbers
        }
    }

    private suspend fun loadOne(id: String) {
        when (val r = repository.signal(id)) {
            is AppResult.Success -> _state.update { it.copy(loading = false, refreshing = false, signals = listOf(r.data), total = 1, hasMore = false) }
            is AppResult.Error -> {
                val e = r.error
                // 401 = a guest asked for the details of one signal: show the sign-in lock, not an error.
                val lock = if ((e as? AppError.Http)?.code == 401) SignalLock.SignIn else null
                _state.update { it.copy(loading = false, refreshing = false, signals = emptyList(), error = if (lock == null) e else null, lock = lock) }
            }
            AppResult.Loading -> Unit
        }
    }

    private fun showPage(page: SignalsPage, replace: Boolean) {
        _state.update {
            it.copy(
                loading = false,
                refreshing = false,
                loadingMore = false,
                signals = if (replace) page.signals else it.signals + page.signals.filter { n -> it.signals.none { o -> o.id == n.id } },
                total = page.total,
                hasMore = page.hasMore,
                guestLocked = page.locked,
                role = page.role,
            )
        }
    }

    /** Called when the user scrolls to the end of the list. */
    fun loadMore() {
        val st = _state.value
        if (st.loadingMore || !st.hasMore || st.filterId != null) return
        viewModelScope.launch {
            _state.update { it.copy(loadingMore = true) }
            when (val r = repository.signals(limit = PAGE_SIZE, offset = st.signals.size, filters = st.filters)) {
                is AppResult.Success -> showPage(r.data, replace = false)
                is AppResult.Error -> _state.update { it.copy(loadingMore = false) }
                AppResult.Loading -> Unit
            }
        }
    }

    fun setFilters(change: (SignalFilters) -> SignalFilters) {
        _state.update { it.copy(filters = change(it.filters), filterId = null) }
        load()
    }

    fun showAll() {
        _state.update { it.copy(filterId = null) }
        load()
    }

    fun select(signal: SignalDto?) = _state.update { it.copy(selected = signal) }

    /** A guest who wants to unlock more goes back to the login screen. */
    fun goToLogin() {
        viewModelScope.launch { settings.setGuestChosen(false) }
    }

    /**
     * Listens for new signals and status changes while the screen is visible, and updates the list in place.
     * Suspends until cancelled.
     */
    suspend fun runLive() {
        socket.signalFeed().collect { event ->
            when (event) {
                is LiveEvent.SignalEvent -> if (matches(event.signal)) {
                    _state.update { st ->
                        if (st.filterId != null || st.signals.any { it.id == event.signal.id }) st
                        else st.copy(signals = listOf(event.signal) + st.signals, total = st.total + 1)
                    }
                    reloadStats()
                }
                is LiveEvent.SignalUpdate -> {
                    _state.update { st ->
                        st.copy(
                            signals = st.signals.map { if (it.id == event.signal.id) event.signal else it },
                            selected = if (st.selected?.id == event.signal.id) event.signal else st.selected,
                        )
                    }
                    reloadStats()
                }
                else -> Unit
            }
        }
    }

    private fun matches(signal: SignalDto): Boolean {
        val f = _state.value.filters
        if (f.symbol != null && f.symbol != signal.symbol) return false
        if (f.side != null && f.side != signal.side) return false
        if (f.status != null && f.status != (signal.status ?: "OPEN")) return false
        val span = f.range.millis
        return span == null || signal.createdAt >= System.currentTimeMillis() - span
    }

    private fun reloadStats() {
        viewModelScope.launch {
            val s = repository.stats(_state.value.filters)
            if (s is AppResult.Success) _state.update { it.copy(stats = s.data) }
        }
    }
}

/** The statuses offered in the filter, in the order shown. */
val STATUS_FILTERS = listOf("OPEN", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT", "BREAKEVEN_EXIT", "TIME_EXIT")

val RANGE_FILTERS = DateRange.entries.toList()
