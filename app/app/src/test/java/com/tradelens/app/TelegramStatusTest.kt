package com.tradelens.app

import com.tradelens.app.data.settings.SECRET_KEYS
import com.tradelens.app.data.settings.TelegramStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TelegramStatusTest {
    @Test
    fun `the channel is active only when posting is on and it is configured`() {
        assertTrue(TelegramStatus(enabled = true, configured = true).active)
        assertFalse(TelegramStatus(enabled = true, configured = false).active)
        assertFalse(TelegramStatus(enabled = false, configured = true).active)
        assertFalse(TelegramStatus().active)
    }

    @Test
    fun `non-admin status has no post numbers`() {
        val basic = TelegramStatus(enabled = true, configured = true, channelLink = "https://t.me/x")
        assertEquals(null, basic.postsLast24h)
        assertEquals(null, basic.failedPosts)
    }

    @Test
    fun `telegram values have their own admin block, not the generic secret list`() {
        assertFalse(SECRET_KEYS.any { it.startsWith("TELEGRAM") })
    }
}
