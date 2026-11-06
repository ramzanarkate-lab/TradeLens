package com.tradelens.app

import com.tradelens.app.data.settings.SignalsSettings
import com.tradelens.app.ui.settings.StrategyError
import com.tradelens.app.ui.settings.StrategyField
import com.tradelens.app.ui.settings.StrategyForm
import com.tradelens.app.ui.settings.StrategyValidator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StrategyValidatorTest {
    private val defaults = StrategyForm("20", "50", "14", "40", "65", "75", "60")

    @Test
    fun `default form is valid and becomes the expected settings`() {
        val result = StrategyValidator.validate(defaults, "1h")
        assertTrue(result.valid)
        assertEquals(SignalsSettings(20, 50, 14, 40.0, 65.0, 75.0, 60, "1h"), result.values)
        assertTrue(result.errors.isEmpty())
    }

    @Test
    fun `EMA fast must be less than EMA slow`() {
        for ((fast, slow) in listOf("50" to "50", "60" to "50", "200" to "2")) {
            val result = StrategyValidator.validate(defaults.copy(emaFast = fast, emaSlow = slow), "1h")
            assertNull(result.values)
            assertEquals(StrategyError.FastNotBelowSlow, result.errors[StrategyField.EmaFast])
        }
    }

    @Test
    fun `RSI buy min must be less than buy max`() {
        val result = StrategyValidator.validate(defaults.copy(rsiBuyMin = "65", rsiBuyMax = "65"), "1h")
        assertEquals(StrategyError.BuyMinNotBelowMax, result.errors[StrategyField.RsiBuyMin])
    }

    @Test
    fun `out of range and non numeric values are rejected with the allowed range`() {
        val cases = mapOf(
            StrategyField.EmaFast to defaults.copy(emaFast = "1"),
            StrategyField.EmaSlow to defaults.copy(emaSlow = "201"),
            StrategyField.RsiPeriod to defaults.copy(rsiPeriod = "1"),
            StrategyField.RsiBuyMin to defaults.copy(rsiBuyMin = "0"),
            StrategyField.RsiBuyMax to defaults.copy(rsiBuyMax = "100"),
            StrategyField.RsiSellAbove to defaults.copy(rsiSellAbove = "100"),
            StrategyField.Cooldown to defaults.copy(cooldownMinutes = "10081"),
        )
        for ((field, form) in cases) {
            val error = StrategyValidator.validate(form, "1h").errors[field]
            assertTrue("$field should be rejected", error is StrategyError.OutOfRange)
        }
        val blank = StrategyValidator.validate(defaults.copy(emaFast = "", rsiPeriod = "abc"), "1h")
        assertNotNull(blank.errors[StrategyField.EmaFast])
        assertNotNull(blank.errors[StrategyField.RsiPeriod])
        assertEquals(StrategyError.OutOfRange(2, 200), blank.errors[StrategyField.EmaFast])
    }

    @Test
    fun `boundary values are accepted`() {
        val form = StrategyForm("2", "200", "2", "1", "99", "99", "0")
        assertTrue(StrategyValidator.validate(form, "4h").valid)
        assertTrue(StrategyValidator.validate(form.copy(rsiPeriod = "100", cooldownMinutes = "10080"), "4h").valid)
    }

    @Test
    fun `the timeframe is passed through unchanged`() {
        assertEquals("4h", StrategyValidator.validate(defaults, "4h").values?.timeframe)
    }

    @Test
    fun `form is built from server values`() {
        val form = StrategyForm.from(SignalsSettings(9, 21, 14, 40.0, 65.5, 75.0, 90, "1h"))
        assertEquals(StrategyForm("9", "21", "14", "40", "65.5", "75", "90"), form)
    }
}
