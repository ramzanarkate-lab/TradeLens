package com.tradelens.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.tradelens.app.ui.chart.ChartScreen
import com.tradelens.app.ui.dashboard.DashboardScreen
import com.tradelens.app.ui.settings.SettingsScreen
import com.tradelens.app.ui.signals.SignalsScreen

@Composable
fun TradeLensNavHost(navController: NavHostController, modifier: Modifier = Modifier) {
    NavHost(navController, startDestination = Routes.DASHBOARD, modifier = modifier) {
        composable(Routes.DASHBOARD) {
            DashboardScreen(
                onOpenChart = { symbol -> navController.navigate(Routes.chart(symbol)) },
                onOpenSignal = { id -> navController.navigate(Routes.signals(id)) },
                onCheckServer = { navController.navigate(Routes.SETTINGS) { launchSingleTop = true } },
            )
        }
        composable(
            Routes.CHART_PATTERN,
            arguments = listOf(
                navArgument(Routes.ARG_SYMBOL) {
                    type = NavType.StringType
                    defaultValue = Routes.AUTO_SYMBOL
                },
            ),
        ) {
            // The symbol argument is read by ChartViewModel from its SavedStateHandle.
            ChartScreen()
        }
        composable(
            Routes.SIGNALS_PATTERN,
            arguments = listOf(
                navArgument(Routes.ARG_SIGNAL_ID) {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) {
            // The signalId argument (if any) is read by SignalsViewModel from its SavedStateHandle.
            SignalsScreen()
        }
        composable(Routes.SETTINGS) { SettingsScreen() }
    }
}
