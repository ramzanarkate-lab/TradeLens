package com.tradelens.app.core.di

import okhttp3.OkHttpClient

object DebugNetwork {
    @Suppress("UNUSED_PARAMETER")
    fun addLogging(builder: OkHttpClient.Builder) = Unit
}
