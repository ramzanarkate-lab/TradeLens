package com.tradelens.app.data.signals

import com.squareup.moshi.JsonClass

/** One step in a signal's life: OPEN, TP1_HIT, ..., with the price and the R-multiple at that moment. */
@JsonClass(generateAdapter = true)
data class StatusChangeDto(
    val status: String,
    /** Epoch millis. */
    val at: Long,
    val price: Double,
    val resultR: Double? = null,
)

/**
 * A trading signal as the server sends it. Older signals (and servers) have no levels, so everything from `mode` down is optional.
 */
@JsonClass(generateAdapter = true)
data class SignalDto(
    val id: String,
    val symbol: String,
    /** "BUY" or "SELL". */
    val side: String,
    val timeframe: String,
    val price: Double,
    val trigger: String? = null,
    val reason: String? = null,
    /** Close time of the candle that produced the signal, epoch millis. */
    val createdAt: Long,
    /** True for sample signals (Test Alert). They go through the same alert path but are never stored. */
    val test: Boolean = false,
    /** "paper" or "live". */
    val mode: String? = null,
    /** 0 to 100. */
    val score: Int? = null,
    /** One line per rule that passed. */
    val reasons: List<String>? = null,
    val entry: Double? = null,
    val sl: Double? = null,
    val tp1: Double? = null,
    val tp2: Double? = null,
    val tp3: Double? = null,
    val riskPercent: Double? = null,
    val rrTp1: Double? = null,
    val rrTp2: Double? = null,
    val rrTp3: Double? = null,
    /** OPEN, TP1_HIT, TP2_HIT, TP3_HIT, SL_HIT, BREAKEVEN_EXIT or TIME_EXIT. */
    val status: String? = null,
    val statusHistory: List<StatusChangeDto>? = null,
    val closedAt: Long? = null,
    /** Final R-multiple once the signal is closed. */
    val resultR: Double? = null,
) {
    /** True when the server sent entry, stop and targets (signals from the multi-indicator engine). */
    val hasLevels: Boolean get() = entry != null && sl != null && tp1 != null && tp2 != null && tp3 != null

    /** Still running: OPEN, TP1_HIT or TP2_HIT. */
    val isActive: Boolean get() = status == null || status in ACTIVE_STATUSES
}

val ACTIVE_STATUSES = setOf("OPEN", "TP1_HIT", "TP2_HIT")

@JsonClass(generateAdapter = true)
data class SignalsResponse(
    val signals: List<SignalDto>,
    /** How many of the newest signals this account may read (guests 5, everyone signed in: all). */
    val cap: Int = 0,
    /** "guest", "user", "pro" or "admin", as the server sees this request. */
    val role: String = "guest",
    val total: Int = 0,
    val limit: Int = 0,
    val offset: Int = 0,
    val hasMore: Boolean = false,
    /** True for guests when more signals exist than they may see. */
    val locked: Boolean = false,
)

/** A page of signals plus how far the account can see. */
data class SignalsPage(
    val signals: List<SignalDto>,
    val cap: Int,
    val role: String,
    val total: Int = signals.size,
    val hasMore: Boolean = false,
    val locked: Boolean = false,
)

/** What the Signals screen is filtered by. Null = no filter on that field. */
data class SignalFilters(
    val symbol: String? = null,
    val side: String? = null,
    val status: String? = null,
    val range: DateRange = DateRange.Any,
)

enum class DateRange(val millis: Long?) {
    Any(null),
    Last24Hours(24L * 3_600_000),
    Last7Days(7L * 24 * 3_600_000),
    Last30Days(30L * 24 * 3_600_000),
}

/**
 * GET /api/signals/stats. Everyone gets tier, total, open, closed, wins and winRate ("basic"); pro and admin also get the
 * rest ("full"). The extra fields are null for basic accounts.
 */
@JsonClass(generateAdapter = true)
data class SignalStatsDto(
    val tier: String = "basic",
    val total: Int = 0,
    val open: Int = 0,
    val closed: Int = 0,
    val wins: Int = 0,
    val winRate: Double? = null,
    val avgR: Double? = null,
    val profitFactor: Double? = null,
    val maxDrawdownR: Double? = null,
    val countByStatus: Map<String, Int>? = null,
) {
    val isFull: Boolean get() = tier == "full"
}

/** Which lock message applies to a list: guests are told to sign in, users to upgrade, pro and admin see no lock. */
enum class SignalLock { SignIn, Pro }

/**
 * A lock is shown only when the list is full for the account (shown >= cap): with fewer signals than the cap there is
 * nothing hidden. Pro and admin never see one.
 */
fun lockFor(role: String, cap: Int, shown: Int): SignalLock? = when {
    cap <= 0 || shown < cap -> null
    role == "guest" -> SignalLock.SignIn
    role == "user" -> SignalLock.Pro
    else -> null
}
