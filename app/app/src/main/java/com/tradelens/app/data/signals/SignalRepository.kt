package com.tradelens.app.data.signals

import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.TradeLensApi
import com.tradelens.app.core.network.safeApiCall
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SignalRepository @Inject constructor(private val api: TradeLensApi) {
    /** Newest first. */
    suspend fun signals(
        limit: Int = 50,
        symbol: String? = null,
        offset: Int = 0,
        filters: SignalFilters = SignalFilters(),
    ): AppResult<SignalsPage> = safeApiCall {
        val from = filters.range.millis?.let { System.currentTimeMillis() - it }
        api.signals(
            limit = limit,
            symbol = symbol ?: filters.symbol,
            offset = offset,
            side = filters.side,
            status = filters.status,
            from = from,
        ).let { SignalsPage(it.signals, it.cap, it.role, it.total, it.hasMore, it.locked) }
    }

    suspend fun signal(id: String): AppResult<SignalDto> = safeApiCall { api.signal(id) }

    suspend fun stats(filters: SignalFilters = SignalFilters()): AppResult<SignalStatsDto> = safeApiCall {
        val from = filters.range.millis?.let { System.currentTimeMillis() - it }
        api.signalStats(symbol = filters.symbol, from = from)
    }
}
