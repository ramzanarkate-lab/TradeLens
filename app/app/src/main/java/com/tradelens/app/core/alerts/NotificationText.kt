package com.tradelens.app.core.alerts

import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.StatusChangeDto
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

data class NotificationText(val title: String, val body: String)

/** Builds what a signal notification says. Pure, so it can be unit tested. */
object SignalNotificationText {

    /** 67420.0 -> "67,420"; 67420.5 -> "67,420.5"; at most the symbol's tick decimals. Always US-style separators. */
    fun formatPrice(symbol: String, price: Double): String {
        val decimals = MarketConfig.decimals(symbol)
        val pattern = "#,##0" + if (decimals > 0) "." + "#".repeat(decimals) else ""
        return DecimalFormat(pattern, DecimalFormatSymbols(Locale.US)).format(price)
    }

    /** "+1.0R", "-1.0R", "+0.0R". */
    fun formatR(r: Double): String = String.format(Locale.US, "%+.1fR", r)

    /** Entry, stop and targets on one line, for signals that have them; null for older signals. */
    fun levels(signal: SignalDto): String? {
        if (!signal.hasLevels) return null
        fun p(v: Double?) = formatPrice(signal.symbol, v ?: 0.0)
        return "Entry ${p(signal.entry)} · SL ${p(signal.sl)} · TP1 ${p(signal.tp1)} · TP2 ${p(signal.tp2)} · TP3 ${p(signal.tp3)}"
    }

    /** Title "BUY BTCUSDT at 67,420"; text is the levels and score, or the plain-English reason for older signals. Test signals are marked "Test:". */
    fun of(signal: SignalDto): NotificationText {
        val title = "${signal.side} ${signal.symbol} at ${formatPrice(signal.symbol, signal.entry ?: signal.price)}"
        val levels = levels(signal)
        val body = when {
            levels != null -> levels + (signal.score?.let { " · Score $it" } ?: "")
            else -> signal.reason?.takeIf { it.isNotBlank() } ?: "${signal.timeframe} signal from the ${signal.trigger ?: "strategy"}"
        }
        return NotificationText(if (signal.test) "Test: $title" else title, body)
    }

    /** The words for a status: "hit TP1", "hit SL", "exited at breakeven", "closed on time". */
    fun statusPhrase(status: String): String = when (status) {
        "TP1_HIT" -> "hit TP1"
        "TP2_HIT" -> "hit TP2"
        "TP3_HIT" -> "hit TP3"
        "SL_HIT" -> "hit SL"
        "BREAKEVEN_EXIT" -> "exited at breakeven"
        "TIME_EXIT" -> "closed on time"
        else -> "changed to $status"
    }

    /** "BTCUSDT BUY hit TP1 (+1.0R)". */
    fun update(signal: SignalDto, change: StatusChangeDto): NotificationText {
        val r = change.resultR?.let { " (${formatR(it)})" }.orEmpty()
        val body = levels(signal) ?: "Price ${formatPrice(signal.symbol, change.price)}"
        return NotificationText("${signal.symbol} ${signal.side} ${statusPhrase(change.status)}$r", body)
    }
}
