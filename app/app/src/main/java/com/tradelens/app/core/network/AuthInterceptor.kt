package com.tradelens.app.core.network

import com.tradelens.app.state.AppState
import dagger.Lazy
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/** Adds "Authorization: Bearer <session token>" to API calls when the user is signed in. */
@Singleton
class AuthInterceptor @Inject constructor(private val appState: Lazy<AppState>) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = appState.get().authToken.value ?: return chain.proceed(chain.request())
        return chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer $token").build())
    }
}
