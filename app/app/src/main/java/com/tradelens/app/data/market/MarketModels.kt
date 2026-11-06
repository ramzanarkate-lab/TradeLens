package com.tradelens.app.data.market

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/** One OHLCV candle. [time] is the open time in epoch milliseconds. */
@JsonClass(generateAdapter = true)
data class Candle(
    val time: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
    val closed: Boolean,
)

@JsonClass(generateAdapter = true)
data class CandlesResponse(
    val symbol: String,
    val interval: String,
    val source: String,
    val candles: List<Candle>,
)

@JsonClass(generateAdapter = true)
data class PriceResponse(
    val symbol: String,
    val price: Double,
    val change24h: Double?,
    val changePercent24h: Double?,
    val source: String,
)

/** Classic daily pivot levels. JSON keys are upper case (P, R1, ...). */
@JsonClass(generateAdapter = true)
data class Pivots(
    val symbol: String,
    val basis: String,
    val date: String,
    @Json(name = "P") val p: Double,
    @Json(name = "R1") val r1: Double,
    @Json(name = "R2") val r2: Double,
    @Json(name = "R3") val r3: Double,
    @Json(name = "S1") val s1: Double,
    @Json(name = "S2") val s2: Double,
    @Json(name = "S3") val s3: Double,
)

/** Symbols and timeframes the server serves (mirrors GET /api/meta). */
object MarketConfig {
    val symbols = listOf("BTCUSDT", "SOLUSDT", "ETHUSDT")
    val timeframes = listOf("15m", "1h", "4h", "1d")

    /** Price decimals per symbol, matching the server's tick size rounding. */
    fun decimals(symbol: String): Int = if (symbol == "SOLUSDT") 3 else 2

    fun timeframeMillis(timeframe: String): Long = when (timeframe) {
        "15m" -> 15 * 60_000L
        "1h" -> 60 * 60_000L
        "4h" -> 4 * 60 * 60_000L
        else -> 24 * 60 * 60_000L
    }
}
