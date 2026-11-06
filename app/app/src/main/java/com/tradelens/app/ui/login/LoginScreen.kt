package com.tradelens.app.ui.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tradelens.app.BuildConfig
import com.tradelens.app.R
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.theme.TextSecondary
import com.tradelens.app.core.ui.BrandHeader
import com.tradelens.app.core.ui.BrandSize
import com.tradelens.app.ui.settings.googleSignIn
import kotlinx.coroutines.launch

/** First screen of a fresh install or after signing out: sign in with Google, or carry on as a guest. */
@Composable
fun LoginScreen(viewModel: LoginViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current // the Activity: Credential Manager needs it
    val scope = rememberCoroutineScope()
    val spacing = LocalSpacing.current

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = spacing.lg, vertical = spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            BrandHeader(BrandSize.Large)
            Text(
                stringResource(R.string.brand_tagline),
                style = MaterialTheme.typography.bodyLarge,
                color = TextSecondary,
                modifier = Modifier.padding(top = spacing.sm, bottom = spacing.xl),
            )

            Column(Modifier.widthIn(max = 360.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
                Button(
                    enabled = !state.busy,
                    onClick = { scope.launch { viewModel.onGoogleResult(googleSignIn(context)) } },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(R.string.sign_in_google)) }

                OutlinedButton(enabled = !state.busy, onClick = viewModel::continueAsGuest, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.continue_as_guest))
                }

                // Debug builds only: skip Google. The server needs ENABLE_DEV_LOGIN=true (and dev-admin in ADMIN_USER_IDS for an admin).
                if (BuildConfig.DEBUG) {
                    TextButton(enabled = !state.busy, onClick = { viewModel.devSignIn("dev-user") }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.sign_in_test_user))
                    }
                    TextButton(enabled = !state.busy, onClick = { viewModel.devSignIn("dev-admin") }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.sign_in_test_admin))
                    }
                }
            }

            val message = state.messageText ?: state.messageRes?.let { res ->
                state.messageArg?.let { stringResource(res, it) } ?: stringResource(res)
            }
            if (message != null) {
                Text(
                    message,
                    color = Red80,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = spacing.md),
                )
            }
        }
    }
}
