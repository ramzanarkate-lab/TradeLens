package com.tradelens.app

import androidx.compose.ui.graphics.Color
import com.tradelens.app.core.theme.BrandBackground
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.BrandSurface
import com.tradelens.app.core.theme.BuyGreen
import com.tradelens.app.core.theme.SellRed
import com.tradelens.app.core.theme.TextPrimary
import com.tradelens.app.core.theme.TextSecondary
import com.tradelens.app.core.ui.brandWordmark
import com.tradelens.app.data.signals.SignalLock
import com.tradelens.app.data.signals.lockFor
import com.tradelens.app.ui.main.AppGate
import com.tradelens.app.ui.main.gateFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountsAndBrandTest {
    @Test
    fun `a session or the guest choice opens the app, otherwise the login screen`() {
        assertEquals(AppGate.Login, gateFor(signedIn = false, guestChosen = false))
        assertEquals(AppGate.Ready, gateFor(signedIn = true, guestChosen = false))
        assertEquals(AppGate.Ready, gateFor(signedIn = false, guestChosen = true))
        assertEquals(AppGate.Ready, gateFor(signedIn = true, guestChosen = true))
    }

    @Test
    fun `guests are told to sign in, users to upgrade, pro and admin see no lock`() {
        assertEquals(SignalLock.SignIn, lockFor("guest", cap = 5, shown = 5))
        assertEquals(SignalLock.Pro, lockFor("user", cap = 50, shown = 50))
        assertNull(lockFor("pro", cap = 1000, shown = 1000))
        assertNull(lockFor("admin", cap = 1000, shown = 1000))
    }

    @Test
    fun `no lock when nothing is hidden`() {
        // fewer signals than the account's cap means it already sees everything
        assertNull(lockFor("guest", cap = 5, shown = 3))
        assertNull(lockFor("user", cap = 50, shown = 49))
        assertNull(lockFor("guest", cap = 0, shown = 0)) // an older server without a cap
    }

    @Test
    fun `the wordmark reads TradeLens with a capital L, Trade in white and Lens in cyan`() {
        val text = brandWordmark()
        assertEquals("TradeLens", text.text)
        assertEquals(2, text.spanStyles.size)
        val trade = text.spanStyles[0]
        val lens = text.spanStyles[1]
        assertEquals("Trade", text.text.substring(trade.start, trade.end))
        assertEquals(Color(0xFFFFFFFF), trade.item.color)
        assertEquals("Lens", text.text.substring(lens.start, lens.end))
        assertEquals(Color(0xFF00E5FF), lens.item.color)
    }

    @Test
    fun `the brand palette matches the specification`() {
        assertEquals(Color(0xFF050B1F), BrandBackground)
        assertEquals(Color(0xFF0B1630), BrandSurface)
        assertEquals(Color(0xFF00E5FF), BrandCyan)
        assertEquals(Color(0xFF22C55E), BuyGreen)
        assertEquals(Color(0xFFEF4444), SellRed)
        assertEquals(Color(0xFFFFFFFF), TextPrimary)
        assertEquals(Color(0xFF9CA3AF), TextSecondary)
    }
}
