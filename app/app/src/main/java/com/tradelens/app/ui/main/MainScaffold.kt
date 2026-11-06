package com.tradelens.app.ui.main

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import com.tradelens.app.core.ui.BrandHeader
import com.tradelens.app.core.ui.BrandSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.tradelens.app.R
import com.tradelens.app.core.theme.Amber80
import com.tradelens.app.core.theme.Green80
import com.tradelens.app.core.theme.Red80
import com.tradelens.app.core.ui.StatusChip
import com.tradelens.app.state.ConnectionStatus
import androidx.compose.runtime.LaunchedEffect
import com.tradelens.app.ui.alerts.AlertPopupHost
import com.tradelens.app.ui.alerts.rememberAskNotificationPermission
import com.tradelens.app.ui.navigation.Routes
import com.tradelens.app.ui.navigation.TradeLensNavHost

private data class Tab(val route: String, val pattern: String, val labelRes: Int, val icon: ImageVector)

private val tabs = listOf(
    Tab(Routes.DASHBOARD, Routes.DASHBOARD, R.string.nav_dashboard, Icons.Filled.Home),
    Tab(Routes.chart(Routes.AUTO_SYMBOL), Routes.CHART_PATTERN, R.string.nav_chart, Icons.Filled.Search),
    Tab(Routes.SIGNALS, Routes.SIGNALS_PATTERN, R.string.nav_signals, Icons.Filled.Notifications),
    Tab(Routes.SETTINGS, Routes.SETTINGS, R.string.nav_settings, Icons.Filled.Settings),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScaffold(viewModel: MainViewModel = hiltViewModel()) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val destination = backStack?.destination
    val status by viewModel.appState.connectionStatus.collectAsStateWithLifecycle()
    val chartSymbol by viewModel.appState.chartSymbol.collectAsStateWithLifecycle()
    val onChart = destination?.route == Routes.CHART_PATTERN

    // A popup's "View Chart" or a tapped notification asks for a chart to be opened.
    val pendingChart by viewModel.pendingChart.collectAsStateWithLifecycle()
    LaunchedEffect(pendingChart) {
        pendingChart?.let { symbol ->
            // If a chart is already on top, replace it: reusing it would keep showing the old symbol.
            if (navController.currentDestination?.route == Routes.CHART_PATTERN) navController.popBackStack()
            navController.navigate(Routes.chart(symbol))
            viewModel.consumePendingChart()
        }
    }

    // First launch: explain why notifications matter, then ask (Android 13+). Asked once; Settings can ask again.
    val promptDone by viewModel.notificationPromptDone.collectAsStateWithLifecycle()
    val askForNotifications = rememberAskNotificationPermission { viewModel.markNotificationPromptDone() }
    LaunchedEffect(promptDone) {
        if (promptDone == false) askForNotifications()
    }

    AlertPopupHost(viewModel.alertQueue, onViewChart = viewModel::openChart)

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                // The emblem + "TradeLens" on every screen; on the chart screen the symbol replaces the name.
                title = { BrandHeader(BrandSize.Compact, label = if (onChart) chartSymbol else null) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                actions = {
                    val (label, color) = when (status) {
                        ConnectionStatus.Live -> R.string.status_live to Green80
                        ConnectionStatus.Reconnecting -> R.string.status_reconnecting to Amber80
                        ConnectionStatus.Offline -> R.string.status_offline to Red80
                    }
                    StatusChip(stringResource(label), color, Modifier.padding(end = 12.dp))
                },
            )
        },
        bottomBar = {
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = destination?.hierarchy?.any { it.route == tab.pattern } == true,
                        onClick = {
                            if (tab.route == Routes.DASHBOARD) {
                                // The dashboard is the start destination and can have a chart/signal opened on top of it
                                // (from a card or row). Saving and restoring that stack would bring the chart back, so
                                // this tab just pops back to the dashboard.
                                navController.popBackStack(Routes.DASHBOARD, inclusive = false)
                            } else {
                                navController.navigate(tab.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = null) },
                        label = { Text(stringResource(tab.labelRes)) },
                    )
                }
            }
        },
    ) { padding ->
        TradeLensNavHost(navController, Modifier.padding(padding))
    }
}
