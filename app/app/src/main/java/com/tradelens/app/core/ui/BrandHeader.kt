package com.tradelens.app.core.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tradelens.app.R
import com.tradelens.app.core.theme.BrandCyan
import com.tradelens.app.core.theme.TextPrimary

/** The two sizes the brand header is used at. */
enum class BrandSize(val emblemHeight: Dp, val textSize: TextUnit, val gap: Dp) {
    /** Top app bar: emblem 32dp, text 18sp. */
    Compact(32.dp, 18.sp, 8.dp),

    /** Splash and login: emblem 120dp, text 36sp. */
    Large(120.dp, 36.sp, 16.dp),
}

/** "Trade" in white and "Lens" in cyan: the name is drawn as live text, never taken from the logo image. */
fun brandWordmark(): androidx.compose.ui.text.AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(color = TextPrimary)) { append("Trade") }
    withStyle(SpanStyle(color = BrandCyan)) { append("Lens") }
}

/**
 * The TradeLens emblem followed by the name. [label] replaces the name (e.g. the symbol on the chart screen)
 * while the emblem stays. In [BrandSize.Large] the emblem sits above the name; in [BrandSize.Compact] beside it.
 */
@Composable
fun BrandHeader(size: BrandSize, modifier: Modifier = Modifier, label: String? = null) {
    val emblem: @Composable () -> Unit = {
        Image(
            painter = painterResource(R.drawable.tradelens_emblem),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.height(size.emblemHeight).aspectRatio(EMBLEM_ASPECT),
        )
    }
    val name: @Composable () -> Unit = {
        if (label != null) {
            Text(label, color = TextPrimary, fontSize = size.textSize, fontWeight = FontWeight.Bold, fontFamily = FontFamily.SansSerif)
        } else {
            Text(brandWordmark(), fontSize = size.textSize, fontWeight = FontWeight.Bold, fontFamily = FontFamily.SansSerif)
        }
    }
    when (size) {
        BrandSize.Compact -> Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(size.gap)) {
            emblem()
            name()
        }
        BrandSize.Large -> androidx.compose.foundation.layout.Column(
            modifier,
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(size.gap),
        ) {
            emblem()
            name()
        }
    }
}

/** Width : height of tradelens_emblem.png (760 x 527). */
private const val EMBLEM_ASPECT = 760f / 527f
