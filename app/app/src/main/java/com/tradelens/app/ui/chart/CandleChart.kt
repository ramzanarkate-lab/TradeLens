package com.tradelens.app.ui.chart

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.data.market.Candle
import com.tradelens.app.data.market.Pivots
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private val Ema20Color = Color(0xFFFFC857)
private val Ema50Color = Color(0xFF64B5F6)
private val PivotGray = Color(0xFFB0B7BE)
private const val MIN_VISIBLE = 10f
private const val DEFAULT_VISIBLE = 60f

private class PivotLine(val label: String, val value: Double, val color: Color)

/** Entry, stop and targets of a running signal, drawn as labeled horizontal lines. */
data class ChartSignal(val entry: Double, val sl: Double, val tp1: Double, val tp2: Double, val tp3: Double)

/**
 * Candlestick chart with optional volume bars, EMA lines and labeled pivot lines.
 * Pinch to zoom, drag to scroll. Drawn on a Canvas so candles, volume, pivots and EMAs share one x/y mapping.
 */
@Composable
fun CandleChart(
    candles: List<Candle>,
    pivots: Pivots?,
    showPivots: Boolean,
    showVolume: Boolean,
    showEma20: Boolean,
    showEma50: Boolean,
    decimals: Int,
    timeframe: String,
    resetKey: Any,
    modifier: Modifier = Modifier,
    signal: ChartSignal? = null,
) {
    val measurer = rememberTextMeasurer()
    var visible by rememberSaveable(resetKey) { mutableFloatStateOf(DEFAULT_VISIBLE) }
    var offset by rememberSaveable(resetKey) { mutableFloatStateOf(0f) } // candles scrolled back from the newest
    val latestCandles by rememberUpdatedState(candles)
    val ema20 = remember(candles) { ema(candles.map { it.close }, 20) }
    val ema50 = remember(candles) { ema(candles.map { it.close }, 50) }
    val gridColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f)
    val textColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f)

    Canvas(
        modifier
            .fillMaxSize()
            .pointerInput(resetKey) {
                detectTransformGestures { _, pan, zoom, _ ->
                    val n = latestCandles.size
                    if (n == 0) return@detectTransformGestures
                    val plotWidth = size.width - AXIS_WIDTH.dp.toPx()
                    val newVisible = (visible / zoom).coerceIn(MIN_VISIBLE, max(MIN_VISIBLE, n.toFloat()))
                    val candleWidth = plotWidth / newVisible
                    visible = newVisible
                    offset = (offset + pan.x / candleWidth).coerceIn(0f, max(0f, n - newVisible))
                }
            },
    ) {
        if (candles.isEmpty()) return@Canvas
        drawChart(
            measurer, candles, pivots, showPivots, showVolume, showEma20, showEma50, ema20, ema50,
            visible, offset, decimals, timeframe, gridColor, textColor, signal,
        )
    }
}

private const val AXIS_WIDTH = 92

private fun DrawScope.drawChart(
    measurer: TextMeasurer,
    candles: List<Candle>,
    pivots: Pivots?,
    showPivots: Boolean,
    showVolume: Boolean,
    showEma20: Boolean,
    showEma50: Boolean,
    ema20: List<Double>,
    ema50: List<Double>,
    visibleF: Float,
    offsetF: Float,
    decimals: Int,
    timeframe: String,
    gridColor: Color,
    textColor: Color,
    signal: ChartSignal?,
) {
    val n = candles.size
    val count = visibleF.roundToInt().coerceIn(1, max(1, n))
    val endIdx = (n - offsetF.roundToInt()).coerceIn(1, n) // exclusive
    val slotStart = endIdx - count // index shown in the first slot (may be < 0 when few candles)
    val startIdx = max(0, slotStart)

    val axisW = AXIS_WIDTH.dp.toPx()
    val topPad = 8.dp.toPx()
    val timeH = 20.dp.toPx()
    val gap = 6.dp.toPx()
    val plotW = size.width - axisW
    val volH = if (showVolume) (size.height - topPad - timeH) * 0.2f else 0f
    val priceH = size.height - topPad - timeH - volH - (if (showVolume) gap else 0f)
    val priceTop = topPad
    val priceBottom = priceTop + priceH
    val volTop = priceBottom + gap
    val candleW = plotW / count
    val bodyW = max(1f, candleW * 0.7f)
    fun cx(i: Int) = (i - slotStart + 0.5f) * candleW

    val shown = candles.subList(startIdx, endIdx)
    val pivotLines = if (showPivots && pivots != null) {
        listOf(
            PivotLine("R3", pivots.r3, Green80), PivotLine("R2", pivots.r2, Green80), PivotLine("R1", pivots.r1, Green80),
            PivotLine("P", pivots.p, PivotGray),
            PivotLine("S1", pivots.s1, Red80), PivotLine("S2", pivots.s2, Red80), PivotLine("S3", pivots.s3, Red80),
        )
    } else {
        emptyList()
    }
    // Signal levels: entry in cyan, stop in red, targets in green. Always shown while a signal is running.
    val signalLines = if (signal != null) {
        listOf(
            PivotLine("ENTRY", signal.entry, BrandCyan),
            PivotLine("SL", signal.sl, Red80),
            PivotLine("TP1", signal.tp1, Green80), PivotLine("TP2", signal.tp2, Green80), PivotLine("TP3", signal.tp3, Green80),
        )
    } else {
        emptyList()
    }
    val lines = pivotLines + signalLines

    // Price range: visible candles plus all pivot lines (so every line is on screen), with padding.
    var hi = shown.maxOf { it.high }
    var lo = shown.minOf { it.low }
    lines.forEach { hi = max(hi, it.value); lo = min(lo, it.value) }
    val pad = max((hi - lo) * 0.04, 1e-9)
    hi += pad
    lo -= pad
    fun y(price: Double) = priceTop + ((hi - price) / (hi - lo)).toFloat() * priceH

    val labelStyle = TextStyle(fontSize = 10.sp, color = textColor)

    // Grid + left price labels
    for (t in 0..3) {
        val price = hi - (hi - lo) * t / 3.0
        val yy = y(price)
        drawLine(gridColor, Offset(0f, yy), Offset(plotW, yy), 1f)
        drawText(measurer, formatPrice(price, decimals), Offset(4.dp.toPx(), yy + 1.dp.toPx()), labelStyle)
    }

    // Volume bars
    if (showVolume) {
        val maxVol = max(shown.maxOf { it.volume }, 1e-9)
        for (i in startIdx until endIdx) {
            val c = candles[i]
            val h = (c.volume / maxVol).toFloat() * volH
            val color = (if (c.close >= c.open) Green80 else Red80).copy(alpha = 0.5f)
            drawRect(color, Offset(cx(i) - bodyW / 2, volTop + volH - h), Size(bodyW, h))
        }
    }

    // Candles
    for (i in startIdx until endIdx) {
        val c = candles[i]
        val color = if (c.close >= c.open) Green80 else Red80
        val x = cx(i)
        drawLine(color, Offset(x, y(c.high)), Offset(x, y(c.low)), max(1f, 1.dp.toPx()))
        val top = y(max(c.open, c.close))
        val bottom = y(min(c.open, c.close))
        drawRect(color, Offset(x - bodyW / 2, top), Size(bodyW, max(1f, bottom - top)))
    }

    // EMAs
    fun drawEma(values: List<Double>, color: Color) {
        val path = Path()
        var started = false
        for (i in startIdx until endIdx) {
            val v = values[i]
            if (v.isNaN()) continue
            if (!started) { path.moveTo(cx(i), y(v)); started = true } else path.lineTo(cx(i), y(v))
        }
        if (started) drawPath(path, color, style = Stroke(width = 1.5.dp.toPx()))
    }
    if (showEma20) drawEma(ema20, Ema20Color)
    if (showEma50) drawEma(ema50, Ema50Color)

    // Pivot lines, labeled on the right edge
    val dash = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))
    for (line in lines) {
        val yy = y(line.value)
        drawLine(line.color.copy(alpha = 0.85f), Offset(0f, yy), Offset(plotW, yy), 1.dp.toPx(), pathEffect = dash)
        val text = "${line.label} ${formatPrice(line.value, decimals)}"
        val layout = measurer.measure(text, TextStyle(fontSize = 10.sp, color = line.color))
        val lx = size.width - layout.size.width - 4.dp.toPx()
        drawRect(Color.Black.copy(alpha = 0.55f), Offset(lx - 2.dp.toPx(), yy - layout.size.height / 2f), Size(layout.size.width + 4.dp.toPx(), layout.size.height.toFloat()))
        drawText(layout, topLeft = Offset(lx, yy - layout.size.height / 2f))
    }

    // Time labels
    val format = if (timeframe == "1d") DateTimeFormatter.ofPattern("MMM d") else DateTimeFormatter.ofPattern("HH:mm")
    val zone = ZoneId.systemDefault()
    for (t in 0..3) {
        val i = (startIdx + (endIdx - 1 - startIdx) * t / 3).coerceIn(0, n - 1)
        val label = format.format(Instant.ofEpochMilli(candles[i].time).atZone(zone))
        val layout = measurer.measure(label, labelStyle)
        val x = (cx(i) - layout.size.width / 2f).coerceIn(0f, plotW - layout.size.width)
        drawText(layout, topLeft = Offset(x, size.height - timeH + 3.dp.toPx()))
    }
}
