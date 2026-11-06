package com.tradelens.app.ui.settings

import com.tradelens.app.core.theme.Amber80
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.relocation.BringIntoViewRequester
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import android.content.ActivityNotFoundException
import androidx.compose.material3.CardDefaults
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.tradelens.app.core.alerts.BatteryOptimization
import com.tradelens.app.core.alerts.canPostNotifications
import com.tradelens.app.ui.alerts.rememberAskNotificationPermission
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Card
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tradelens.app.BuildConfig
import com.tradelens.app.R
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.BrandHeader
import com.tradelens.app.core.ui.BrandSize
import com.tradelens.app.core.ui.LockedNotice
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.settings.ConnectionResult
import com.tradelens.app.data.settings.MARKET_PROVIDERS
import com.tradelens.app.ui.signals.FilterDropdown
import com.tradelens.app.data.settings.ServerUrlProblem
import com.tradelens.app.data.settings.serverUrlProblem
import com.tradelens.app.data.settings.KEY_TELEGRAM_CHANNEL
import com.tradelens.app.data.settings.KEY_TELEGRAM_TOKEN
import com.tradelens.app.data.settings.SECRET_KEYS
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private const val PRIVACY_URL = "https://tradelens.example/privacy" // placeholder: point at the real policy before release

@Composable
fun SettingsScreen(viewModel: SettingsViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val spacing = LocalSpacing.current

    LaunchedEffect(Unit) { viewModel.refresh() }
    LaunchedEffect(Unit) {
        viewModel.messages.collect { m ->
            snackbar.showSnackbar(m.text ?: m.res?.let { resources.getString(it, *m.args.toTypedArray()) }.orEmpty())
        }
    }

    // Notifications: current state, refreshed when returning from system screens; "Test alert" waits for the answer.
    var notificationsAllowed by remember { mutableStateOf(context.canPostNotifications()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { notificationsAllowed = context.canPostNotifications() }
    var runTestAfterPermission by remember { mutableStateOf(false) }
    val testReason = stringResource(R.string.test_alert_reason)
    val askForNotifications = rememberAskNotificationPermission { granted ->
        notificationsAllowed = granted
        if (granted) viewModel.onNotificationPermissionGranted()
        if (runTestAfterPermission) {
            runTestAfterPermission = false
            viewModel.testAlert(testReason) // popup, sound and vibration still work without the notification permission
        }
    }
    val signedIn = state.session != null
    val prefs = state.prefs

    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(spacing.md),
            verticalArrangement = Arrangement.spacedBy(spacing.md),
        ) {
            // 1. Account
            Section(stringResource(R.string.section_account)) {
                val session = state.session
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                    Text(session?.name?.ifBlank { null } ?: stringResource(R.string.account_guest_name), style = MaterialTheme.typography.titleMedium)
                    RoleBadge(session?.role ?: "guest")
                }
                Text(
                    session?.email?.ifBlank { null } ?: stringResource(R.string.account_guest_hint),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (session == null) {
                    Button(
                        enabled = !state.busy,
                        onClick = {
                            scope.launch {
                                when (val result = googleSignIn(context)) {
                                    is GoogleSignInResult.Token -> viewModel.completeGoogleSignIn(result.idToken)
                                    GoogleSignInResult.Cancelled -> Unit // the user closed the account picker
                                    GoogleSignInResult.NotConfigured -> viewModel.reportError(R.string.google_not_configured)
                                    GoogleSignInResult.Failed -> viewModel.reportError(R.string.google_failed)
                                }
                            }
                        },
                    ) { Text(stringResource(R.string.sign_in_google)) }
                    if (BuildConfig.DEBUG) {
                        OutlinedButton(enabled = !state.busy, onClick = viewModel::devSignIn) {
                            Text(stringResource(R.string.sign_in_test_user))
                        }
                    }
                } else {
                    // The operator pastes this ID into ADMIN_USER_IDS (server/.env) to make an account an admin.
                    SelectionContainer {
                        Text(
                            stringResource(R.string.account_user_id, session.userId),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    // Signing out forgets the session, stops the background watcher and returns to the login screen.
                    OutlinedButton(onClick = viewModel::signOut) { Text(stringResource(R.string.sign_out)) }
                }
            }

            // 2. Appearance
            Section(stringResource(R.string.section_appearance)) {
                Label(stringResource(R.string.theme_label))
                ChoiceChips(
                    options = listOf("dark" to stringResource(R.string.theme_dark), "light" to stringResource(R.string.theme_light), "system" to stringResource(R.string.theme_system)),
                    selected = prefs.theme,
                    onSelect = viewModel::setTheme,
                )
            }

            // 3. Charts
            Section(stringResource(R.string.section_charts)) {
                Label(stringResource(R.string.default_symbol))
                ChoiceChips(MarketConfig.symbols.map { it to it }, prefs.defaultSymbol) { v -> viewModel.setChart { it.copy(defaultSymbol = v) } }
                Label(stringResource(R.string.default_timeframe))
                ChoiceChips(MarketConfig.timeframes.map { it to it }, prefs.defaultTimeframe) { v -> viewModel.setChart { it.copy(defaultTimeframe = v) } }
                SwitchRow(stringResource(R.string.toggle_pivots), prefs.showPivots) { v -> viewModel.setChart { it.copy(showPivots = v) } }
                SwitchRow(stringResource(R.string.toggle_volume), prefs.showVolume) { v -> viewModel.setChart { it.copy(showVolume = v) } }
                SwitchRow(stringResource(R.string.show_ema), prefs.showEma) { v -> viewModel.setChart { it.copy(showEma = v) } }
            }

            // 4. Signal strategy (signed-in users)
            Section(stringResource(R.string.section_strategy)) {
                if (!signedIn) {
                    LockedNotice(
                        message = stringResource(R.string.lock_sign_in),
                        detail = stringResource(R.string.strategy_signin_required),
                        actionLabel = stringResource(R.string.sign_in_short),
                        onAction = viewModel::goToLogin,
                    )
                } else {
                    val f = state.form
                    val e = state.formErrors
                    NumberField(stringResource(R.string.strategy_ema_fast), f.emaFast, e[StrategyField.EmaFast]) { v -> viewModel.onFormChange { it.copy(emaFast = v) } }
                    NumberField(stringResource(R.string.strategy_ema_slow), f.emaSlow, e[StrategyField.EmaSlow]) { v -> viewModel.onFormChange { it.copy(emaSlow = v) } }
                    NumberField(stringResource(R.string.strategy_rsi_period), f.rsiPeriod, e[StrategyField.RsiPeriod]) { v -> viewModel.onFormChange { it.copy(rsiPeriod = v) } }
                    NumberField(stringResource(R.string.strategy_rsi_buy_min), f.rsiBuyMin, e[StrategyField.RsiBuyMin]) { v -> viewModel.onFormChange { it.copy(rsiBuyMin = v) } }
                    NumberField(stringResource(R.string.strategy_rsi_buy_max), f.rsiBuyMax, e[StrategyField.RsiBuyMax]) { v -> viewModel.onFormChange { it.copy(rsiBuyMax = v) } }
                    NumberField(stringResource(R.string.strategy_rsi_sell), f.rsiSellAbove, e[StrategyField.RsiSellAbove]) { v -> viewModel.onFormChange { it.copy(rsiSellAbove = v) } }
                    NumberField(stringResource(R.string.strategy_cooldown), f.cooldownMinutes, e[StrategyField.Cooldown]) { v -> viewModel.onFormChange { it.copy(cooldownMinutes = v) } }
                    Row(horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                        Button(enabled = !state.busy, onClick = viewModel::saveStrategy) { Text(stringResource(R.string.save)) }
                        OutlinedButton(onClick = viewModel::resetStrategyForm) { Text(stringResource(R.string.reset_defaults)) }
                    }
                }
            }

            // 5. Alerts
            Section(stringResource(R.string.section_alerts)) {
                SwitchRow(stringResource(R.string.alert_sound), prefs.sound) { v -> viewModel.setAlerts { it.copy(sound = v) } }
                SwitchRow(stringResource(R.string.alert_vibration), prefs.vibration) { v -> viewModel.setAlerts { it.copy(vibration = v) } }
                SwitchRow(stringResource(R.string.alert_popup), prefs.popup) { v -> viewModel.setAlerts { it.copy(popup = v) } }
                SwitchRow(stringResource(R.string.alert_background), prefs.backgroundService) { v -> viewModel.setAlerts { it.copy(backgroundService = v) } }

                // Notification permission (Android 13+): status, and a button that explains first, then asks.
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(
                        stringResource(if (notificationsAllowed) R.string.notif_status_allowed else R.string.notif_status_off),
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (notificationsAllowed) Green80 else Red80,
                    )
                    TextButton(onClick = {
                        context.startActivity(
                            Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    }) { Text(stringResource(R.string.notif_open_settings)) }
                }
                if (!notificationsAllowed) {
                    OutlinedButton(onClick = askForNotifications) { Text(stringResource(R.string.notif_enable)) }
                }

                // Background alerts can be stopped by battery optimization: detect it and offer the settings screen.
                if (prefs.backgroundService && signedIn) BatteryOptimizationPrompt()

                OutlinedButton(onClick = {
                    // Without the permission, explain and ask first; then run the test either way.
                    if (!notificationsAllowed) {
                        runTestAfterPermission = true
                        askForNotifications()
                    } else {
                        viewModel.testAlert(testReason)
                    }
                }) { Text(stringResource(R.string.test_alert)) }
            }

            // 6. Server: admin only. Other accounts do not see it at all, and use the address built into the app.
            if (state.session?.role == "admin") {
            val urlProblem = serverUrlProblem(state.serverUrlInput)
            val serverSection = remember { BringIntoViewRequester() }
            val focusServer by viewModel.focusServerSection.collectAsStateWithLifecycle()
            LaunchedEffect(focusServer) {
                if (focusServer) {
                    serverSection.bringIntoView()
                    viewModel.serverSectionShown()
                }
            }
            Box(Modifier.bringIntoViewRequester(serverSection)) {
            Section(stringResource(R.string.section_server)) {
                OutlinedTextField(
                    value = state.serverUrlInput,
                    onValueChange = viewModel::onServerUrlChange,
                    label = { Text(stringResource(R.string.server_url_field)) },
                    isError = urlProblem != null,
                    supportingText = urlProblem?.let { p ->
                        {
                            Text(
                                stringResource(
                                    when (p) {
                                        ServerUrlProblem.MissingScheme -> R.string.url_must_start
                                        ServerUrlProblem.TrailingSlash -> R.string.url_no_trailing_slash
                                        ServerUrlProblem.Invalid -> R.string.url_invalid
                                    },
                                ),
                            )
                        }
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                    Button(enabled = urlProblem == null, onClick = viewModel::saveServerUrl) { Text(stringResource(R.string.save)) }
                    OutlinedButton(enabled = !state.testing && urlProblem == null, onClick = viewModel::testConnection) { Text(stringResource(R.string.test_connection)) }
                }
                when (val c = state.connection) {
                    is ConnectionResult.Ok ->
                        if (c.live == null) Text(stringResource(R.string.connection_ok, c.millis), color = Green80)
                        else Text(
                            stringResource(
                                R.string.connection_ok_live,
                                stringResource(if (c.live) R.string.answer_yes else R.string.answer_no),
                                c.provider ?: "?",
                            ),
                            color = if (c.live) Green80 else Amber80,
                        )
                    is ConnectionResult.Failed -> Text(stringResource(R.string.connection_failed, c.reason), color = Red80)
                    ConnectionResult.InvalidUrl -> Text(stringResource(R.string.url_invalid), color = Red80)
                    null -> if (state.testing) Text(stringResource(R.string.connection_testing))
                }
                Text(
                    stringResource(R.string.last_sync, if (state.lastSyncMs == 0L) stringResource(R.string.never) else DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(state.lastSyncMs))),
                    style = MaterialTheme.typography.bodyMedium,
                )
                state.adminServer?.let { server ->
                    Text(stringResource(R.string.server_active_provider, server.marketProvider.active.ifBlank { "?" }), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        stringResource(R.string.server_live_prices, stringResource(if (server.marketProvider.live) R.string.answer_yes else R.string.answer_no)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (server.marketProvider.live) Green80 else Amber80,
                    )
                    FilterDropdown(
                        label = stringResource(R.string.market_provider_label),
                        selectedText = server.marketProvider.setting,
                        options = MARKET_PROVIDERS.map { it to it },
                        onSelect = { p -> if (p != null) viewModel.setMarketProvider(p) },
                    )
                }
                OutlinedButton(onClick = viewModel::resetServerUrl) { Text(stringResource(R.string.reset_server)) }
                OutlinedButton(enabled = !state.busy, onClick = viewModel::refresh) { Text(stringResource(R.string.sync_now)) }
            }
            }
            }

            // Telegram channel: read only for everyone
            Section(stringResource(R.string.section_telegram)) {
                val telegram = state.telegram
                Text(
                    stringResource(if (telegram?.active == true) R.string.telegram_channel_active else R.string.telegram_channel_not_configured),
                    style = MaterialTheme.typography.titleMedium,
                )
                val link = telegram?.channelLink.orEmpty()
                if (link.isNotBlank()) {
                    OutlinedButton(onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) }
                    }) { Text(stringResource(R.string.telegram_join)) }
                }
            }

            // 7. Admin only: secrets are write-only
            if (state.session?.role == "admin") {
                Section(stringResource(R.string.section_admin)) {
                    Text(stringResource(R.string.admin_secrets_hint), style = MaterialTheme.typography.bodyMedium)
                    // Deliberately remember (not rememberSaveable): typed secrets must never reach saved instance state.
                    var inputs by remember { mutableStateOf(emptyMap<String, String>()) }
                    SECRET_KEYS.forEach { key ->
                        val isSet = state.secretsStatus?.get(key)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                            Text(secretLabel(key), style = MaterialTheme.typography.titleMedium)
                            when (isSet) {
                                true -> StatusChip(stringResource(R.string.secret_set), Green80)
                                false -> StatusChip(stringResource(R.string.secret_not_set), Red80)
                                null -> Unit
                            }
                        }
                        OutlinedTextField(
                            value = inputs[key].orEmpty(),
                            onValueChange = { v -> inputs = inputs + (key to v) },
                            label = { Text(stringResource(R.string.secret_new_value)) },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Button(enabled = !state.busy, onClick = {
                        scope.launch { if (viewModel.saveSecrets(inputs)) inputs = emptyMap() } // clear the fields after a successful save
                    }) { Text(stringResource(R.string.save_secrets)) }

                    // Telegram channel posting
                    Text(stringResource(R.string.telegram_admin_title), style = MaterialTheme.typography.titleMedium)
                    SwitchRow(stringResource(R.string.telegram_post_signals), state.telegram?.enabled == true) { v -> viewModel.setTelegramEnabled(v) }
                    var telegramInputs by remember { mutableStateOf(emptyMap<String, String>()) }
                    listOf(KEY_TELEGRAM_TOKEN to R.string.telegram_bot_token, KEY_TELEGRAM_CHANNEL to R.string.telegram_channel_id).forEach { (key, label) ->
                        val isSet = state.secretsStatus?.get(key)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(label), style = MaterialTheme.typography.bodyLarge)
                            when (isSet) {
                                true -> StatusChip(stringResource(R.string.secret_set), Green80)
                                false -> StatusChip(stringResource(R.string.secret_not_set), Red80)
                                null -> Unit
                            }
                        }
                        OutlinedTextField(
                            value = telegramInputs[key].orEmpty(),
                            onValueChange = { v -> telegramInputs = telegramInputs + (key to v) },
                            label = { Text(stringResource(R.string.secret_new_value)) },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                        Button(enabled = !state.busy, onClick = {
                            scope.launch { if (viewModel.saveTelegram(telegramInputs)) telegramInputs = emptyMap() } // clear the fields after a successful save
                        }) { Text(stringResource(R.string.telegram_save)) }
                        OutlinedButton(enabled = !state.busy, onClick = viewModel::sendTelegramTest) { Text(stringResource(R.string.telegram_send_test)) }
                    }
                    state.telegram?.let { t ->
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(spacing.md), verticalArrangement = Arrangement.spacedBy(spacing.xs)) {
                                val last = t.lastSuccessAt
                                Text(
                                    stringResource(
                                        R.string.telegram_last_post,
                                        if (last == null) stringResource(R.string.never) else DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(last)),
                                    ),
                                )
                                Text(stringResource(R.string.telegram_posts_24h, t.postsLast24h ?: 0))
                                Text(stringResource(R.string.telegram_failed_posts, t.failedPosts ?: 0))
                            }
                        }
                    }
                }
            }

            // 8. About
            Section(stringResource(R.string.section_about)) {
                BrandHeader(BrandSize.Large, Modifier.fillMaxWidth())
                Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.about_disclaimer), style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL))) }) {
                    Text(stringResource(R.string.about_privacy))
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = spacing.sm))
    }
}

/** Shows a warning with a button to the battery settings while the system may restrict background work. */
@Composable
private fun BatteryOptimizationPrompt() {
    val context = LocalContext.current
    var ignoring by remember { mutableStateOf(BatteryOptimization.isIgnoring(context)) }
    // The user comes back from the system screen: check again.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { ignoring = BatteryOptimization.isIgnoring(context) }
    if (ignoring) return

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.battery_title), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            Text(stringResource(R.string.battery_message), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            Button(onClick = {
                try {
                    context.startActivity(BatteryOptimization.settingsIntent())
                } catch (_: ActivityNotFoundException) {
                    context.startActivity(BatteryOptimization.appDetailsIntent(context))
                }
            }) { Text(stringResource(R.string.battery_open)) }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    val spacing = LocalSpacing.current
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(spacing.md), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            content()
        }
    }
}

@Composable
private fun Label(text: String) = Text(text, style = MaterialTheme.typography.labelMedium)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceChips(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(LocalSpacing.current.sm)) {
        options.forEach { (value, label) ->
            FilterChip(selected = value == selected, onClick = { onSelect(value) }, label = { Text(label) })
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun NumberField(label: String, value: String, error: StrategyError?, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.filter(Char::isDigit).take(6)) },
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { { Text(errorText(it)) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun errorText(error: StrategyError): String = when (error) {
    is StrategyError.OutOfRange -> stringResource(R.string.error_range, error.min, error.max)
    StrategyError.FastNotBelowSlow -> stringResource(R.string.error_fast_below_slow)
    StrategyError.BuyMinNotBelowMax -> stringResource(R.string.error_buy_min_below_max)
}

@Composable
private fun RoleBadge(role: String) {
    val (label, color) = when (role) {
        "admin" -> stringResource(R.string.role_admin) to Red80
        "pro" -> stringResource(R.string.role_pro) to Green80
        "user" -> stringResource(R.string.role_user) to MaterialTheme.colorScheme.primary
        else -> stringResource(R.string.role_guest) to MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
    }
    StatusChip(label, color)
}

@Composable
private fun secretLabel(key: String): String = when (key) {
    "BINANCE_API_KEY" -> stringResource(R.string.secret_binance_key)
    "BINANCE_API_SECRET" -> stringResource(R.string.secret_binance_secret)
    "TELEGRAM_BOT_TOKEN" -> stringResource(R.string.secret_telegram_token)
    else -> stringResource(R.string.secret_telegram_channel)
}
