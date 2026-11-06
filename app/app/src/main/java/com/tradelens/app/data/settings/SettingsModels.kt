package com.tradelens.app.data.settings

import com.squareup.moshi.JsonClass

// ---- Server settings (mirror of server/src/settings/schema.ts) ----

@JsonClass(generateAdapter = true)
data class SignalsSettings(
    val emaFast: Int,
    val emaSlow: Int,
    val rsiPeriod: Int,
    val rsiBuyMin: Double,
    val rsiBuyMax: Double,
    val rsiSellAbove: Double,
    val cooldownMinutes: Int,
    val timeframe: String,
)

@JsonClass(generateAdapter = true)
data class SymbolsSettings(val enabled: List<String>)

@JsonClass(generateAdapter = true)
data class ChartSettings(
    val defaultSymbol: String,
    val defaultTimeframe: String,
    val showPivots: Boolean,
    val showVolume: Boolean,
    val showEma: Boolean,
)

@JsonClass(generateAdapter = true)
data class AlertsSettings(
    val sound: Boolean,
    val vibration: Boolean,
    val popup: Boolean,
    val backgroundService: Boolean,
)

@JsonClass(generateAdapter = true)
data class GeneralSettings(val language: String, val theme: String)

/** Guests only receive chart and alerts; the other sections are null for them. */
@JsonClass(generateAdapter = true)
data class ServerSettings(
    val signals: SignalsSettings? = null,
    val symbols: SymbolsSettings? = null,
    val chart: ChartSettings? = null,
    val alerts: AlertsSettings? = null,
    val general: GeneralSettings? = null,
)

@JsonClass(generateAdapter = true)
data class SettingsResponse(val role: String, val settings: ServerSettings)

@JsonClass(generateAdapter = true)
data class SecretsStatusResponse(val secrets: Map<String, Boolean>)

/** GET /api/admin/server (admin only): version, uptime and the market data source. Never any secret. */
@JsonClass(generateAdapter = true)
data class AdminServerDto(
    val version: String = "",
    val uptimeSeconds: Long = 0,
    val marketProvider: MarketProviderInfo = MarketProviderInfo(),
)

@JsonClass(generateAdapter = true)
data class MarketProviderInfo(
    /** The provider in use right now, e.g. "bybit". */
    val active: String = "",
    /** What is selected: auto, bybit, okx, kraken or binance. */
    val setting: String = "auto",
    val live: Boolean = false,
)

val MARKET_PROVIDERS = listOf("auto", "bybit", "okx", "kraken", "binance")

/** GET /api/telegram/status. Everyone gets the first three fields; the rest are sent to admins only. */
@JsonClass(generateAdapter = true)
data class TelegramStatus(
    val enabled: Boolean = false,
    val configured: Boolean = false,
    val channelLink: String = "",
    val lastSuccessAt: Long? = null,
    val postsLast24h: Int? = null,
    val failedPosts: Int? = null,
    val abandonedPosts: Int? = null,
) {
    /** Posting is on and both the bot token and the channel are set. */
    val active: Boolean get() = enabled && configured
}

@JsonClass(generateAdapter = true)
data class TelegramTestResponse(val ok: Boolean, val reason: String? = null)

// ---- Auth ----

@JsonClass(generateAdapter = true)
data class UserDto(val id: String, val email: String, val name: String, val role: String)

@JsonClass(generateAdapter = true)
data class AuthResponse(val token: String, val user: UserDto)

@JsonClass(generateAdapter = true)
data class GoogleLoginRequest(val idToken: String)

@JsonClass(generateAdapter = true)
data class DevLoginRequest(val userId: String, val name: String? = null)

/** The signed-in session kept on the phone. Role is refreshed from the server on every sync. */
data class Session(val token: String, val userId: String, val name: String, val email: String, val role: String)

// ---- Local-only preferences (DataStore) ----

data class LocalPrefs(
    val theme: String = "dark",
    val sound: Boolean = true,
    val vibration: Boolean = true,
    val popup: Boolean = true,
    val backgroundService: Boolean = true,
    /** Empty = use the build's default server URL. */
    val serverUrl: String = "",
    val defaultSymbol: String = "BTCUSDT",
    val defaultTimeframe: String = "1h",
    val showPivots: Boolean = true,
    val showVolume: Boolean = true,
    val showEma: Boolean = true,
)

/** Names of the secret keys the admin can write (values are never read back). */
val SECRET_KEYS = listOf("BINANCE_API_KEY", "BINANCE_API_SECRET")

/** Telegram values the admin can write. Same rule: written to the server, never read back or kept on the phone. */
const val KEY_TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN"
const val KEY_TELEGRAM_CHANNEL = "TELEGRAM_CHANNEL_ID"
const val KEY_TELEGRAM_ENABLED = "TELEGRAM_ENABLED"
