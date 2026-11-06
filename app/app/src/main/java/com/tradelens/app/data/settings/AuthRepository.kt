package com.tradelens.app.data.settings

import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.TradeLensApi
import com.tradelens.app.core.network.safeApiCall
import com.tradelens.app.state.AppState
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val api: TradeLensApi,
    private val settings: SettingsRepository,
    private val appState: AppState,
) {
    suspend fun signInWithGoogle(idToken: String): AppResult<Session> =
        safeApiCall { api.googleLogin(GoogleLoginRequest(idToken)) }.thenSave()

    /** Debug builds only (the UI hides it otherwise); the server must have ENABLE_DEV_LOGIN on. */
    suspend fun devLogin(userId: String): AppResult<Session> =
        safeApiCall { api.devLogin(DevLoginRequest(userId, userId)) }.thenSave()

    suspend fun signOut() {
        appState.setAuthToken(null)
        settings.clearSession()
    }

    private suspend fun AppResult<AuthResponse>.thenSave(): AppResult<Session> = when (this) {
        is AppResult.Success -> {
            val s = Session(data.token, data.user.id, data.user.name, data.user.email, data.user.role)
            appState.setAuthToken(s.token)
            settings.saveSession(s)
            AppResult.Success(s)
        }
        is AppResult.Error -> this
        AppResult.Loading -> AppResult.Loading
    }
}
