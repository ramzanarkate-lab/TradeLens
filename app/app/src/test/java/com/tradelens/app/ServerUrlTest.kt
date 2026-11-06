package com.tradelens.app

import com.tradelens.app.data.settings.ServerUrlProblem
import com.tradelens.app.data.settings.serverUrlProblem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    @Test
    fun `a good URL or an empty one has no problem`() {
        assertNull(serverUrlProblem("http://10.0.2.2:4000"))
        assertNull(serverUrlProblem("https://example.com"))
        assertNull(serverUrlProblem(""))
    }

    @Test
    fun `the URL must start with http or https`() {
        assertEquals(ServerUrlProblem.MissingScheme, serverUrlProblem("10.0.2.2:4000"))
        assertEquals(ServerUrlProblem.MissingScheme, serverUrlProblem("ftp://example.com"))
    }

    @Test
    fun `the URL must not end with a slash`() {
        assertEquals(ServerUrlProblem.TrailingSlash, serverUrlProblem("http://10.0.2.2:4000/"))
    }

    @Test
    fun `a broken URL is invalid`() {
        assertEquals(ServerUrlProblem.Invalid, serverUrlProblem("http://bad host"))
    }
}
