package com.tradelens.app.core.di

import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

object DebugNetwork {
    fun addLogging(builder: OkHttpClient.Builder) {
        builder.addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
    }
}
