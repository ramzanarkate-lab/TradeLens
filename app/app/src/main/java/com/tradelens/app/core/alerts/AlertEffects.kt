package com.tradelens.app.core.alerts

import android.content.Context
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * The sound and vibration part of an alert, following the user's toggles. The app plays these itself (instead of
 * the notification channel) so the Sound and Vibration switches in Settings apply to every alert, foreground or not.
 */
object AlertEffects {
    private const val TAG = "TradeLensAlerts"

    fun play(context: Context, sound: Boolean, vibration: Boolean) {
        if (sound) {
            runCatching {
                val ringtone = RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
                ringtone?.play()
                Log.i(TAG, "alert sound played")
            }.onFailure { Log.w(TAG, "alert sound failed", it) }
        }
        if (vibration) {
            runCatching {
                val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                }
                vibrator.vibrate(VibrationEffect.createOneShot(400, VibrationEffect.DEFAULT_AMPLITUDE))
                Log.i(TAG, "alert vibration triggered")
            }.onFailure { Log.w(TAG, "alert vibration failed", it) }
        }
    }
}
