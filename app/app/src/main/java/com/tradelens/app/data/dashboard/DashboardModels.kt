package com.tradelens.app.data.dashboard

import com.squareup.moshi.JsonClass
import com.tradelens.app.data.signals.SignalDto

/** A pivot level: [name] is S3, S2, S1, P, R1, R2 or R3. */
@JsonClass(generateAdapter = true)
data class PivotRef(val name: String, val value: Double)

@JsonClass(generateAdapter = true)
data class DashboardSymbol(
    val symbol: String,
    val price: Double?,
    val change24h: Double?,
    val changePercent24h: Double?,
    /** "Bullish", "Bearish" or "Neutral". */
    val trend: String,
    val pivotAbove: PivotRef?,
    val pivotBelow: PivotRef?,
    val lastSignal: SignalDto?,
    /** Closes of the last 24 closed 1h candles, oldest first. */
    val sparkline: List<Double>,
)

@JsonClass(generateAdapter = true)
data class SignalCounts(val total: Int, val buy: Int, val sell: Int)

@JsonClass(generateAdapter = true)
data class DashboardSignals(val today: SignalCounts, val recent: List<SignalDto>)

@JsonClass(generateAdapter = true)
data class DashboardResponse(
    val generatedAt: Long,
    val symbols: List<DashboardSymbol>,
    val signals: DashboardSignals,
)
