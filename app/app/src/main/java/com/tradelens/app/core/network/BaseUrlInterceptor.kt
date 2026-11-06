package com.tradelens.app.core.network

import com.tradelens.app.state.AppState
import dagger.Lazy
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rewrites each request's scheme/host/port to the server URL currently held in [AppState],
 * so the base URL follows Settings without rebuilding Retrofit.
 */
@Singleton
class BaseUrlInterceptor @Inject constructor(private val appState: Lazy<AppState>) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val base = appState.get().serverUrl.value.toHttpUrlOrNull() ?: return chain.proceed(request)
        val url = request.url.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()
        return chain.proceed(request.newBuilder().url(url).build())
    }
}
