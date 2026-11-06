package com.tradelens.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import com.tradelens.app.core.theme.TradeLensTheme
import com.tradelens.app.ui.login.LoginScreen
import com.tradelens.app.ui.login.SplashScreen
import com.tradelens.app.ui.main.AppGate
import com.tradelens.app.ui.main.MainScaffold
import com.tradelens.app.ui.main.MainViewModel
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val mainViewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openChartIfRequested(intent)
        setContent {
            val prefs by mainViewModel.prefs.collectAsState()
            val gate by mainViewModel.gate.collectAsState()
            val dark = when (prefs?.theme) {
                "light" -> false
                "system" -> isSystemInDarkTheme()
                else -> true // dark is the default
            }
            TradeLensTheme(darkTheme = dark) {
                when (gate) {
                    AppGate.Loading -> SplashScreen()
                    AppGate.Login -> LoginScreen()
                    AppGate.Ready -> MainScaffold()
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Coming back (e.g. from the system notification settings): if the watcher is on, let it re-post its notification.
        mainViewModel.onNotificationPermissionChanged()
    }

    /** Tapping a signal notification while the app is already open arrives here (launchMode singleTop). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openChartIfRequested(intent)
    }

    private fun openChartIfRequested(intent: Intent?) {
        val symbol = intent?.getStringExtra(EXTRA_OPEN_SYMBOL) ?: return
        intent.removeExtra(EXTRA_OPEN_SYMBOL) // handle once, not again after a rotation
        mainViewModel.openChart(symbol)
    }

    companion object {
        /** Intent extra set by signal notifications: the symbol whose chart should open. */
        const val EXTRA_OPEN_SYMBOL = "open_symbol"
    }
}
