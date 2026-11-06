package com.tradelens.app.core.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = BrandCyan,
    onPrimary = BrandBackground,
    // Must not equal any surface color: Compose picks a container's text color by matching its color to the scheme,
    // and a clash made all card text cyan.
    primaryContainer = Color(0xFF0A3B55),
    onPrimaryContainer = BrandCyan,
    secondary = Amber80,
    background = BrandBackground,
    onBackground = TextPrimary,
    surface = BrandSurface,
    onSurface = TextPrimary,
    onSurfaceVariant = TextSecondary,
    // Not equal to surfaceContainerHighest (cards): otherwise cards would take onSurfaceVariant (gray) as their text color.
    surfaceVariant = Color(0xFF16264F),
    surfaceContainerLowest = BrandBackground,
    surfaceContainerLow = BrandSurface,
    surfaceContainer = BrandSurface,
    surfaceContainerHigh = BrandSurfaceHigh,
    surfaceContainerHighest = BrandSurfaceHigh,
    outline = TextSecondary,
    error = SellRed,
)

private val LightColors = lightColorScheme(
    primary = Teal40,
    secondary = Amber40,
    background = Slate99,
    surface = Slate99,
    error = Red40,
)

/** Dark is the default (navy, cyan accent). */
@Composable
fun TradeLensTheme(darkTheme: Boolean = true, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalSpacing provides Spacing()) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = TradeLensTypography,
            content = content,
        )
    }
}
