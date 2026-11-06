package com.tradelens.app.ui.signals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.data.market.MarketConfig
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.ui.chart.formatPrice
import java.text.DateFormat
import java.util.Date

fun sideColor(side: String): Color = if (side == "BUY") Green80 else Red80

fun formatSignalTime(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(ms))

/** One signal: side chip, symbol, price, time, and optionally the plain-English reason. */
@Composable
fun SignalRow(signal: SignalDto, showReason: Boolean, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusChip(signal.side, sideColor(signal.side))
            Text(signal.symbol, style = MaterialTheme.typography.titleMedium)
            Text(formatPrice(signal.price, MarketConfig.decimals(signal.symbol)), style = MaterialTheme.typography.bodyLarge)
        }
        Text(
            "${signal.timeframe} · ${formatSignalTime(signal.createdAt)}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        if (showReason && !signal.reason.isNullOrBlank()) {
            Text(signal.reason, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
