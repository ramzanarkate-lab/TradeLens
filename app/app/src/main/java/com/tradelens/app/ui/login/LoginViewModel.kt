package com.tradelens.app.ui.login

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tradelens.app.R
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppResult
import com.tradelens.app.core.network.serverMessage
import com.tradelens.app.data.settings.AuthRepository
import com.tradelens.app.data.settings.Session
import com.tradelens.app.data.settings.SettingsRepository
import com.tradelens.app.data.settings.SettingsSyncer
import com.tradelens.app.ui.settings.GoogleSignInResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoginUiState(
    val busy: Boolean = false,
    /** Shown under the buttons: a string resource, or text sent by the server. */
    @StringRes val messageRes: Int? = null,
    val messageText: String? = null,
    /** Format argument for [messageRes], e.g. the HTTP code for "Server error (%1$d)". */
    val messageArg: Int? = null,
)

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val auth: AuthRepository,
    private val settings: SettingsRepository,
    private val syncer: SettingsSyncer,
) : ViewModel() {
    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    /** Signed-in session starts the app; a guest just carries on without one. */
    fun continueAsGuest() {
        viewModelScope.launch { settings.setGuestChosen(true) }
    }

    fun onGoogleResult(result: GoogleSignInResult) {
        when (result) {
            is GoogleSignInResult.Token -> signIn { auth.signInWithGoogle(result.idToken) }
            GoogleSignInResult.Cancelled -> Unit
            GoogleSignInResult.NotConfigured -> show(R.string.google_not_configured)
            GoogleSignInResult.Failed -> show(R.string.google_failed)
        }
    }

    /** Debug builds only: the server must run with ENABLE_DEV_LOGIN=true. "dev-admin" is an admin only if ADMIN_USER_IDS lists it. */
    fun devSignIn(userId: String) = signIn { auth.devLogin(userId) }

    private fun signIn(call: suspend () -> AppResult<Session>) {
        viewModelScope.launch {
            _state.update { LoginUiState(busy = true) }
            when (val r = call()) {
                is AppResult.Success -> {
                    syncer.sync() // pulls the account's settings; the screen switches away as soon as the session exists
                    _state.update { LoginUiState() }
                }
                is AppResult.Error -> _state.update { it.copy(busy = false).withError(r.error) }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun LoginUiState.withError(error: AppError): LoginUiState = when (error) {
        AppError.Network -> copy(messageRes = R.string.error_network, messageText = null)
        is AppError.Unknown -> copy(messageRes = R.string.error_unknown, messageText = null)
        is AppError.Http -> error.serverMessage()?.let { copy(messageRes = null, messageText = it) }
            ?: copy(messageRes = R.string.error_server, messageText = null, messageArg = error.code)
    }

    private fun show(@StringRes res: Int) = _state.update { LoginUiState(messageRes = res) }
}
