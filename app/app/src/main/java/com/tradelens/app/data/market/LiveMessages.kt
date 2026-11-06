package com.tradelens.app.data.market

import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.data.signals.StatusChangeDto

/** Something pushed by the server over /ws. */
sealed interface LiveEvent {
    /** A 1m candle update for [symbol] (topic "candles:<symbol>"). */
    data class CandleUpdate(val symbol: String, val candle: Candle) : LiveEvent

    /** A new signal (topic "signals", event "signal"). */
    data class SignalEvent(val signal: SignalDto) : LiveEvent

    /** A running signal changed status (event "signalUpdate"): TP1_HIT, SL_HIT, ... */
    data class SignalUpdate(val signal: SignalDto, val change: StatusChangeDto) : LiveEvent
}

@JsonClass(generateAdapter = true)
internal data class WsHeader(val type: String?, val topic: String?)

@JsonClass(generateAdapter = true)
internal data class CandleData(val symbol: String?, val candle: Candle?)

@JsonClass(generateAdapter = true)
internal data class CandleMessage(val data: CandleData?)

@JsonClass(generateAdapter = true)
internal data class SignalData(val event: String?, val signal: SignalDto?, val change: StatusChangeDto? = null)

@JsonClass(generateAdapter = true)
internal data class SignalMessage(val data: SignalData?)

object LiveMessages {
    private val moshi = Moshi.Builder().build()
    private val header = moshi.adapter(WsHeader::class.java)
    private val candle = moshi.adapter(CandleMessage::class.java)
    private val signal = moshi.adapter(SignalMessage::class.java)

    /** Parses one text frame. Acknowledgements, errors and anything malformed give null. */
    fun parse(text: String): LiveEvent? = runCatching {
        val h = header.fromJson(text) ?: return null
        if (h.type != "message") return null
        val topic = h.topic ?: return null
        when {
            topic.startsWith("candles:") -> {
                val data = candle.fromJson(text)?.data ?: return null
                val c = data.candle ?: return null
                LiveEvent.CandleUpdate(data.symbol ?: topic.removePrefix("candles:"), c)
            }
            topic == "signals" -> {
                val data = signal.fromJson(text)?.data ?: return null
                when (data.event) {
                    "signal" -> LiveEvent.SignalEvent(data.signal ?: return null)
                    "signalUpdate" -> LiveEvent.SignalUpdate(data.signal ?: return null, data.change ?: return null)
                    else -> return null
                }
            }
            else -> null
        }
    }.getOrNull()
}
