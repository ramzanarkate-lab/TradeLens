package com.tradelens.app.ui.chart

import java.util.Locale

/**
 * Exponential moving average of [values] (display only). The first [period]-1 entries are NaN;
 * the EMA is seeded with the simple average of the first [period] values.
 */
fun ema(values: List<Double>, period: Int): List<Double> {
    val out = MutableList(values.size) { Double.NaN }
    if (period <= 0 || values.size < period) return out
    val k = 2.0 / (period + 1)
    var prev = values.take(period).average()
    out[period - 1] = prev
    for (i in period until values.size) {
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    }
    return out
}

fun formatPrice(value: Double, decimals: Int): String = String.format(Locale.US, "%.${decimals}f", value)
