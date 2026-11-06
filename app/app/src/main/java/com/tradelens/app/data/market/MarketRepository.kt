package com.tradelens.app.data.market

import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.HealthResponse
import com.tradelens.app.core.network.TradeLensApi
import com.tradelens.app.core.network.safeApiCall
import com.tradelens.app.data.dashboard.DashboardResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MarketRepository @Inject constructor(private val api: TradeLensApi) {
    suspend fun checkHealth(): AppResult<HealthResponse> = safeApiCall { api.health() }

    suspend fun candles(symbol: String, interval: String, limit: Int = 300): AppResult<List<Candle>> =
        safeApiCall { api.candles(symbol, interval, limit).candles }

    suspend fun price(symbol: String): AppResult<PriceResponse> = safeApiCall { api.price(symbol) }

    suspend fun dashboard(): AppResult<DashboardResponse> = safeApiCall { api.dashboard() }

    suspend fun pivots(symbol: String): AppResult<Pivots> = safeApiCall { api.pivots(symbol) }
}
