package com.tradelens.app

import com.tradelens.app.core.alerts.SignalNotificationText
import com.tradelens.app.data.signals.SignalDto
import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationTextTest {
    private fun signal(side: String, symbol: String, price: Double, reason: String? = "Because.", test: Boolean = false) =
        SignalDto("id", symbol, side, "1h", price, "ema_cross_up", reason, 0, test)

    @Test
    fun `BUY title and text`() {
        val text = SignalNotificationText.of(
            signal("BUY", "BTCUSDT", 67_420.0, "EMA 20 crossed above EMA 50 on the closed 1h candle."),
        )
        assertEquals("BUY BTCUSDT at 67,420", text.title)
        assertEquals("EMA 20 crossed above EMA 50 on the closed 1h candle.", text.body)
    }

    @Test
    fun `SELL title and text`() {
        val text = SignalNotificationText.of(signal("SELL", "ETHUSDT", 3_200.5, "Price reached resistance R2."))
        assertEquals("SELL ETHUSDT at 3,200.5", text.title)
        assertEquals("Price reached resistance R2.", text.body)
    }

    @Test
    fun `prices use thousands separators and the symbol's decimals`() {
        assertEquals("67,420.55", SignalNotificationText.formatPrice("BTCUSDT", 67_420.55))
        assertEquals("67,420.56", SignalNotificationText.formatPrice("BTCUSDT", 67_420.556)) // at most 2 decimals, rounded
        assertEquals("150.123", SignalNotificationText.formatPrice("SOLUSDT", 150.123)) // SOL keeps 3
        assertEquals("150", SignalNotificationText.formatPrice("SOLUSDT", 150.0))
        assertEquals("1,234,567", SignalNotificationText.formatPrice("BTCUSDT", 1_234_567.0))
        assertEquals("0.5", SignalNotificationText.formatPrice("BTCUSDT", 0.5))
    }

    @Test
    fun `a test signal is marked in the title`() {
        val text = SignalNotificationText.of(signal("BUY", "BTCUSDT", 67_420.0, "Test alert: sample.", test = true))
        assertEquals("Test: BUY BTCUSDT at 67,420", text.title)
        assertEquals("Test alert: sample.", text.body)
    }

    @Test
    fun `a missing or blank reason falls back to a short description`() {
        assertEquals("1h signal from the ema_cross_up", SignalNotificationText.of(signal("BUY", "BTCUSDT", 1.0, reason = null)).body)
        assertEquals("1h signal from the ema_cross_up", SignalNotificationText.of(signal("BUY", "BTCUSDT", 1.0, reason = "  ")).body)
    }
}
