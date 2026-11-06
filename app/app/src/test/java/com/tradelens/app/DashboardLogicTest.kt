package com.tradelens.app

import com.tradelens.app.data.dashboard.DashboardResponse
import com.tradelens.app.data.dashboard.DashboardSignals
import com.tradelens.app.data.dashboard.DashboardSymbol
import com.tradelens.app.data.dashboard.PivotRef
import com.tradelens.app.data.dashboard.SignalCounts
import com.tradelens.app.data.dashboard.crossedPivot
import com.tradelens.app.data.dashboard.referencePrice
import com.tradelens.app.data.dashboard.startOfUtcDay
import com.tradelens.app.data.dashboard.withCandle
import com.tradelens.app.data.dashboard.withSignal
import com.tradelens.app.data.market.Candle
import com.tradelens.app.data.market.LiveEvent
import com.tradelens.app.data.market.LiveMessages
import com.tradelens.app.data.signals.SignalDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardLogicTest {
    private val now = 1_793_966_400_000L // 2026-11-06 12:00 UTC
    private val dayStart = startOfUtcDay(now)

    private fun card(symbol: String, price: Double, pct: Double = 0.0, last: SignalDto? = null) = DashboardSymbol(
        symbol, price, 0.0, pct, "Neutral", PivotRef("R1", 110.0), PivotRef("P", 100.0), last, listOf(1.0, 2.0, 3.0),
    )

    private fun signal(id: String, symbol: String, side: String, at: Long) = SignalDto(id, symbol, side, "1h", 100.0, null, "r", at)

    private fun data(vararg cards: DashboardSymbol, recent: List<SignalDto> = emptyList(), today: SignalCounts = SignalCounts(0, 0, 0)) =
        DashboardResponse(now, cards.toList(), DashboardSignals(today, recent))

    private fun candle(close: Double) = Candle(0, close, close, close, close, 1.0, false)

    @Test
    fun `start of UTC day`() {
        assertEquals(1_793_923_200_000L, dayStart)
        assertEquals(0L, startOfUtcDay(86_399_999L))
        assertEquals(86_400_000L, startOfUtcDay(86_400_000L))
    }

    @Test
    fun `a live candle updates only the matching card`() {
        val reference = referencePrice(105.0, 5.0) // 24h ago: 100
        assertEquals(100.0, reference!!, 1e-9)
        val before = data(card("BTCUSDT", 105.0, 5.0), card("SOLUSDT", 50.0, 1.0))
        val after = before.withCandle("BTCUSDT", candle(110.0), reference)

        val btc = after.symbols[0]
        assertEquals(110.0, btc.price!!, 1e-9)
        assertEquals(10.0, btc.changePercent24h!!, 1e-9)
        assertEquals(10.0, btc.change24h!!, 1e-9)
        assertEquals(listOf(1.0, 2.0, 110.0), btc.sparkline) // only the last point moves
        assertEquals(before.symbols[1], after.symbols[1]) // SOL untouched
    }

    @Test
    fun `without a reference price the 24h change is kept`() {
        val after = data(card("BTCUSDT", 105.0, 5.0)).withCandle("BTCUSDT", candle(120.0), null)
        assertEquals(5.0, after.symbols[0].changePercent24h!!, 1e-9)
        assertEquals(120.0, after.symbols[0].price!!, 1e-9)
    }

    @Test
    fun `reference price handles missing values`() {
        assertNull(referencePrice(null, 1.0))
        assertNull(referencePrice(100.0, null))
        assertNull(referencePrice(100.0, -100.0))
    }

    @Test
    fun `crossing the nearest pivots is detected`() {
        val c = card("BTCUSDT", 105.0)
        assertFalse(c.crossedPivot(105.0))
        assertFalse(c.crossedPivot(110.0)) // on the level: not past it
        assertTrue(c.crossedPivot(110.01))
        assertTrue(c.crossedPivot(99.99))
        assertFalse(c.copy(pivotAbove = null, pivotBelow = null).crossedPivot(1e9))
    }

    @Test
    fun `a live signal updates its card, the recent list and today's counts`() {
        val old = signal("old", "BTCUSDT", "BUY", dayStart + 1_000)
        val before = data(card("BTCUSDT", 100.0, last = old), card("ETHUSDT", 2000.0), recent = listOf(old), today = SignalCounts(1, 1, 0))

        val sell = signal("new", "BTCUSDT", "SELL", dayStart + 5_000)
        val after = before.withSignal(sell, now)

        assertEquals(sell, after.symbols[0].lastSignal)
        assertNull(after.symbols[1].lastSignal)
        assertEquals(listOf("new", "old"), after.signals.recent.map { it.id })
        assertEquals(SignalCounts(2, 1, 1), after.signals.today)
    }

    @Test
    fun `the same signal arriving twice is not counted twice`() {
        val s = signal("a", "SOLUSDT", "BUY", dayStart + 10)
        val once = data(card("SOLUSDT", 1.0)).withSignal(s, now)
        val twice = once.withSignal(s, now)
        assertEquals(SignalCounts(1, 1, 0), twice.signals.today)
        assertEquals(1, twice.signals.recent.size)
    }

    @Test
    fun `recent keeps the newest 5 and yesterday's signal is not counted today`() {
        var d = data(card("BTCUSDT", 1.0))
        for (i in 1..7) d = d.withSignal(signal("s$i", "BTCUSDT", "BUY", dayStart + i * 1_000L), now)
        assertEquals(listOf("s7", "s6", "s5", "s4", "s3"), d.signals.recent.map { it.id })
        assertEquals(7, d.signals.today.total)

        val yesterday = d.withSignal(signal("y", "BTCUSDT", "SELL", dayStart - 1), now)
        assertEquals(7, yesterday.signals.today.total) // not today
        assertEquals("s7", yesterday.symbols[0].lastSignal?.id) // and not newer than the card's last signal
    }

    @Test
    fun `live messages parse candles and signals and ignore the rest`() {
        val candle = """{"type":"message","topic":"candles:BTCUSDT","data":{"symbol":"BTCUSDT","interval":"1m","candle":{"time":1000,"open":1.5,"high":2.0,"low":1.0,"close":1.75,"volume":3.0,"closed":false}}}"""
        assertEquals(
            LiveEvent.CandleUpdate("BTCUSDT", Candle(1000, 1.5, 2.0, 1.0, 1.75, 3.0, false)),
            LiveMessages.parse(candle),
        )

        val sig = """{"type":"message","topic":"signals","data":{"event":"signal","signal":{"id":"abc","symbol":"ETHUSDT","side":"SELL","timeframe":"1h","price":2245.5,"trigger":"r2_reached","reason":"because","createdAt":1234,"levels":{"S1":1,"R2":2,"pivots":{}},"indicators":{"emaFast":1,"emaSlow":2,"rsi":3}}}}"""
        assertEquals(
            LiveEvent.SignalEvent(SignalDto("abc", "ETHUSDT", "SELL", "1h", 2245.5, "r2_reached", "because", 1234)),
            LiveMessages.parse(sig),
        )

        assertNull(LiveMessages.parse("""{"type":"subscribed","topic":"signals"}"""))
        assertNull(LiveMessages.parse("""{"type":"error","code":"INVALID_MESSAGE"}"""))
        assertNull(LiveMessages.parse("""{"type":"message","topic":"settings","data":{"event":"changed"}}"""))
        assertNull(LiveMessages.parse("""{"type":"message","topic":"signals","data":{"event":"other","signal":null}}"""))
        assertNull(LiveMessages.parse("not json"))
    }
}
