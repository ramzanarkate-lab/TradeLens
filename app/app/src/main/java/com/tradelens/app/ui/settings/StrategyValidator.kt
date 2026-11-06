package com.tradelens.app.ui.settings

import com.tradelens.app.data.settings.SignalsSettings

/** The strategy form as typed: raw text per field. */
data class StrategyForm(
    val emaFast: String = "",
    val emaSlow: String = "",
    val rsiPeriod: String = "",
    val rsiBuyMin: String = "",
    val rsiBuyMax: String = "",
    val rsiSellAbove: String = "",
    val cooldownMinutes: String = "",
) {
    companion object {
        fun from(s: SignalsSettings) = StrategyForm(
            emaFast = s.emaFast.toString(),
            emaSlow = s.emaSlow.toString(),
            rsiPeriod = s.rsiPeriod.toString(),
            rsiBuyMin = num(s.rsiBuyMin),
            rsiBuyMax = num(s.rsiBuyMax),
            rsiSellAbove = num(s.rsiSellAbove),
            cooldownMinutes = s.cooldownMinutes.toString(),
        )

        private fun num(v: Double) = if (v % 1.0 == 0.0) v.toInt().toString() else v.toString()
    }
}

enum class StrategyField { EmaFast, EmaSlow, RsiPeriod, RsiBuyMin, RsiBuyMax, RsiSellAbove, Cooldown }

sealed interface StrategyError {
    /** Not a whole number, or outside [min, max]. */
    data class OutOfRange(val min: Int, val max: Int) : StrategyError
    data object FastNotBelowSlow : StrategyError
    data object BuyMinNotBelowMax : StrategyError
}

data class StrategyValidation(val values: SignalsSettings?, val errors: Map<StrategyField, StrategyError>) {
    val valid get() = values != null
}

/** Same rules as the server (server/src/settings/schema.ts), so mistakes are caught before sending. */
object StrategyValidator {
    const val EMA_MIN = 2
    const val EMA_MAX = 200
    const val RSI_PERIOD_MIN = 2
    const val RSI_PERIOD_MAX = 100
    const val RSI_MIN = 1
    const val RSI_MAX = 99
    const val COOLDOWN_MIN = 0
    const val COOLDOWN_MAX = 10_080

    fun validate(form: StrategyForm, timeframe: String): StrategyValidation {
        val errors = linkedMapOf<StrategyField, StrategyError>()

        fun int(text: String, field: StrategyField, min: Int, max: Int): Int? {
            val v = text.trim().toIntOrNull()
            if (v == null || v < min || v > max) {
                errors[field] = StrategyError.OutOfRange(min, max)
                return null
            }
            return v
        }

        val fast = int(form.emaFast, StrategyField.EmaFast, EMA_MIN, EMA_MAX)
        val slow = int(form.emaSlow, StrategyField.EmaSlow, EMA_MIN, EMA_MAX)
        val period = int(form.rsiPeriod, StrategyField.RsiPeriod, RSI_PERIOD_MIN, RSI_PERIOD_MAX)
        val buyMin = int(form.rsiBuyMin, StrategyField.RsiBuyMin, RSI_MIN, RSI_MAX)
        val buyMax = int(form.rsiBuyMax, StrategyField.RsiBuyMax, RSI_MIN, RSI_MAX)
        val sell = int(form.rsiSellAbove, StrategyField.RsiSellAbove, RSI_MIN, RSI_MAX)
        val cooldown = int(form.cooldownMinutes, StrategyField.Cooldown, COOLDOWN_MIN, COOLDOWN_MAX)

        if (fast != null && slow != null && fast >= slow) errors[StrategyField.EmaFast] = StrategyError.FastNotBelowSlow
        if (buyMin != null && buyMax != null && buyMin >= buyMax) errors[StrategyField.RsiBuyMin] = StrategyError.BuyMinNotBelowMax

        if (errors.isNotEmpty()) return StrategyValidation(null, errors)
        return StrategyValidation(
            SignalsSettings(fast!!, slow!!, period!!, buyMin!!.toDouble(), buyMax!!.toDouble(), sell!!.toDouble(), cooldown!!, timeframe),
            emptyMap(),
        )
    }
}
