package com.tradelens.app

import com.tradelens.app.ui.settings.googleIdOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class GoogleSignInOptionTest {
    @Test
    fun `sign-in asks Credential Manager for a token for the Web client id, for any account`() {
        val option = googleIdOption(BuildConfig.GOOGLE_WEB_CLIENT_ID)
        assertEquals(BuildConfig.GOOGLE_WEB_CLIENT_ID, option.serverClientId)
        assertFalse(option.filterByAuthorizedAccounts)
    }

    @Test
    fun `the Web client id is built in`() {
        assert(BuildConfig.GOOGLE_WEB_CLIENT_ID.endsWith(".apps.googleusercontent.com"))
    }
}
