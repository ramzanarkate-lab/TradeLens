package com.tradelens.app.ui.chart

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.data.market.Candle
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.market.MarketRepository
import com.tradelens.app.data.market.MarketSocket
import com.tradelens.app.data.market.Pivots
import com.tradelens.app.data.signals.SignalRepository
import com.tradelens.app.data.settings.SettingsRepository
import kotlinx.coroutines.flow.first
import com.tradelens.app.state.AppState
import com.tradelens.app.ui.navigation.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import kotlin.math.max
import kotlin.math.min

data class ChartUiState(
    val symbol: String,
    val timeframe: String,
    val candles: List<Candle> = emptyList(),
    val pivots: Pivots? = null,
    val price: Double? = null,
    val changePercent24h: Double? = null,
    val loading: Boolean = true,
    val error: AppError? = null,
    val showPivots: Boolean = true,
    val showVolume: Boolean = true,
    val showEma20: Boolean = false,
    val showEma50: Boolean = false,
    /** Levels of the newest running signal for this symbol, if there is one. */
    val signal: ChartSignal? = null,
)

/** Holds the selected symbol and timeframe (also in SavedStateHandle, so they survive rotation and process death). */
@HiltViewModel
class ChartViewModel @Inject constructor(
    private val saved: SavedStateHandle,
    private val market: MarketRepository,
    private val socket: MarketSocket,
    private val settings: SettingsRepository,
    private val appState: AppState,
    private val signals: SignalRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(
        ChartUiState(
            symbol = saved.get<String>(KEY_SYMBOL)?.takeIf { it in MarketConfig.symbols } ?: Routes.DEFAULT_SYMBOL,
            timeframe = saved.get<String>(KEY_TIMEFRAME)?.takeIf { it in MarketConfig.timeframes } ?: "1h",
        ),
    )
    val state: StateFlow<ChartUiState> = _state.asStateFlow()

    private var loadJob: Job? = null

    init {
        viewModelScope.launch {
            // The symbol is "explicit" when a card or link asked for one (route chart/ETHUSDT) or the user chose one here.
            // The Chart tab uses chart/auto, which follows the defaults from Settings until the user picks something.
            val symbolIsExplicit = saved.get<String>(KEY_SYMBOL) in MarketConfig.symbols
            val userPicked = saved.get<Boolean>(KEY_USER_PICKED) == true
            val p = settings.prefs.first()
            _state.update {
                it.copy(
                    symbol = if (symbolIsExplicit) it.symbol else p.defaultSymbol.takeIf { s -> s in MarketConfig.symbols } ?: it.symbol,
                    timeframe = if (userPicked) it.timeframe else p.defaultTimeframe.takeIf { t -> t in MarketConfig.timeframes } ?: it.timeframe,
                    showPivots = p.showPivots,
                    showVolume = p.showVolume,
                    showEma20 = p.showEma,
                    showEma50 = p.showEma,
                )
            }
            load()
        }
    }

    fun selectSymbol(symbol: String) {
        if (symbol == _state.value.symbol) return
        saved[KEY_USER_PICKED] = true
        saved[KEY_SYMBOL] = symbol
        _state.update { it.copy(symbol = symbol, candles = emptyList(), pivots = null, price = null, changePercent24h = null, signal = null) }
        load()
    }

    fun selectTimeframe(timeframe: String) {
        if (timeframe == _state.value.timeframe) return
        saved[KEY_USER_PICKED] = true
        saved[KEY_TIMEFRAME] = timeframe
        _state.update { it.copy(timeframe = timeframe, candles = emptyList()) }
        load()
    }

    fun retry() = load()

    /** Tells the top app bar which symbol this chart shows (called whenever the chart screen is shown or the symbol changes). */
    fun publishSymbol() = appState.setChartSymbol(_state.value.symbol)

    fun setShowPivots(value: Boolean) = _state.update { it.copy(showPivots = value) }
    fun setShowVolume(value: Boolean) = _state.update { it.copy(showVolume = value) }
    fun setShowEma20(value: Boolean) = _state.update { it.copy(showEma20 = value) }
    fun setShowEma50(value: Boolean) = _state.update { it.copy(showEma50 = value) }

    private fun load() {
        loadJob?.cancel() // also stops the previous live subscription
        val (symbol, timeframe) = _state.value.let { it.symbol to it.timeframe }
        loadJob = viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            coroutineScope {
                val candles = async { market.candles(symbol, timeframe) }
                val pivots = async { market.pivots(symbol) }
                val price = async { market.price(symbol) }
                val running = async { signals.signals(limit = 10, symbol = symbol) }

                when (val result = candles.await()) {
                    is AppResult.Success -> _state.update { it.copy(candles = result.data, loading = false) }
                    is AppResult.Error -> _state.update { it.copy(loading = false, error = result.error) }
                    AppResult.Loading -> Unit
                }
                (pivots.await() as? AppResult.Success)?.let { r -> _state.update { it.copy(pivots = r.data) } }
                (running.await() as? AppResult.Success)?.let { r ->
                    val s = r.data.signals.firstOrNull { it.isActive && it.hasLevels }
                    _state.update { st -> st.copy(signal = s?.let { ChartSignal(it.entry!!, it.sl!!, it.tp1!!, it.tp2!!, it.tp3!!) }) }
                }
                (price.await() as? AppResult.Success)?.let { r ->
                    _state.update { it.copy(price = r.data.price, changePercent24h = r.data.changePercent24h) }
                }
            }
            if (_state.value.error == null) {
                socket.candleUpdates(symbol).collect { applyLive(it) }
            }
        }
    }

    /** Folds a live 1m candle into the last candle of the selected timeframe and updates the price. */
    private fun applyLive(update: Candle) {
        _state.update { st ->
            val list = st.candles
            if (list.isEmpty()) return@update st.copy(price = update.close)
            val tfMs = MarketConfig.timeframeMillis(st.timeframe)
            val last = list.last()
            val bucket = update.time / tfMs * tfMs
            val next = when {
                bucket == last.time -> list.dropLast(1) + last.copy(
                    high = max(last.high, update.high),
                    low = min(last.low, update.low),
                    close = update.close,
                    closed = false,
                )
                bucket > last.time -> list + Candle(bucket, update.open, update.high, update.low, update.close, update.volume, false)
                else -> list
            }
            st.copy(candles = next, price = update.close)
        }
    }

    private companion object {
        const val KEY_SYMBOL = "symbol"
        const val KEY_TIMEFRAME = "timeframe"
        const val KEY_USER_PICKED = "user_picked"
    }
}
