package com.tradelens.app.data.settings

import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.TradeLensApi
import com.tradelens.app.core.network.safeApiCall
import com.tradelens.app.state.AppState
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Pulls settings from the server. Offline or failing: the cached copy stays in use and nothing is lost.
 * An expired session (401) signs the user out. Guests never have their local choices overwritten.
 */
@Singleton
class SettingsSyncer @Inject constructor(
    private val api: TradeLensApi,
    private val repo: SettingsRepository,
    private val appState: AppState,
) {
    suspend fun sync(): AppResult<SettingsResponse> {
        val session = repo.session.first()
        appState.setAuthToken(session?.token) // make sure the token is in place for this very request

        val result = safeApiCall { api.settings() }
        when (result) {
            is AppResult.Success -> {
                val body = result.data
                repo.cacheServerSettings(body.settings, System.currentTimeMillis())
                if (session != null) {
                    repo.updateSessionRole(body.role)
                    applyToLocal(body.settings)
                }
            }
            is AppResult.Error -> {
                val e = result.error
                if (e is AppError.Http && e.code == 401 && session != null) {
                    appState.setAuthToken(null)
                    repo.clearSession()
                }
            }
            AppResult.Loading -> Unit
        }
        return result
    }

    /** Signed-in users: the server is the source of truth, so other devices' changes show up here. */
    private suspend fun applyToLocal(s: ServerSettings) {
        repo.updatePrefs { p ->
            p.copy(
                theme = s.general?.theme ?: p.theme,
                sound = s.alerts?.sound ?: p.sound,
                vibration = s.alerts?.vibration ?: p.vibration,
                popup = s.alerts?.popup ?: p.popup,
                backgroundService = s.alerts?.backgroundService ?: p.backgroundService,
                defaultSymbol = s.chart?.defaultSymbol ?: p.defaultSymbol,
                defaultTimeframe = s.chart?.defaultTimeframe ?: p.defaultTimeframe,
                showPivots = s.chart?.showPivots ?: p.showPivots,
                showVolume = s.chart?.showVolume ?: p.showVolume,
                showEma = s.chart?.showEma ?: p.showEma,
            )
        }
    }
}
