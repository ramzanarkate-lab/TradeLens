package com.tradelens.app.ui.alerts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tradelens.app.R
import com.tradelens.app.core.alerts.AlertQueue
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.ui.chart.formatPrice
import com.tradelens.app.ui.signals.formatSignalTime
import com.tradelens.app.ui.signals.sideColor

/** Shows the signal at the front of the [AlertQueue]. Closing it reveals the next one, so popups never overlap. */
@Composable
fun AlertPopupHost(queue: AlertQueue, onViewChart: (symbol: String) -> Unit) {
    val signal by queue.current.collectAsStateWithLifecycle()
    signal?.let { s ->
        key(s.id) {
            AlertPopup(
                signal = s,
                onViewChart = {
                    onViewChart(s.symbol)
                    queue.dismiss()
                },
                onDismiss = queue::dismiss,
            )
        }
    }
}

/** A full-width dialog: side (green BUY / red SELL), symbol, timeframe, price, the reason and the time. */
@Composable
fun AlertPopup(signal: SignalDto, onViewChart: () -> Unit, onDismiss: () -> Unit) {
    val spacing = LocalSpacing.current
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Card(Modifier.fillMaxWidth().padding(horizontal = spacing.md)) {
            Column(Modifier.padding(spacing.lg), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                    StatusChip(signal.side, sideColor(signal.side))
                    if (signal.test) StatusChip(stringResource(R.string.alert_test_chip), MaterialTheme.colorScheme.secondary)
                }
                Text(
                    "${signal.symbol} · ${signal.timeframe}",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "${if (signal.hasLevels) stringResource(R.string.label_entry) + " " else ""}${formatPrice(signal.entry ?: signal.price, MarketConfig.decimals(signal.symbol))}",
                    style = MaterialTheme.typography.displayMedium,
                    color = sideColor(signal.side),
                )
                if (signal.hasLevels) {
                    // Entry, stop, three targets, the score and the three strongest reasons.
                    val d = MarketConfig.decimals(signal.symbol)
                    signal.score?.let { Text(stringResource(R.string.detail_score, it), style = MaterialTheme.typography.titleMedium, color = BrandCyan) }
                    Text("${stringResource(R.string.label_sl)} ${formatPrice(signal.sl ?: 0.0, d)}", style = MaterialTheme.typography.bodyLarge, color = Red80)
                    Text(
                        "TP1 ${formatPrice(signal.tp1 ?: 0.0, d)}   TP2 ${formatPrice(signal.tp2 ?: 0.0, d)}   TP3 ${formatPrice(signal.tp3 ?: 0.0, d)}",
                        style = MaterialTheme.typography.bodyLarge,
                        color = Green80,
                    )
                    signal.reasons.orEmpty().take(3).forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
                } else if (!signal.reason.isNullOrBlank()) {
                    Text(signal.reason, style = MaterialTheme.typography.bodyLarge)
                }
                Text(
                    formatSignalTime(signal.createdAt),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onDismiss) { Text(stringResource(R.string.alert_popup_dismiss)) }
                    Button(onClick = onViewChart) { Text(stringResource(R.string.alert_popup_view_chart)) }
                }
            }
        }
    }
}
