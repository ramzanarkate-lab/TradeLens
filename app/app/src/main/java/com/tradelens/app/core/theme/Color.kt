package com.tradelens.app.core.theme

import androidx.compose.ui.graphics.Color

// ---- TradeLens brand palette (dark theme; mirrors res/values/colors.xml) ----
val BrandBackground = Color(0xFF050B1F)
val BrandSurface = Color(0xFF0B1630)
/** Slightly lighter than the surface: raised cards, skeleton blocks. */
val BrandSurfaceHigh = Color(0xFF13224A)
val BrandCyan = Color(0xFF00E5FF)
val BuyGreen = Color(0xFF22C55E)
val SellRed = Color(0xFFEF4444)
val TextPrimary = Color(0xFFFFFFFF)
val TextSecondary = Color(0xFF9CA3AF)

// ---- Names used across the screens ----
/** BUY / up / positive. */
val Green80 = BuyGreen
/** SELL / down / negative / error. */
val Red80 = SellRed
val Amber80 = Color(0xFFFFC857)

// ---- Light theme keeps neutral Material-style values ----
val Teal40 = Color(0xFF00796B)
val Slate99 = Color(0xFFF6F8FA)
val Amber40 = Color(0xFF8A6100)
val Red40 = Color(0xFFB3261E)
val Green40 = Color(0xFF1B7F3B)
