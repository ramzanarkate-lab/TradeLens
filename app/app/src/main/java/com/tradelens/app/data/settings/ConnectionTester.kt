package com.tradelens.app.data.settings

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/** True for an http(s) URL such as http://10.0.2.2:4000. */
fun isValidServerUrl(url: String): Boolean {
    val parsed = url.trim().trimEnd('/').toHttpUrlOrNull() ?: return false
    return parsed.scheme == "http" || parsed.scheme == "https"
}

enum class ServerUrlProblem { MissingScheme, TrailingSlash, Invalid }

/** What is wrong with the URL as typed, or null if it is fine (or empty: empty means "use the built-in address"). */
fun serverUrlProblem(raw: String): ServerUrlProblem? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    if (!text.startsWith("http://") && !text.startsWith("https://")) return ServerUrlProblem.MissingScheme
    if (text.endsWith("/")) return ServerUrlProblem.TrailingSlash
    return if (text.toHttpUrlOrNull() == null) ServerUrlProblem.Invalid else null
}

sealed interface ConnectionResult {
    /** `live` and `provider` come from /health; they are null when talking to an older server. */
    data class Ok(val millis: Long, val live: Boolean? = null, val provider: String? = null) : ConnectionResult
    data class Failed(val reason: String) : ConnectionResult
    data object InvalidUrl : ConnectionResult
}

/** Calls GET /health on the URL as typed (not the saved one), so a new URL can be tried before saving it. */
@Singleton
class ConnectionTester @Inject constructor(client: OkHttpClient) {
    // The app's client rewrites every request to the saved server URL; this one must not.
    private val plain = client.newBuilder().apply { interceptors().clear() }.callTimeout(8, TimeUnit.SECONDS).build()

    suspend fun test(url: String): ConnectionResult {
        val base = url.trim().trimEnd('/').toHttpUrlOrNull()
        if (base == null || (base.scheme != "http" && base.scheme != "https")) return ConnectionResult.InvalidUrl
        return withContext(Dispatchers.IO) {
            val start = System.nanoTime()
            try {
                plain.newCall(Request.Builder().url(base.newBuilder().addPathSegment("health").build()).build()).execute().use { response ->
                    if (response.isSuccessful) {
                        val millis = (System.nanoTime() - start) / 1_000_000
                        val body = response.body?.string().orEmpty()
                        ConnectionResult.Ok(
                            millis,
                            live = Regex("\"live\"\\s*:\\s*(true|false)").find(body)?.groupValues?.get(1)?.toBoolean(),
                            provider = Regex("\"activeProvider\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1),
                        )
                    } else {
                        ConnectionResult.Failed("HTTP ${response.code}")
                    }
                }
            } catch (e: Exception) {
                ConnectionResult.Failed(e.message ?: e.javaClass.simpleName)
            }
        }
    }
}
