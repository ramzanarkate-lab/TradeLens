package com.tradelens.app.data.market

import com.tradelens.app.data.signals.SignalDto
import com.tradelens.app.state.AppState
import com.tradelens.app.state.ConnectionStatus
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton

/** Live pushes from the server's /ws endpoint. Each collector opens its own connection and closes it when it stops. */
@Singleton
class MarketSocket @Inject constructor(
    client: OkHttpClient,
    private val appState: AppState,
) {
    /** Sockets currently connected (the chart and the dashboard can each have one). */
    private val openSockets = AtomicInteger(0)

    // WebSockets idle between messages, so the normal read timeout must not apply; ping keeps the link alive.
    private val wsClient = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS).build()

    /** Emits every 1m candle update for [symbol]. */
    fun candleUpdates(symbol: String): Flow<Candle> =
        events(listOf("candles:$symbol")).filterIsInstance<LiveEvent.CandleUpdate>().map { it.candle }

    /** New signals only (topic "signals"). Used by the alert popup and the background service. */
    fun signalEvents(): Flow<SignalDto> =
        events(listOf("signals")).filterIsInstance<LiveEvent.SignalEvent>().map { it.signal }

    /** New signals and status changes of running signals (topic "signals"). Used by the alerts and the background service. */
    fun signalFeed(): Flow<LiveEvent> =
        events(listOf("signals")).filter { it is LiveEvent.SignalEvent || it is LiveEvent.SignalUpdate }

    /** Candle updates for the given symbols plus new signals. */
    fun dashboardEvents(symbols: List<String>): Flow<LiveEvent> = events(symbols.map { "candles:$it" } + "signals")

    /** Subscribes to [topics]; reconnects with backoff (1s..30s) until collection stops. Keeps the Live/Reconnecting chip honest. */
    private fun events(topics: List<String>): Flow<LiveEvent> = callbackFlow {
        val url = appState.serverUrl.value.trimEnd('/') + "/ws"
        // Set when the collector stops on purpose: OkHttp then reports "Canceled" as a failure, which is not a lost connection.
        val cancelled = AtomicBoolean(false)
        val opened = AtomicBoolean(false)

        fun lost() {
            if (opened.compareAndSet(true, false)) openSockets.decrementAndGet()
            // Only report a problem if this was not intentional and no other socket is still connected.
            if (!cancelled.get() && openSockets.get() == 0) appState.setConnectionStatus(ConnectionStatus.Reconnecting)
        }

        val socket = wsClient.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    topics.forEach { webSocket.send("""{"type":"subscribe","topic":"$it"}""") }
                    if (opened.compareAndSet(false, true)) openSockets.incrementAndGet()
                    appState.setConnectionStatus(ConnectionStatus.Live)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    LiveMessages.parse(text)?.let { trySend(it) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    lost()
                    close(IOException("socket failure: ${t.message}", t))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    lost()
                    close(IOException("socket closed ($code)"))
                }
            },
        )
        awaitClose {
            cancelled.set(true)
            socket.cancel()
            if (opened.compareAndSet(true, false)) openSockets.decrementAndGet()
        }
    }.retryWhen { _, attempt ->
        delay(minOf(30_000L, 1_000L shl attempt.toInt().coerceAtMost(5)))
        true
    }
}
