package com.tradelens.app.data.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import com.squareup.moshi.Moshi
import com.tradelens.app.core.security.SecureTokenStore
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Everything the phone remembers: local preferences, the signed-in session, and the last settings
 * received from the server (used when offline). API secrets are never stored here.
 */
@Singleton
class SettingsRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>,
    moshi: Moshi,
    /** The session token lives here, encrypted. Everything else about the session is not secret and stays in DataStore. */
    private val secureToken: SecureTokenStore,
) {
    private val serverSettingsAdapter = moshi.adapter(ServerSettings::class.java)

    val prefs: Flow<LocalPrefs> = dataStore.data.map { it.toPrefs() }

    /** The server URL typed in Settings, or null to use the build default. */
    val serverUrlOverride: Flow<String?> = dataStore.data.map { it[K_SERVER_URL] }

    /** Signed in only when both the encrypted token and the account details are present. */
    val session: Flow<Session?> = combine(dataStore.data, secureToken.token) { p, token ->
        val userId = p[K_USER_ID]
        if (token == null || userId == null) null
        else Session(token, userId, p[K_USER_NAME].orEmpty(), p[K_USER_EMAIL].orEmpty(), p[K_USER_ROLE] ?: "user")
    }

    /** True once the user chose "Continue as guest" (until they sign out or go back to the login screen). */
    val guestChosen: Flow<Boolean> = dataStore.data.map { it[K_GUEST_CHOSEN] ?: false }

    suspend fun setGuestChosen(chosen: Boolean) {
        dataStore.edit { it[K_GUEST_CHOSEN] = chosen }
    }

    /** Last settings fetched from the server, for offline use. */
    val cachedServerSettings: Flow<ServerSettings?> = dataStore.data.map { p ->
        p[K_SERVER_CACHE]?.let { runCatching { serverSettingsAdapter.fromJson(it) }.getOrNull() }
    }

    /** Whether the first-launch "allow notifications?" question has been answered (yes or no). */
    val notificationPromptDone: Flow<Boolean> = dataStore.data.map { it[K_NOTIF_PROMPT_DONE] ?: false }

    suspend fun setNotificationPromptDone() {
        dataStore.edit { it[K_NOTIF_PROMPT_DONE] = true }
    }

    /** Epoch millis of the last successful sync, 0 if never. */
    val lastSyncMs: Flow<Long> = dataStore.data.map { it[K_LAST_SYNC] ?: 0L }

    suspend fun updatePrefs(transform: (LocalPrefs) -> LocalPrefs) {
        dataStore.edit { p -> p.write(transform(p.toPrefs())) }
    }

    suspend fun setServerUrlOverride(url: String?) {
        dataStore.edit { p -> if (url.isNullOrBlank()) p.remove(K_SERVER_URL) else p[K_SERVER_URL] = url.trim() }
    }

    suspend fun saveSession(session: Session) {
        secureToken.save(session.token)
        dataStore.edit { p ->
            p.remove(K_LEGACY_TOKEN) // older versions kept the token here, unencrypted
            p[K_USER_ID] = session.userId
            p[K_USER_NAME] = session.name
            p[K_USER_EMAIL] = session.email
            p[K_USER_ROLE] = session.role
        }
    }

    suspend fun updateSessionRole(role: String) {
        dataStore.edit { p -> if (p[K_USER_ID] != null) p[K_USER_ROLE] = role }
    }

    /** Signing out forgets the token, the account details and the cached signed-in-only settings, and returns to the login screen. */
    suspend fun clearSession() {
        secureToken.clear()
        dataStore.edit { p ->
            listOf(K_LEGACY_TOKEN, K_USER_ID, K_USER_NAME, K_USER_EMAIL, K_USER_ROLE, K_SERVER_CACHE).forEach { p.remove(it) }
            p[K_GUEST_CHOSEN] = false
        }
    }

    suspend fun cacheServerSettings(settings: ServerSettings, nowMs: Long) {
        dataStore.edit { p ->
            p[K_SERVER_CACHE] = serverSettingsAdapter.toJson(settings)
            p[K_LAST_SYNC] = nowMs
        }
    }

    private fun Preferences.toPrefs(): LocalPrefs {
        val d = LocalPrefs()
        return LocalPrefs(
            theme = this[K_THEME] ?: d.theme,
            sound = this[K_SOUND] ?: d.sound,
            vibration = this[K_VIBRATION] ?: d.vibration,
            popup = this[K_POPUP] ?: d.popup,
            backgroundService = this[K_BACKGROUND] ?: d.backgroundService,
            serverUrl = this[K_SERVER_URL] ?: d.serverUrl,
            defaultSymbol = this[K_DEFAULT_SYMBOL] ?: d.defaultSymbol,
            defaultTimeframe = this[K_DEFAULT_TIMEFRAME] ?: d.defaultTimeframe,
            showPivots = this[K_SHOW_PIVOTS] ?: d.showPivots,
            showVolume = this[K_SHOW_VOLUME] ?: d.showVolume,
            showEma = this[K_SHOW_EMA] ?: d.showEma,
        )
    }

    private fun MutablePreferences.write(p: LocalPrefs) {
        this[K_THEME] = p.theme
        this[K_SOUND] = p.sound
        this[K_VIBRATION] = p.vibration
        this[K_POPUP] = p.popup
        this[K_BACKGROUND] = p.backgroundService
        if (p.serverUrl.isBlank()) remove(K_SERVER_URL) else this[K_SERVER_URL] = p.serverUrl.trim()
        this[K_DEFAULT_SYMBOL] = p.defaultSymbol
        this[K_DEFAULT_TIMEFRAME] = p.defaultTimeframe
        this[K_SHOW_PIVOTS] = p.showPivots
        this[K_SHOW_VOLUME] = p.showVolume
        this[K_SHOW_EMA] = p.showEma
    }

    private companion object {
        val K_THEME = stringPreferencesKey("theme")
        val K_SOUND = booleanPreferencesKey("alert_sound")
        val K_VIBRATION = booleanPreferencesKey("alert_vibration")
        val K_POPUP = booleanPreferencesKey("alert_popup")
        val K_BACKGROUND = booleanPreferencesKey("alert_background")
        val K_SERVER_URL = stringPreferencesKey("server_url")
        val K_DEFAULT_SYMBOL = stringPreferencesKey("default_symbol")
        val K_DEFAULT_TIMEFRAME = stringPreferencesKey("default_timeframe")
        val K_SHOW_PIVOTS = booleanPreferencesKey("show_pivots")
        val K_SHOW_VOLUME = booleanPreferencesKey("show_volume")
        val K_SHOW_EMA = booleanPreferencesKey("show_ema")
        val K_LEGACY_TOKEN = stringPreferencesKey("session_token")
        val K_GUEST_CHOSEN = booleanPreferencesKey("guest_chosen")
        val K_USER_ID = stringPreferencesKey("session_user_id")
        val K_USER_NAME = stringPreferencesKey("session_user_name")
        val K_USER_EMAIL = stringPreferencesKey("session_user_email")
        val K_USER_ROLE = stringPreferencesKey("session_user_role")
        val K_SERVER_CACHE = stringPreferencesKey("server_settings_cache")
        val K_LAST_SYNC = longPreferencesKey("last_sync_ms")
        val K_NOTIF_PROMPT_DONE = booleanPreferencesKey("notification_prompt_done")
    }
}
