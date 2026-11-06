package com.tradelens.app.ui.signals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.tradelens.app.R
import com.tradelens.app.core.alerts.SignalNotificationText
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.network.AppError.Http
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.ui.EmptyState
import com.tradelens.app.core.ui.ErrorCard
import com.tradelens.app.core.ui.LoadingSkeleton
import com.tradelens.app.core.ui.LockedNotice
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.SignalLock
import com.tradelens.app.ui.chart.formatPrice
import androidx.compose.material3.Card

/** Signals: stats card, filters, the list (pull to refresh, load more at the end) and a detail sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignalsScreen(viewModel: SignalsViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val spacing = LocalSpacing.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // While the screen is visible, new signals and status changes update the list in place.
    LaunchedEffect(viewModel) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { viewModel.runLive() }
    }

    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = viewModel::refresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(spacing.md),
            verticalArrangement = Arrangement.spacedBy(spacing.md),
        ) {
            item { Text(stringResource(R.string.nav_signals), style = MaterialTheme.typography.headlineSmall) }

            if (state.filterId != null) {
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(stringResource(R.string.signals_filtered_banner), style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = viewModel::showAll) { Text(stringResource(R.string.show_all_signals)) }
                    }
                }
            } else {
                item { StatsCard(state.stats) }
                item { FilterRow(state, viewModel) }
            }

            when {
                state.lock != null && state.signals.isEmpty() -> item { LockMessage(state.lock!!, viewModel::goToLogin) }
                state.error != null && state.signals.isEmpty() -> item {
                    val error = state.error!!
                    val message = if (error is Http && error.code == 404) stringResource(R.string.signal_not_found) else errorText(error)
                    ErrorCard(message = message, onRetry = viewModel::load)
                }
                state.loading -> item { Card(Modifier.fillMaxWidth()) { LoadingSkeleton(Modifier.padding(spacing.md), lines = 4) } }
                state.signals.isEmpty() -> item { EmptyState(Modifier.height(240.dp), message = stringResource(R.string.no_signals_filtered)) }
                else -> {
                    items(state.signals, key = { it.id }) { signal -> SignalCard(signal, onClick = { viewModel.select(signal) }) }
                    if (state.guestLocked) {
                        item {
                            LockedNotice(
                                message = stringResource(R.string.lock_full_history),
                                detail = stringResource(R.string.lock_signals_guest),
                                actionLabel = stringResource(R.string.sign_in_short),
                                onAction = viewModel::goToLogin,
                            )
                        }
                    }
                    if (state.hasMore) {
                        item {
                            // Reaching the end of the list loads the next page.
                            LaunchedEffect(state.signals.size) { viewModel.loadMore() }
                            Text(
                                stringResource(R.string.load_more),
                                modifier = Modifier.fillMaxWidth().padding(spacing.sm),
                                style = MaterialTheme.typography.labelLarge,
                                color = BrandCyan,
                            )
                        }
                    }
                }
            }
        }
    }

    state.selected?.let { signal ->
        ModalBottomSheet(onDismissRequest = { viewModel.select(null) }) { SignalDetail(signal) }
    }
}

@Composable
private fun FilterRow(state: SignalsUiState, viewModel: SignalsViewModel) {
    val spacing = LocalSpacing.current
    val all = stringResource(R.string.filter_all)
    val filters = state.filters
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
        FilterDropdown(
            label = stringResource(R.string.filter_symbol),
            selectedText = filters.symbol,
            options = listOf(all to null) + MarketConfig.symbols.map { it to it },
            onSelect = { s -> viewModel.setFilters { it.copy(symbol = s) } },
        )
        FilterDropdown(
            label = stringResource(R.string.filter_side),
            selectedText = filters.side,
            options = listOf(all to null, "BUY" to "BUY", "SELL" to "SELL"),
            onSelect = { s -> viewModel.setFilters { it.copy(side = s) } },
        )
        FilterDropdown(
            label = stringResource(R.string.filter_status),
            selectedText = filters.status?.let { statusLabel(it) },
            options = listOf(all to null) + STATUS_FILTERS.map { statusLabel(it) to it },
            onSelect = { s -> viewModel.setFilters { it.copy(status = s) } },
        )
        FilterDropdown(
            label = stringResource(R.string.filter_range),
            selectedText = if (filters.range == com.tradelens.app.data.signals.DateRange.Any) null else rangeLabel(filters.range),
            options = RANGE_FILTERS.map { rangeLabel(it) to it },
            onSelect = { r -> viewModel.setFilters { it.copy(range = r ?: com.tradelens.app.data.signals.DateRange.Any) } },
        )
    }
}

/** The full story of one signal: levels, risk and reward, the reasons that passed, and every status change. */
@Composable
private fun SignalDetail(signal: SignalDto) {
    val spacing = LocalSpacing.current
    val decimals = MarketConfig.decimals(signal.symbol)
    fun p(v: Double?) = formatPrice(v ?: 0.0, decimals)
    Column(Modifier.fillMaxWidth().padding(horizontal = spacing.lg).padding(bottom = spacing.xl), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
            StatusChip(signal.side, sideColor(signal.side))
            Text("${signal.symbol} · ${signal.timeframe}", style = MaterialTheme.typography.titleLarge)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(spacing.sm), verticalAlignment = Alignment.CenterVertically) {
            StatusChip(statusLabel(signal.status), statusColor(signal.status))
            signal.score?.let { Text(stringResource(R.string.detail_score, it), style = MaterialTheme.typography.titleMedium, color = BrandCyan) }
            signal.mode?.let { Text(stringResource(if (it == "live") R.string.mode_live else R.string.mode_paper), style = MaterialTheme.typography.labelMedium) }
        }
        signal.resultR?.let {
            Text(stringResource(R.string.detail_result, SignalNotificationText.formatR(it)), style = MaterialTheme.typography.titleMedium, color = resultColor(it))
        }

        if (signal.hasLevels) {
            LevelLine(stringResource(R.string.label_entry), p(signal.entry), null)
            LevelLine(stringResource(R.string.label_sl), p(signal.sl), signal.riskPercent?.let { stringResource(R.string.detail_risk, trimNumber(it)) })
            LevelLine("TP1", p(signal.tp1), signal.rrTp1?.let { stringResource(R.string.detail_rr, trimNumber(it)) })
            LevelLine("TP2", p(signal.tp2), signal.rrTp2?.let { stringResource(R.string.detail_rr, trimNumber(it)) })
            LevelLine("TP3", p(signal.tp3), signal.rrTp3?.let { stringResource(R.string.detail_rr, trimNumber(it)) })
        } else {
            LevelLine(stringResource(R.string.label_entry), p(signal.price), null)
        }

        val reasons = signal.reasons.orEmpty().ifEmpty { listOfNotNull(signal.reason?.takeIf { it.isNotBlank() }) }
        if (reasons.isNotEmpty()) {
            Text(stringResource(R.string.detail_reasons), style = MaterialTheme.typography.titleMedium)
            reasons.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
        }

        val history = signal.statusHistory.orEmpty()
        if (history.isNotEmpty()) {
            Text(stringResource(R.string.detail_history), style = MaterialTheme.typography.titleMedium)
            history.forEach { c ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${statusLabel(c.status)} · ${p(c.price)}", style = MaterialTheme.typography.bodyMedium, color = statusColor(c.status))
                    Text(
                        listOfNotNull(c.resultR?.let { SignalNotificationText.formatR(it) }, formatSignalTime(c.at)).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        Text(formatSignalTime(signal.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
    }
}

private fun trimNumber(v: Double): String = String.format(java.util.Locale.US, "%.2f", v).trimEnd('0').trimEnd('.')

@Composable
private fun LevelLine(label: String, value: String, note: String?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Text(listOfNotNull(value, note).joinToString("  ·  "), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun LockMessage(lock: SignalLock, onSignIn: () -> Unit) {
    when (lock) {
        SignalLock.SignIn -> LockedNotice(
            message = stringResource(R.string.lock_sign_in),
            detail = stringResource(R.string.lock_signals_guest),
            actionLabel = stringResource(R.string.sign_in_short),
            onAction = onSignIn,
        )
        SignalLock.Pro -> LockedNotice(message = stringResource(R.string.lock_upgrade_pro), detail = stringResource(R.string.lock_signals_user))
    }
}

@Composable
private fun errorText(error: AppError): String = when (error) {
    AppError.Network -> stringResource(R.string.error_network)
    is Http -> stringResource(R.string.error_server, error.code)
    is AppError.Unknown -> stringResource(R.string.error_unknown)
}
