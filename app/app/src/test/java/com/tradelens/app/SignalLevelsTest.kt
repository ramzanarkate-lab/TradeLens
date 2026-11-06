package com.tradelens.app

import com.tradelens.app.core.alerts.SignalNotificationText
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.LiveMessages
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.StatusChangeDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignalLevelsTest {
    private val full = SignalDto(
        id = "a", symbol = "BTCUSDT", side = "BUY", timeframe = "1h", price = 67420.0, createdAt = 1L,
        score = 82, entry = 67420.0, sl = 66900.0, tp1 = 67940.0, tp2 = 68460.0, tp3 = 68980.0,
        reasons = listOf("one", "two", "three", "four"), status = "OPEN",
    )

    @Test
    fun `a status change reads like BTCUSDT BUY hit TP1 (+1_0R)`() {
        val text = SignalNotificationText.update(full, StatusChangeDto("TP1_HIT", 2L, 67940.0, 1.0))
        assertEquals("BTCUSDT BUY hit TP1 (+1.0R)", text.title)
        assertEquals("BTCUSDT BUY hit SL (-1.0R)", SignalNotificationText.update(full, StatusChangeDto("SL_HIT", 2L, 66900.0, -1.0)).title)
        assertEquals("BTCUSDT BUY exited at breakeven (+0.0R)", SignalNotificationText.update(full, StatusChangeDto("BREAKEVEN_EXIT", 2L, 67420.0, 0.0)).title)
    }

    @Test
    fun `a new signal notification shows the levels and the score`() {
        val text = SignalNotificationText.of(full)
        assertEquals("BUY BTCUSDT at 67,420", text.title)
        assertTrue(text.body.contains("Entry 67,420"))
        assertTrue(text.body.contains("SL 66,900"))
        assertTrue(text.body.contains("TP1 67,940"))
        assertTrue(text.body.contains("TP3 68,980"))
        assertTrue(text.body.contains("Score 82"))
    }

    @Test
    fun `an older signal without levels still shows its reason`() {
        val old = SignalDto(id = "b", symbol = "SOLUSDT", side = "SELL", timeframe = "1h", price = 150.0, reason = "EMA crossed down", createdAt = 1L)
        assertFalse(old.hasLevels)
        assertEquals("EMA crossed down", SignalNotificationText.of(old).body)
    }

    @Test
    fun `status helpers`() {
        assertTrue(full.isActive)
        assertFalse(full.copy(status = "SL_HIT").isActive)
        assertTrue(full.copy(status = "TP2_HIT").isActive)
        assertEquals("+0.4R", SignalNotificationText.formatR(0.43))
    }

    @Test
    fun `the server signalUpdate message is parsed with its change`() {
        val json = """{"type":"message","topic":"signals","data":{"event":"signalUpdate",
            "signal":{"id":"a","symbol":"BTCUSDT","side":"BUY","timeframe":"1h","price":100.0,"createdAt":1,"entry":100.0,"sl":98.0,"tp1":102.0,"tp2":104.0,"tp3":106.0,"status":"TP1_HIT"},
            "change":{"status":"TP1_HIT","at":5,"price":102.0,"resultR":1.0}}}"""
        val event = LiveMessages.parse(json)
        assertNotNull(event)
        event as LiveEvent.SignalUpdate
        assertEquals("TP1_HIT", event.change.status)
        assertEquals(1.0, event.change.resultR!!, 0.0)
        assertTrue(event.signal.hasLevels)
    }

    @Test
    fun `a plain signal message still parses and unknown events are ignored`() {
        val signal = """{"id":"a","symbol":"BTCUSDT","side":"BUY","timeframe":"1h","price":100.0,"createdAt":1}"""
        assertTrue(LiveMessages.parse("""{"type":"message","topic":"signals","data":{"event":"signal","signal":$signal}}""") is LiveEvent.SignalEvent)
        assertEquals(null, LiveMessages.parse("""{"type":"message","topic":"signals","data":{"event":"other","signal":$signal}}"""))
    }
}
