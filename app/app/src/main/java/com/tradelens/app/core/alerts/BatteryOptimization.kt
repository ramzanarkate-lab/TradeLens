package com.tradelens.app.core.alerts

import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings

/** Battery optimization can stop the background watcher on many phones. These helpers detect it and open the right screen. */
object BatteryOptimization {
    /** True when the system will NOT restrict this app's background work. */
    fun isIgnoring(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** The system list where the user can set TradeLens to "Not optimized" / "Unrestricted". */
    fun settingsIntent(): Intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Fallback if the device has no such screen: the app's own details page. */
    fun appDetailsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
