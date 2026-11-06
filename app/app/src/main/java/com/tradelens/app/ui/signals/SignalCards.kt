package com.tradelens.app.ui.signals

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tradelens.app.R
import com.tradelens.app.core.alerts.SignalNotificationText
import com.tradelens.app.core.theme.Amber80
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.signals.DateRange
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.SignalStatsDto
import com.tradelens.app.ui.chart.formatPrice

/** The label for a status such as TP1_HIT. */
@Composable
fun statusLabel(status: String?): String = stringResource(
    when (status) {
        "TP1_HIT" -> R.string.status_tp1
        "TP2_HIT" -> R.string.status_tp2
        "TP3_HIT" -> R.string.status_tp3
        "SL_HIT" -> R.string.status_sl
        "BREAKEVEN_EXIT" -> R.string.status_breakeven
        "TIME_EXIT" -> R.string.status_time
        else -> R.string.status_open
    },
)

/** Green while a signal is running or won, red when stopped, amber for breakeven and time exits. */
fun statusColor(status: String?): Color = when (status) {
    "TP1_HIT", "TP2_HIT", "TP3_HIT" -> Green80
    "SL_HIT" -> Red80
    "BREAKEVEN_EXIT", "TIME_EXIT" -> Amber80
    else -> BrandCyan
}

fun resultColor(r: Double): Color = if (r > 0) Green80 else if (r < 0) Red80 else Amber80

private fun price(signal: SignalDto, value: Double?): String = formatPrice(value ?: 0.0, MarketConfig.decimals(signal.symbol))

/** One signal in the list: side badge, symbol, timeframe, score, status, then entry, SL, TP1-TP3 and the result when closed. */
@Composable
fun SignalCard(signal: SignalDto, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val spacing = LocalSpacing.current
    Card(modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(spacing.md), verticalArrangement = Arrangement.spacedBy(spacing.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
                StatusChip(signal.side, sideColor(signal.side))
                Text(signal.symbol, style = MaterialTheme.typography.titleMedium)
                Text(signal.timeframe, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                signal.score?.let { Text(stringResource(R.string.signal_score_short, it), style = MaterialTheme.typography.labelLarge, color = BrandCyan) }
            }
            if (signal.hasLevels) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    StatusChip(statusLabel(signal.status), statusColor(signal.status))
                    val result = signal.resultR
                    if (result != null) {
                        Text(SignalNotificationText.formatR(result), style = MaterialTheme.typography.titleMedium, color = resultColor(result))
                    }
                }
                Text("${stringResource(R.string.label_entry)} ${price(signal, signal.entry)}   ${stringResource(R.string.label_sl)} ${price(signal, signal.sl)}", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "TP1 ${price(signal, signal.tp1)}   TP2 ${price(signal, signal.tp2)}   TP3 ${price(signal, signal.tp3)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Green80,
                )
            } else {
                // Older signals have no levels: show the price and the plain-English reason.
                Text(price(signal, signal.price), style = MaterialTheme.typography.bodyLarge)
                if (!signal.reason.isNullOrBlank()) Text(signal.reason, style = MaterialTheme.typography.bodyMedium)
            }
            Text(formatSignalTime(signal.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
    }
}

/**
 * Win rate, open and total for everyone; average R and profit factor for Pro. Everyone else sees "Upgrade to Pro" in their place.
 */
@Composable
fun StatsCard(stats: SignalStatsDto?, modifier: Modifier = Modifier) {
    val spacing = LocalSpacing.current
    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(spacing.md), verticalArrangement = Arrangement.spacedBy(spacing.sm)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                Stat(stringResource(R.string.stat_win_rate), stats?.winRate?.let { "${trim(it)}%" } ?: "—")
                Stat(stringResource(R.string.stat_open), stats?.open?.toString() ?: "—")
                Stat(stringResource(R.string.stat_total), stats?.total?.toString() ?: "—")
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                if (stats?.isFull == true) {
                    Stat(stringResource(R.string.stat_avg_r), stats.avgR?.let { SignalNotificationText.formatR(it) } ?: "—")
                    Stat(stringResource(R.string.stat_profit_factor), stats.profitFactor?.let { trim(it) } ?: "—")
                } else if (stats != null) {
                    Stat(stringResource(R.string.stat_avg_r), stringResource(R.string.lock_upgrade_pro), locked = true)
                    Stat(stringResource(R.string.stat_profit_factor), stringResource(R.string.lock_upgrade_pro), locked = true)
                }
            }
        }
    }
}

private fun trim(v: Double): String = if (v == v.toLong().toDouble()) v.toLong().toString() else String.format(java.util.Locale.US, "%.1f", v)

@Composable
private fun Stat(label: String, value: String, locked: Boolean = false) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            value,
            style = if (locked) MaterialTheme.typography.labelMedium else MaterialTheme.typography.titleLarge,
            color = if (locked) Amber80 else MaterialTheme.colorScheme.onSurface,
        )
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
    }
}

/** A chip that opens a menu: used for the symbol, side, status and date range filters. */
@Composable
fun <T> FilterDropdown(label: String, selectedText: String?, options: List<Pair<String, T?>>, onSelect: (T?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        AssistChip(
            onClick = { open = true },
            label = { Text(if (selectedText == null) label else "$label: $selectedText") },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (text, value) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false })
            }
        }
    }
}

@Composable
fun rangeLabel(range: DateRange): String = stringResource(
    when (range) {
        DateRange.Any -> R.string.range_any
        DateRange.Last24Hours -> R.string.range_24h
        DateRange.Last7Days -> R.string.range_7d
        DateRange.Last30Days -> R.string.range_30d
    },
)
