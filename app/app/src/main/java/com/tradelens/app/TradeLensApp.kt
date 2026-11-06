package com.tradelens.app

import android.app.Application
import com.tradelens.app.core.alerts.BackgroundServiceController
import com.tradelens.app.core.alerts.NotificationChannels
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class TradeLensApp : Application() {
    @Inject lateinit var backgroundService: BackgroundServiceController

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.ensure(this)
        backgroundService.start() // starts/stops the watcher as the setting and sign-in state change
    }
}
