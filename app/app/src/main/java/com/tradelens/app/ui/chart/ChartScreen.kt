package com.tradelens.app.ui.chart

import android.content.res.Configuration
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tradelens.app.R
import com.tradelens.app.core.network.AppError
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.LocalSpacing
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.ErrorCard
import com.tradelens.app.core.ui.LoadingSkeleton
import com.tradelens.app.data.market.MarketConfig

@Composable
fun ChartScreen(viewModel: ChartViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val spacing = LocalSpacing.current
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    LaunchedEffect(state.symbol) { viewModel.publishSymbol() } // the top app bar shows the symbol

    if (landscape) {
        // Controls in a scrollable side panel so the chart keeps the full height.
        Row(Modifier.fillMaxSize().padding(spacing.sm), horizontalArrangement = Arrangement.spacedBy(spacing.md)) {
            Column(
                Modifier.width(300.dp).fillMaxHeight().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(spacing.sm),
            ) { Controls(state, viewModel, wrap = true) }
            ChartArea(state, viewModel, Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(
            Modifier.fillMaxSize().padding(horizontal = spacing.md, vertical = spacing.sm),
            verticalArrangement = Arrangement.spacedBy(spacing.sm),
        ) {
            Controls(state, viewModel, wrap = false)
            ChartArea(state, viewModel, Modifier.weight(1f).fillMaxWidth())
        }
    }
}

@Composable
private fun Controls(state: ChartUiState, viewModel: ChartViewModel, wrap: Boolean) {
    val spacing = LocalSpacing.current
    val decimals = MarketConfig.decimals(state.symbol)

    ChipRow(wrap) {
        MarketConfig.symbols.forEach { s ->
            FilterChip(selected = s == state.symbol, onClick = { viewModel.selectSymbol(s) }, label = { Text(s) })
        }
    }

    // Header: price (live) and 24h change
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(spacing.sm)) {
        Text(
            text = state.price?.let { formatPrice(it, decimals) } ?: "—",
            style = MaterialTheme.typography.headlineSmall,
        )
        state.changePercent24h?.let { change ->
            val sign = if (change >= 0) "+" else ""
            Text(
                text = "$sign${formatPrice(change, 2)}%",
                style = MaterialTheme.typography.titleMedium,
                color = if (change >= 0) Green80 else Red80,
            )
        }
    }

    ChipRow(wrap) {
        MarketConfig.timeframes.forEach { tf ->
            FilterChip(selected = tf == state.timeframe, onClick = { viewModel.selectTimeframe(tf) }, label = { Text(tf) })
        }
    }

    ChipRow(wrap) {
        FilterChip(state.showPivots, { viewModel.setShowPivots(!state.showPivots) }, { Text(stringResource(R.string.toggle_pivots)) })
        FilterChip(state.showVolume, { viewModel.setShowVolume(!state.showVolume) }, { Text(stringResource(R.string.toggle_volume)) })
        FilterChip(state.showEma20, { viewModel.setShowEma20(!state.showEma20) }, { Text(stringResource(R.string.toggle_ema20)) })
        FilterChip(state.showEma50, { viewModel.setShowEma50(!state.showEma50) }, { Text(stringResource(R.string.toggle_ema50)) })
    }
}

@Composable
private fun ChartArea(state: ChartUiState, viewModel: ChartViewModel, modifier: Modifier) {
    val spacing = LocalSpacing.current
    when {
        state.error != null -> ErrorCard(message = errorMessage(state.error), onRetry = viewModel::retry, modifier = modifier)
        state.loading || state.candles.isEmpty() -> LoadingSkeleton(modifier.padding(top = spacing.md), lines = 8)
        else -> CandleChart(
            candles = state.candles,
            pivots = state.pivots,
            showPivots = state.showPivots,
            showVolume = state.showVolume,
            showEma20 = state.showEma20,
            showEma50 = state.showEma50,
            decimals = MarketConfig.decimals(state.symbol),
            timeframe = state.timeframe,
            resetKey = state.symbol to state.timeframe,
            modifier = modifier,
            signal = state.signal,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipRow(wrap: Boolean, content: @Composable () -> Unit) {
    val gap = LocalSpacing.current.sm
    if (wrap) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) { content() }
    } else {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}

@Composable
private fun errorMessage(error: AppError): String = when (error) {
    AppError.Network -> stringResource(R.string.error_network)
    is AppError.Http -> stringResource(R.string.error_server, error.code)
    is AppError.Unknown -> stringResource(R.string.error_unknown)
}
