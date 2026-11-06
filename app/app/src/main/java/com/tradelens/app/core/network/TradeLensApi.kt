package com.tradelens.app.core.network

import com.squareup.moshi.JsonClass
import com.tradelens.app.data.dashboard.DashboardResponse
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.SignalStatsDto
import com.tradelens.app.data.signals.SignalsResponse
import com.tradelens.app.data.market.CandlesResponse
import com.tradelens.app.data.market.Pivots
import com.tradelens.app.data.market.PriceResponse
import com.tradelens.app.data.settings.AlertsSettings
import com.tradelens.app.data.settings.AuthResponse
import com.tradelens.app.data.settings.ChartSettings
import com.tradelens.app.data.settings.DevLoginRequest
import com.tradelens.app.data.settings.GeneralSettings
import com.tradelens.app.data.settings.GoogleLoginRequest
import com.tradelens.app.data.settings.AdminServerDto
import com.tradelens.app.data.settings.SecretsStatusResponse
import com.tradelens.app.data.settings.TelegramStatus
import com.tradelens.app.data.settings.TelegramTestResponse
import com.tradelens.app.data.settings.SettingsResponse
import com.tradelens.app.data.settings.SignalsSettings
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

@JsonClass(generateAdapter = true)
data class HealthResponse(
    val status: String,
    val time: String,
    /** True when the server got a price update in the last 15 seconds. Null on an older server. */
    val live: Boolean? = null,
    val activeProvider: String? = null,
    /** Plain-English reason prices are missing, e.g. "Market data blocked from this server". */
    val reason: String? = null,
)

interface TradeLensApi {
    @GET("health")
    suspend fun health(): HealthResponse

    @GET("api/candles")
    suspend fun candles(
        @Query("symbol") symbol: String,
        @Query("interval") interval: String,
        @Query("limit") limit: Int,
    ): CandlesResponse

    @GET("api/price")
    suspend fun price(@Query("symbol") symbol: String): PriceResponse

    @GET("api/pivots")
    suspend fun pivots(@Query("symbol") symbol: String): Pivots

    @GET("api/dashboard")
    suspend fun dashboard(): DashboardResponse

    @GET("api/signals")
    suspend fun signals(
        @Query("limit") limit: Int,
        @Query("symbol") symbol: String?,
        @Query("offset") offset: Int,
        @Query("side") side: String?,
        @Query("status") status: String?,
        @Query("from") from: Long?,
    ): SignalsResponse

    @GET("api/signals/stats")
    suspend fun signalStats(@Query("symbol") symbol: String?, @Query("from") from: Long?): SignalStatsDto

    @GET("api/signals/{id}")
    suspend fun signal(@Path("id") id: String): SignalDto

    // ---- auth ----
    @POST("api/auth/google")
    suspend fun googleLogin(@Body body: GoogleLoginRequest): AuthResponse

    @POST("api/auth/dev-login")
    suspend fun devLogin(@Body body: DevLoginRequest): AuthResponse

    // ---- settings ----
    @GET("api/settings")
    suspend fun settings(): SettingsResponse

    @PUT("api/settings/signals")
    suspend fun putSignals(@Body body: SignalsSettings)

    @PUT("api/settings/chart")
    suspend fun putChart(@Body body: ChartSettings)

    @PUT("api/settings/alerts")
    suspend fun putAlerts(@Body body: AlertsSettings)

    @PUT("api/settings/general")
    suspend fun putGeneral(@Body body: GeneralSettings)

    // ---- secrets (admin only; values are write-only) ----
    @GET("api/settings/secrets/status")
    suspend fun secretsStatus(): SecretsStatusResponse

    @PUT("api/settings/secrets")
    suspend fun putSecrets(@Body body: Map<String, String>): SecretsStatusResponse

    // ---- admin server settings (admin only) ----
    @GET("api/admin/server")
    suspend fun adminServer(): AdminServerDto

    @PUT("api/admin/server/market-provider")
    suspend fun setMarketProvider(@Body body: Map<String, String>): Map<String, String>

    // ---- telegram ----
    @GET("api/telegram/status")
    suspend fun telegramStatus(): TelegramStatus

    @POST("api/telegram/test")
    suspend fun telegramTest(): TelegramTestResponse
}
