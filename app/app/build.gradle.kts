import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// Signing details and the release server URL live in local.properties, which is never committed.
// See local.properties.example for the keys.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.tradelens.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.tradelens.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"

        // Web OAuth client ID (public, not a secret). The app asks Google for an ID token meant for this client and
        // the server checks that audience. The Android client ID is only registered in Google Cloud, never used in code.
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"892107278045-ojlgmq3vlh9ah5a4omnddmqh54kb8ake.apps.googleusercontent.com\"")

        // Server the app talks to. Set SERVER_URL in app/local.properties (default: the emulator's alias for your PC).
        val serverUrl = localProps.getProperty("SERVER_URL")?.trim()?.takeIf { it.isNotEmpty() } ?: "http://10.0.2.2:4000"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    signingConfigs {
        val storePath = localProps.getProperty("tradelens.keystore.path")
        if (!storePath.isNullOrBlank()) {
            create("release") {
                storeFile = rootProject.file(storePath)
                storePassword = localProps.getProperty("tradelens.keystore.password")
                keyAlias = localProps.getProperty("tradelens.key.alias")
                keyPassword = localProps.getProperty("tradelens.key.password")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without signing details in local.properties the release APK is built unsigned.
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        // android.jar methods return defaults in plain JVM tests instead of throwing "Stub!"
        unitTests.isReturnDefaultValues = true
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)

    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.moshi)
    implementation(libs.okhttp)
    debugImplementation(libs.okhttp.logging)
    implementation(libs.moshi)
    ksp(libs.moshi.kotlin.codegen)

    implementation(libs.vico.compose.m3)

    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.googleid)

    testImplementation(libs.junit)

    debugImplementation(libs.androidx.compose.ui.tooling)
}
