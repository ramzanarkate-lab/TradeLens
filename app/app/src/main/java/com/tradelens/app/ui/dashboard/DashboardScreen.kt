package com.tradelens.app.ui.dashboard

import com.tradelens.app.core.network.serverMessage
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.tradelens.app.R
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.theme.Amber80
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.ErrorCard
import com.tradelens.app.core.ui.LoadingSkeleton
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.dashboard.DashboardResponse
import com.tradelens.app.data.dashboard.DashboardSymbol
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.state.ConnectionStatus
import com.tradelens.app.ui.chart.formatPrice
import com.tradelens.app.ui.signals.SignalRow
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    onOpenChart: (String) -> Unit,
    onOpenSignal: (String) -> Unit,
    onCheckServer: () -> Unit = {},
    viewModel: DashboardViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val userName by viewModel.userName.collectAsStateWithLifecycle()
    val isAdmin by viewModel.isAdmin.collectAsStateWithLifecycle()
    val spacing = LocalSpacing.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // While the screen is visible: reload if stale, and apply live candle/signal pushes to the cards.
    LaunchedEffect(viewModel) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            viewModel.refreshIfStale()
            viewModel.runLive()
        }
    }

    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = viewModel::refresh, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(spacing.md),
            verticalArrangement = Arrangement.spacedBy(spacing.md),
        ) {
            Header(userName, connection, state.health)

            // Prices missing although the server answers: say why, not an empty screen. Hidden while prices are live.
            val health = state.health
            val noPrices = health != null && health.ok && (health.live == false || (state.data == null && state.error != null))
            if (noPrices) {
                val serverText = (state.error as? AppError.Http)?.serverMessage()
                PricesUnavailableCard(
                    showCheckServer = isAdmin,
                    reason = health?.reason ?: serverText ?: stringResource(R.string.prices_unavailable_default),
                    onRetry = viewModel::refresh,
                    onCheckServer = {
                        viewModel.checkServer()
                        onCheckServer()
                    },
                )
            } else {
                state.error?.let { ErrorCard(message = errorText(it), onRetry = viewModel::refresh) }
            }

            val data = state.data
            if (data == null) {
                if (state.loading) {
                    repeat(3) { Card(Modifier.fillMaxWidth()) { LoadingSkeleton(Modifier.padding(spacing.md), lines = 4) } }
                }
            } else {
                SummaryRow(data, state.lastUpdateMs)
                data.symbols.forEach { card -> SymbolCard(card, onClick = { onOpenChart(card.symbol) }) }
                RecentSignals(data, onOpenSignal)
            }
        }
    }
}

@Composable
private fun PricesUnavailableCard(reason: String, showCheckServer: Boolean, onRetry: () -> Unit, onCheckServer: () -> Unit) {
    val spacing = LocalSpacing.current
    val onColor = MaterialTheme.colorScheme.onErrorContainer
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(spacing.md), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
            Text(stringResource(R.string.prices_unavailable_title), style = MaterialTheme.typography.titleMedium, color = onColor)
            Text(reason, style = MaterialTheme.typography.bodyMedium, color = onColor)
            Row(horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                Button(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
                if (showCheckServer) OutlinedButton(onClick = onCheckServer) { Text(stringResource(R.string.check_server)) }
            }
        }
    }
}

@Composable
private fun Header(userName: String?, connection: ConnectionStatus, health: ServerHealth?) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                if (userName != null) stringResource(R.string.dashboard_greeting, userName) else stringResource(R.string.dashboard_guest),
                style = MaterialTheme.typography.headlineSmall,
            )
            val (label, color) = when (connection) {
                ConnectionStatus.Live -> R.string.status_live to Green80
                ConnectionStatus.Reconnecting -> R.string.status_reconnecting to Amber80
                ConnectionStatus.Offline -> R.string.status_offline to Red80
            }
            StatusChip(stringResource(label), color)
        }
        val (text, color) = when {
            health == null -> stringResource(R.string.server_health_checking) to MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
            health.ok -> stringResource(R.string.server_health_ok, health.millis) to Green80
            else -> stringResource(R.string.server_health_down) to Red80
        }
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
private fun SummaryRow(data: DashboardResponse, lastUpdateMs: Long) {
    val today = data.signals.today
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            Stat(stringResource(R.string.summary_signals_today), today.total.toString())
            Stat(stringResource(R.string.summary_buy), today.buy.toString(), Green80)
            Stat(stringResource(R.string.summary_sell), today.sell.toString(), Red80)
            Stat(
                stringResource(R.string.summary_updated),
                if (lastUpdateMs == 0L) "—" else DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(lastUpdateMs)),
            )
        }
    }
}

@Composable
private fun Stat(label: String, value: String, valueColor: Color = Color.Unspecified) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.titleMedium, color = valueColor)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
    }
}

@Composable
private fun SymbolCard(card: DashboardSymbol, onClick: () -> Unit) {
    val decimals = MarketConfig.decimals(card.symbol)
    val change = card.changePercent24h
    val changeColor = if ((change ?: 0.0) >= 0) Green80 else Red80
    val sparkColor = if (card.sparkline.size >= 2 && card.sparkline.last() < card.sparkline.first()) Red80 else Green80

    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text(card.symbol, style = MaterialTheme.typography.titleMedium)
                TrendBadge(card.trend)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.width(150.dp)) {
                    Text(card.price?.let { formatPrice(it, decimals) } ?: "—", style = MaterialTheme.typography.headlineSmall)
                    if (change != null) {
                        Text(
                            (if (change >= 0) "+" else "") + formatPrice(change, 2) + "%",
                            style = MaterialTheme.typography.titleMedium,
                            color = changeColor,
                        )
                    }
                }
                Sparkline(card.sparkline, sparkColor, Modifier.weight(1f).height(48.dp))
            }
            Text(
                stringResource(R.string.next_resistance, card.pivotAbove?.name ?: "—", card.pivotAbove?.let { formatPrice(it.value, decimals) } ?: "—"),
                style = MaterialTheme.typography.bodyMedium,
                color = Green80,
            )
            Text(
                stringResource(R.string.next_support, card.pivotBelow?.name ?: "—", card.pivotBelow?.let { formatPrice(it.value, decimals) } ?: "—"),
                style = MaterialTheme.typography.bodyMedium,
                color = Red80,
            )
            val signal = card.lastSignal
            Text(
                if (signal == null) {
                    stringResource(R.string.no_signal_yet)
                } else {
                    stringResource(
                        R.string.last_signal,
                        signal.side,
                        formatPrice(signal.price, decimals),
                        com.tradelens.app.ui.signals.formatSignalTime(signal.createdAt),
                    )
                },
                style = MaterialTheme.typography.bodyMedium,
                color = signal?.let { com.tradelens.app.ui.signals.sideColor(it.side) } ?: MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }
    }
}

@Composable
private fun TrendBadge(trend: String) {
    val (label, color) = when (trend) {
        "Bullish" -> stringResource(R.string.trend_bullish) to Green80
        "Bearish" -> stringResource(R.string.trend_bearish) to Red80
        else -> stringResource(R.string.trend_neutral) to MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
    }
    StatusChip(label, color)
}

@Composable
private fun RecentSignals(data: DashboardResponse, onOpenSignal: (String) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.recent_signals), style = MaterialTheme.typography.titleMedium)
            if (data.signals.recent.isEmpty()) {
                Text(stringResource(R.string.no_signals_yet), style = MaterialTheme.typography.bodyMedium)
            }
            data.signals.recent.forEachIndexed { index, signal ->
                if (index > 0) HorizontalDivider()
                SignalRow(signal, showReason = false, modifier = Modifier.clickable { onOpenSignal(signal.id) }.padding(vertical = 4.dp))
            }
        }
    }
}

@Composable
private fun errorText(error: AppError): String = when (error) {
    AppError.Network -> stringResource(R.string.error_network)
    is AppError.Http -> stringResource(R.string.error_server, error.code)
    is AppError.Unknown -> stringResource(R.string.error_unknown)
}
