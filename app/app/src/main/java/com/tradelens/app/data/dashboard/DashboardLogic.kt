package com.tradelens.app.data.dashboard

import com.tradelens.app.data.market.Candle
import com.tradelens.app.data.signals.SignalDto

private const val DAY_MS = 86_400_000L

/** 00:00 UTC of the day containing [ms]. The server counts "today" the same way. */
fun startOfUtcDay(ms: Long): Long = ms - Math.floorMod(ms, DAY_MS)

/** The price 24h ago implied by a price and its 24h change in percent, so live prices can update the change. */
fun referencePrice(price: Double?, changePercent: Double?): Double? {
    if (price == null || changePercent == null) return null
    val factor = 1 + changePercent / 100
    return if (factor == 0.0) null else price / factor
}

/**
 * Folds a live 1m candle into the matching card: price, 24h change (against the reference price from the last load)
 * and the sparkline's last point. Other cards and everything else are untouched.
 */
fun DashboardResponse.withCandle(symbol: String, candle: Candle, reference: Double?): DashboardResponse =
    copy(symbols = symbols.map { card ->
        if (card.symbol != symbol) return@map card
        val price = candle.close
        card.copy(
            price = price,
            change24h = reference?.let { price - it } ?: card.change24h,
            changePercent24h = reference?.let { (price / it - 1) * 100 } ?: card.changePercent24h,
            sparkline = if (card.sparkline.isEmpty()) listOf(price) else card.sparkline.dropLast(1) + price,
        )
    })

/** True when [price] has moved past the nearest pivot above or below, i.e. the card's support/resistance is stale. */
fun DashboardSymbol.crossedPivot(price: Double): Boolean =
    (pivotAbove != null && price > pivotAbove.value) || (pivotBelow != null && price < pivotBelow.value)

/**
 * Folds a live signal into the matching card, the recent list (newest first, max 5) and today's counts.
 * A signal already in the recent list is not counted twice.
 */
fun DashboardResponse.withSignal(signal: SignalDto, nowMs: Long): DashboardResponse {
    val alreadyKnown = signals.recent.any { it.id == signal.id }
    val recent = (listOf(signal) + signals.recent.filter { it.id != signal.id }).sortedByDescending { it.createdAt }.take(5)
    val countsToday = !alreadyKnown && signal.createdAt >= startOfUtcDay(nowMs)
    val today = signals.today
    return copy(
        symbols = symbols.map { card ->
            if (card.symbol == signal.symbol && signal.createdAt >= (card.lastSignal?.createdAt ?: Long.MIN_VALUE)) card.copy(lastSignal = signal) else card
        },
        signals = DashboardSignals(
            today = if (countsToday) {
                SignalCounts(today.total + 1, today.buy + if (signal.side == "BUY") 1 else 0, today.sell + if (signal.side == "SELL") 1 else 0)
            } else {
                today
            },
            recent = recent,
        ),
    )
}
