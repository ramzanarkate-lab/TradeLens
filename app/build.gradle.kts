plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}

// On Windows the repo often lives in OneDrive, which locks files inside build/ and breaks Gradle
// ("Unable to delete directory" / AccessDenied). Build outside the synced folder instead.
// Override with TRADELENS_BUILD_DIR; on other platforms the default app/build is used.
val externalBuildRoot: String? = System.getenv("TRADELENS_BUILD_DIR")
    ?: System.getenv("LOCALAPPDATA")?.let { "$it/TradeLens/build" }
if (externalBuildRoot != null) {
    subprojects {
        layout.buildDirectory.set(file("$externalBuildRoot/$name"))
    }
}
