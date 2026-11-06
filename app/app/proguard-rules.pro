# TradeLens release (R8) rules. Most libraries ship their own consumer rules; these cover the reflection-based parts explicitly.

# Keep line numbers for readable crash reports.
-keepattributes SourceFile,LineNumberTable,Signature,InnerClasses,EnclosingMethod,RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault
-renamesourcefileattribute SourceFile

# --- Retrofit (interfaces are called through reflection/proxies) ---
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-keepclassmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-dontwarn retrofit2.KotlinExtensions
-dontwarn retrofit2.KotlinExtensions$*
-dontwarn javax.annotation.**

# --- OkHttp / Okio ---
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Moshi (codegen adapters are found by name: <Class>JsonAdapter) ---
-keep class **JsonAdapter { <init>(...); }
-keepclassmembers @com.squareup.moshi.JsonClass class * { <init>(...); }
-keep @com.squareup.moshi.JsonClass class * { *; }
-keepclassmembers class * {
    @com.squareup.moshi.FromJson <methods>;
    @com.squareup.moshi.ToJson <methods>;
}
-dontwarn com.squareup.moshi.**

# --- Hilt / Dagger / generated components ---
-keep class dagger.hilt.** { *; }
-keep class * extends dagger.hilt.android.internal.managers.ViewComponentManager$FragmentContextWrapper { *; }
-keepclassmembers class * { @javax.inject.Inject <init>(...); @javax.inject.Inject <fields>; }
-keep @dagger.hilt.android.HiltAndroidApp class * { *; }
-keep @dagger.hilt.android.AndroidEntryPoint class * { *; }
-keep class * extends androidx.lifecycle.ViewModel { <init>(...); }
-dontwarn dagger.hilt.**

# --- Credential Manager (Google sign-in is loaded through a provider service) ---
-keep class androidx.credentials.** { *; }
-keep class androidx.credentials.playservices.** { *; }
-keep class * extends androidx.credentials.CredentialProvider { *; }
-dontwarn androidx.credentials.**

# --- Google sign-in (googleid + Play services auth) ---
-keep class com.google.android.libraries.identity.googleid.** { *; }
-keep class com.google.android.gms.auth.api.identity.** { *; }
-dontwarn com.google.android.libraries.identity.googleid.**
-dontwarn com.google.android.gms.**

# --- Kotlin coroutines ---
-dontwarn kotlinx.coroutines.debug.**
