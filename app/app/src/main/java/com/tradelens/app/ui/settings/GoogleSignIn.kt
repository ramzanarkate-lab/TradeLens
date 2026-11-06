package com.tradelens.app.ui.settings

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.tradelens.app.BuildConfig

/**
 * The Credential Manager option for "Sign in with Google": the ID token is requested for the Web client ID
 * (the server checks that audience), and every account on the device is offered, not only ones used before.
 */
fun googleIdOption(webClientId: String): GetGoogleIdOption =
    GetGoogleIdOption.Builder()
        .setServerClientId(webClientId)
        .setFilterByAuthorizedAccounts(false)
        .build()

/** Shows Google's account picker and returns an ID token for the server to verify. [context] must be an Activity. */
suspend fun requestGoogleIdToken(context: Context, webClientId: String): String {
    val request = GetCredentialRequest.Builder()
        .addCredentialOption(googleIdOption(webClientId))
        .build()
    val credential = CredentialManager.create(context).getCredential(context, request).credential
    if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
        return GoogleIdTokenCredential.createFrom(credential.data).idToken
    }
    error("Unexpected credential type")
}

sealed interface GoogleSignInResult {
    data class Token(val idToken: String) : GoogleSignInResult

    /** The user closed the account picker. Not an error. */
    data object Cancelled : GoogleSignInResult

    /** This build has no googleWebClientId. */
    data object NotConfigured : GoogleSignInResult
    data object Failed : GoogleSignInResult
}

/** The whole "Sign in with Google" step for the login screen and Settings. [context] must be an Activity. */
suspend fun googleSignIn(context: Context): GoogleSignInResult {
    if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) return GoogleSignInResult.NotConfigured
    return try {
        GoogleSignInResult.Token(requestGoogleIdToken(context, BuildConfig.GOOGLE_WEB_CLIENT_ID))
    } catch (_: GetCredentialCancellationException) {
        GoogleSignInResult.Cancelled
    } catch (_: Exception) {
        GoogleSignInResult.Failed
    }
}
