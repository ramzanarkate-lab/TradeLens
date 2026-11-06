package com.tradelens.app.ui.navigation

object Routes {
    const val DASHBOARD = "dashboard"
    const val CHART_PATTERN = "chart/{symbol}"
    const val SIGNALS = "signals"
    const val SIGNALS_PATTERN = "signals?signalId={signalId}"
    const val SETTINGS = "settings"

    const val ARG_SYMBOL = "symbol"
    const val ARG_SIGNAL_ID = "signalId"

    const val DEFAULT_SYMBOL = "BTCUSDT"

    /** The Chart tab uses this: "no symbol was asked for, follow the default from Settings". */
    const val AUTO_SYMBOL = "auto"

    fun chart(symbol: String) = "chart/$symbol"

    /** The signals list, optionally showing only one signal. */
    fun signals(signalId: String? = null) = if (signalId == null) SIGNALS else "signals?signalId=$signalId"
}
