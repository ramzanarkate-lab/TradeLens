package com.tradelens.app.ui.settings

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.R
import com.tradelens.app.core.alerts.BackgroundServiceController
import com.tradelens.app.core.alerts.SignalAlerts
import com.tradelens.app.data.signals.SignalDto
import java.util.UUID
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.TradeLensApi
import com.tradelens.app.core.network.safeApiCall
import com.tradelens.app.core.network.serverMessage
import com.tradelens.app.data.settings.AlertsSettings
import com.tradelens.app.data.settings.AuthRepository
import com.tradelens.app.data.settings.ChartSettings
import com.tradelens.app.data.settings.ConnectionResult
import com.tradelens.app.data.settings.ConnectionTester
import com.tradelens.app.data.settings.GeneralSettings
import com.tradelens.app.data.settings.LocalPrefs
import com.tradelens.app.data.settings.ServerSettings
import com.tradelens.app.data.settings.Session
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.data.settings.AdminServerDto
import com.tradelens.app.data.settings.KEY_TELEGRAM_ENABLED
import com.tradelens.app.data.settings.SettingsSyncer
import com.tradelens.app.data.settings.TelegramStatus
import com.tradelens.app.data.settings.SignalsSettings
import com.tradelens.app.data.settings.isValidServerUrl
import com.tradelens.app.data.settings.serverUrlProblem
import com.tradelens.app.state.AppState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** A message for the snackbar: a string resource (with arguments) or literal text from the server. */
data class UiMessage(@StringRes val res: Int? = null, val args: List<Any> = emptyList(), val text: String? = null)

data class SettingsUiState(
    val prefs: LocalPrefs = LocalPrefs(),
    val session: Session? = null,
    val server: ServerSettings? = null,
    val lastSyncMs: Long = 0,
    val form: StrategyForm = StrategyForm(),
    val formErrors: Map<StrategyField, StrategyError> = emptyMap(),
    val secretsStatus: Map<String, Boolean>? = null,
    val telegram: TelegramStatus? = null,
    val adminServer: AdminServerDto? = null,
    val serverUrlInput: String = "",
    val connection: ConnectionResult? = null,
    val testing: Boolean = false,
    val busy: Boolean = false,
)

private data class Transient(
    val form: StrategyForm = StrategyForm(),
    val formDirty: Boolean = false,
    val formErrors: Map<StrategyField, StrategyError> = emptyMap(),
    val secretsStatus: Map<String, Boolean>? = null,
    val telegram: TelegramStatus? = null,
    val adminServer: AdminServerDto? = null,
    val serverUrlEdit: String? = null,
    val connection: ConnectionResult? = null,
    val testing: Boolean = false,
    val busy: Boolean = false,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repo: SettingsRepository,
    private val auth: AuthRepository,
    private val syncer: SettingsSyncer,
    private val api: TradeLensApi,
    private val tester: ConnectionTester,
    private val appState: AppState,
    private val alerts: SignalAlerts,
    private val backgroundService: BackgroundServiceController,
) : ViewModel() {

    private val transient = MutableStateFlow(Transient())
    private val _messages = MutableSharedFlow<UiMessage>(extraBufferCapacity = 8)
    val messages: SharedFlow<UiMessage> = _messages.asSharedFlow()

    /** True when another screen asked Settings to show its Server section. */
    val focusServerSection: StateFlow<Boolean> = appState.focusServerSection

    fun serverSectionShown() = appState.serverSectionShown()

    val state: StateFlow<SettingsUiState> = combine(
        combine(repo.prefs, repo.session, repo.cachedServerSettings, repo.lastSyncMs) { p, s, c, t -> arrayOf(p, s, c, t) },
        transient,
        appState.serverUrl,
    ) { a, t, effectiveUrl ->
        val prefs = a[0] as LocalPrefs
        SettingsUiState(
            prefs = prefs,
            session = a[1] as Session?,
            server = a[2] as ServerSettings?,
            lastSyncMs = a[3] as Long,
            form = t.form,
            formErrors = t.formErrors,
            secretsStatus = t.secretsStatus,
            telegram = t.telegram,
            adminServer = t.adminServer,
            serverUrlInput = t.serverUrlEdit ?: prefs.serverUrl.ifBlank { effectiveUrl },
            connection = t.connection,
            testing = t.testing,
            busy = t.busy,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SettingsUiState())

    init {
        // Keep the strategy form in step with the server's values, unless the user is mid-edit.
        viewModelScope.launch {
            repo.cachedServerSettings.collect { s ->
                val signals = s?.signals
                transient.update { t ->
                    when {
                        signals == null -> t.copy(form = StrategyForm(), formDirty = false, formErrors = emptyMap())
                        t.formDirty -> t
                        else -> t.copy(form = StrategyForm.from(signals))
                    }
                }
            }
        }
    }

    // ---- sync ----

    /** Called when the screen opens: refresh from the server (the cache stays if offline) and, for admins, the secrets status. */
    fun refresh() {
        viewModelScope.launch {
            busy(true)
            val result = syncer.sync()
            if (result is AppResult.Error) report(result.error, quiet = result.error is AppError.Network)
            val role = repo.session.first()?.role
            if (role == "admin") {
                loadSecretsStatus()
                loadAdminServer()
            } else {
                transient.update { it.copy(secretsStatus = null, adminServer = null) }
            }
            loadTelegram()
            busy(false)
        }
    }

    // ---- account ----

    fun completeGoogleSignIn(idToken: String) = signIn { auth.signInWithGoogle(idToken) }

    fun devSignIn() = signIn { auth.devLogin("dev-user") }

    fun signOut() {
        viewModelScope.launch {
            auth.signOut()
            transient.update { it.copy(secretsStatus = null, telegram = null, adminServer = null, form = StrategyForm(), formDirty = false, formErrors = emptyMap()) }
            _messages.emit(UiMessage(R.string.signed_out))
        }
    }

    /** A guest who wants to sign in goes back to the login screen. */
    fun goToLogin() {
        viewModelScope.launch { repo.setGuestChosen(false) }
    }

    fun reportError(@StringRes res: Int) {
        _messages.tryEmit(UiMessage(res))
    }

    private fun signIn(call: suspend () -> AppResult<Session>) {
        viewModelScope.launch {
            busy(true)
            when (val r = call()) {
                is AppResult.Success -> {
                    syncer.sync()
                    if (r.data.role == "admin") loadSecretsStatus()
                    _messages.emit(UiMessage(R.string.signed_in_as, listOf(r.data.name)))
                }
                is AppResult.Error -> report(r.error)
                AppResult.Loading -> Unit
            }
            busy(false)
        }
    }

    // ---- appearance, charts, alerts: saved on the phone, and on the server too when signed in ----

    fun setTheme(theme: String) {
        updatePrefs({ it.copy(theme = theme) }) { p -> pushGeneral(p) }
    }

    fun setChart(transform: (LocalPrefs) -> LocalPrefs) {
        updatePrefs(transform) { p ->
            api.putChart(ChartSettings(p.defaultSymbol, p.defaultTimeframe, p.showPivots, p.showVolume, p.showEma))
        }
    }

    fun setAlerts(transform: (LocalPrefs) -> LocalPrefs) {
        updatePrefs(transform) { p -> api.putAlerts(AlertsSettings(p.sound, p.vibration, p.popup, p.backgroundService)) }
    }

    private suspend fun pushGeneral(p: LocalPrefs) = api.putGeneral(GeneralSettings("en", p.theme)) // the app is English only

    private fun updatePrefs(transform: (LocalPrefs) -> LocalPrefs, push: suspend (LocalPrefs) -> Unit) {
        viewModelScope.launch {
            repo.updatePrefs(transform)
            if (repo.session.first() == null) return@launch // guests: this device only
            val result = safeApiCall { push(repo.prefs.first()) }
            if (result is AppResult.Error) report(result.error)
        }
    }

    // ---- alerts ----

    /** Notifications were just allowed: make the background watcher post its persistent notification now. */
    fun onNotificationPermissionGranted() = backgroundService.refresh()

    /**
     * Test Alert: a sample BUY signal sent through exactly the same path as a real one (popup, sound, vibration and
     * notification, following the switches above). It is local: nothing is sent to the server or stored.
     * [reason] is the localized sentence, because the ViewModel has no access to translated strings.
     */
    fun testAlert(reason: String) {
        viewModelScope.launch {
            val prefs = repo.prefs.first()
            val symbol = prefs.defaultSymbol
            alerts.handle(
                SignalDto(
                    id = UUID.randomUUID().toString(),
                    symbol = symbol,
                    side = "BUY",
                    timeframe = state.value.server?.signals?.timeframe ?: "1h",
                    price = SAMPLE_PRICES[symbol] ?: 100.0,
                    trigger = "ema_cross_up",
                    reason = reason,
                    createdAt = System.currentTimeMillis(),
                    test = true,
                ),
            )
        }
    }

    // ---- signal strategy ----

    fun onFormChange(transform: (StrategyForm) -> StrategyForm) {
        transient.update { it.copy(form = transform(it.form), formDirty = true, formErrors = emptyMap()) }
    }

    /** Puts the defaults into the form. Nothing is sent until Save. */
    fun resetStrategyForm() {
        transient.update { it.copy(form = StrategyForm.from(DEFAULT_STRATEGY), formDirty = true, formErrors = emptyMap()) }
    }

    fun saveStrategy() {
        val timeframe = state.value.server?.signals?.timeframe ?: DEFAULT_STRATEGY.timeframe
        val validation = StrategyValidator.validate(transient.value.form, timeframe)
        if (validation.values == null) {
            transient.update { it.copy(formErrors = validation.errors) }
            return
        }
        viewModelScope.launch {
            busy(true)
            when (val r = safeApiCall { api.putSignals(validation.values) }) {
                is AppResult.Success -> {
                    transient.update { it.copy(formDirty = false, formErrors = emptyMap()) }
                    syncer.sync() // refreshes the cache and the form from the server's copy
                    _messages.emit(UiMessage(R.string.strategy_saved))
                }
                is AppResult.Error -> report(r.error)
                AppResult.Loading -> Unit
            }
            busy(false)
        }
    }

    // ---- server ----

    fun onServerUrlChange(text: String) = transient.update { it.copy(serverUrlEdit = text, connection = null) }

    fun saveServerUrl() {
        val input = transient.value.serverUrlEdit ?: return
        viewModelScope.launch {
            if (input.isNotBlank() && (serverUrlProblem(input) != null || !isValidServerUrl(input))) {
                _messages.emit(UiMessage(R.string.url_invalid))
                return@launch
            }
            repo.setServerUrlOverride(input.takeIf { it.isNotBlank() })
            transient.update { it.copy(serverUrlEdit = null) }
            _messages.emit(UiMessage(R.string.server_url_saved))
            refresh()
        }
    }

    fun testConnection() {
        val url = state.value.serverUrlInput
        if (serverUrlProblem(url) != null) {
            transient.update { it.copy(connection = ConnectionResult.InvalidUrl) }
            return
        }
        viewModelScope.launch {
            transient.update { it.copy(testing = true, connection = null) }
            val result = tester.test(url)
            transient.update { it.copy(testing = false, connection = result) }
        }
    }

    // ---- admin secrets (write-only) ----

    private suspend fun loadSecretsStatus() {
        val r = safeApiCall { api.secretsStatus() }
        if (r is AppResult.Success) transient.update { it.copy(secretsStatus = r.data.secrets) }
    }

    /**
     * Sends the typed secrets to the server. The values are only held for this call: they are not kept in
     * any state, and the screen clears its input fields after a successful save.
     * Returns true on success.
     */
    suspend fun saveSecrets(values: Map<String, String>): Boolean {
        val toSend = values.mapValues { it.value.trim() }.filterValues { it.isNotEmpty() }
        if (toSend.isEmpty()) {
            _messages.emit(UiMessage(R.string.secrets_nothing_to_save))
            return false
        }
        busy(true)
        val result = safeApiCall { api.putSecrets(toSend) }
        busy(false)
        return when (result) {
            is AppResult.Success -> {
                transient.update { it.copy(secretsStatus = result.data.secrets) }
                _messages.emit(UiMessage(R.string.secrets_saved))
                true
            }
            is AppResult.Error -> {
                report(result.error)
                false
            }
            AppResult.Loading -> false
        }
    }

    // ---- admin: server section ----

    private suspend fun loadAdminServer() {
        val r = safeApiCall { api.adminServer() }
        if (r is AppResult.Success) transient.update { it.copy(adminServer = r.data) }
    }

    /** Sends the chosen market provider to the server, which switches without a restart. */
    fun setMarketProvider(provider: String) {
        viewModelScope.launch {
            busy(true)
            val result = safeApiCall { api.setMarketProvider(mapOf("provider" to provider)) }
            busy(false)
            when (result) {
                is AppResult.Success -> _messages.emit(UiMessage(R.string.market_provider_switched, listOf(result.data["active"] ?: provider)))
                is AppResult.Error -> report(result.error)
                AppResult.Loading -> Unit
            }
            loadAdminServer()
        }
    }

    /** Forgets the address typed here and goes back to the address built into the app. */
    fun resetServerUrl() {
        viewModelScope.launch {
            repo.setServerUrlOverride(null)
            transient.update { it.copy(serverUrlEdit = null, connection = null) }
            _messages.emit(UiMessage(R.string.server_reset_done))
            refresh()
        }
    }

    // ---- telegram ----

    /** Loads the channel status. Guests and users get the basics, admins also get the post numbers. Failures are quiet. */
    private suspend fun loadTelegram() {
        val r = safeApiCall { api.telegramStatus() }
        if (r is AppResult.Success) transient.update { it.copy(telegram = r.data) }
    }

    fun setTelegramEnabled(enabled: Boolean) {
        viewModelScope.launch {
            busy(true)
            val result = safeApiCall { api.putSecrets(mapOf(KEY_TELEGRAM_ENABLED to enabled.toString())) }
            busy(false)
            if (result is AppResult.Error) report(result.error)
            loadTelegram() // shows what the server really has, also after a failure
        }
    }

    /**
     * Sends the typed bot token and channel ID to the server. Like the other secrets they are only held for this call;
     * the screen clears its fields after a successful save. Returns true on success.
     */
    suspend fun saveTelegram(values: Map<String, String>): Boolean {
        val toSend = values.mapValues { it.value.trim() }.filterValues { it.isNotEmpty() }
        if (toSend.isEmpty()) {
            _messages.emit(UiMessage(R.string.secrets_nothing_to_save))
            return false
        }
        busy(true)
        val result = safeApiCall { api.putSecrets(toSend) }
        busy(false)
        return when (result) {
            is AppResult.Success -> {
                transient.update { it.copy(secretsStatus = result.data.secrets) }
                _messages.emit(UiMessage(R.string.telegram_saved))
                loadTelegram()
                true
            }
            is AppResult.Error -> {
                report(result.error)
                false
            }
            AppResult.Loading -> false
        }
    }

    fun sendTelegramTest() {
        viewModelScope.launch {
            busy(true)
            val result = safeApiCall { api.telegramTest() }
            busy(false)
            when (result) {
                is AppResult.Success ->
                    if (result.data.ok) _messages.emit(UiMessage(R.string.telegram_test_ok))
                    else _messages.emit(UiMessage(R.string.telegram_test_failed, listOf(result.data.reason ?: "")))
                is AppResult.Error -> report(result.error)
                AppResult.Loading -> Unit
            }
            loadTelegram()
        }
    }

    // ---- helpers ----

    private fun busy(value: Boolean) = transient.update { it.copy(busy = value) }

    private suspend fun report(error: AppError, quiet: Boolean = false) {
        if (quiet) return
        when (error) {
            AppError.Network -> _messages.emit(UiMessage(R.string.error_network))
            is AppError.Unknown -> _messages.emit(UiMessage(R.string.error_unknown))
            is AppError.Http -> {
                if (error.code == 401) {
                    auth.signOut()
                    _messages.emit(UiMessage(R.string.session_expired))
                } else {
                    val text = error.serverMessage()
                    _messages.emit(if (text != null) UiMessage(text = text) else UiMessage(R.string.error_server, listOf(error.code)))
                }
            }
        }
    }

    companion object {
        val DEFAULT_STRATEGY = SignalsSettings(20, 50, 14, 40.0, 65.0, 75.0, 60, "1h")

        /** Round sample prices for the Test Alert (same as the server's test alert). */
        private val SAMPLE_PRICES = mapOf("BTCUSDT" to 67_420.0, "SOLUSDT" to 150.0, "ETHUSDT" to 3_200.0)
    }
}
