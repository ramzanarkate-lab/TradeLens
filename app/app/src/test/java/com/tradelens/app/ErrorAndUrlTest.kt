package com.tradelens.app

import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.serverMessage
import com.tradelens.app.data.settings.isValidServerUrl
import com.tradelens.app.ui.chart.ema
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorAndUrlTest {
    @Test
    fun `server error message is read from the error envelope`() {
        val body = """{"error":{"code":"VALIDATION_ERROR","message":"signals.emaFast: emaFast must be less than emaSlow"}}"""
        assertEquals("signals.emaFast: emaFast must be less than emaSlow", AppError.Http(400, body).serverMessage())
    }

    @Test
    fun `missing or malformed error bodies give null`() {
        assertNull(AppError.Http(500, null).serverMessage())
        assertNull(AppError.Http(500, "<html>Bad gateway</html>").serverMessage())
        assertNull(AppError.Http(500, """{"error":{}}""").serverMessage())
    }

    @Test
    fun `server URL validation accepts only http and https URLs`() {
        assertTrue(isValidServerUrl("http://10.0.2.2:4000"))
        assertTrue(isValidServerUrl("https://api.example.com/"))
        assertTrue(isValidServerUrl("  http://192.168.1.20:4000  "))
        assertFalse(isValidServerUrl(""))
        assertFalse(isValidServerUrl("10.0.2.2:4000"))
        assertFalse(isValidServerUrl("ftp://example.com"))
        assertFalse(isValidServerUrl("not a url"))
    }

    @Test
    fun `ema matches the server's fixed-data results`() {
        // same expectation as server/tests/indicators.test.ts: seed (1+2+3)/3 = 2, then 3, then 4
        val out = ema(listOf(1.0, 2.0, 3.0, 4.0, 5.0), 3)
        assertTrue(out[0].isNaN() && out[1].isNaN())
        assertEquals(listOf(2.0, 3.0, 4.0), out.drop(2))
    }
}
