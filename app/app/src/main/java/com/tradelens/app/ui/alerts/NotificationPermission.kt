package com.tradelens.app.ui.alerts

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.tradelens.app.R
import com.tradelens.app.core.alerts.canPostNotifications

/**
 * Returns a function that asks for the notification permission the polite way: on Android 13+ it first shows a dialog
 * explaining why, and only when the user agrees does it open the system prompt. Before Android 13, or when the permission
 * is already granted, it does nothing but report success. [onDone] is called with the final answer.
 */
@Composable
fun rememberAskNotificationPermission(onDone: (granted: Boolean) -> Unit = {}): () -> Unit {
    val context = LocalContext.current
    var showExplanation by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> onDone(granted) }

    if (showExplanation) {
        AlertDialog(
            onDismissRequest = {
                showExplanation = false
                onDone(false)
            },
            title = { Text(stringResource(R.string.notif_permission_title)) },
            text = { Text(stringResource(R.string.notif_permission_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showExplanation = false
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }) { Text(stringResource(R.string.notif_allow)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    showExplanation = false
                    onDone(false)
                }) { Text(stringResource(R.string.notif_not_now)) }
            },
        )
    }

    return remember(context) {
        {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !context.canPostNotifications()) showExplanation = true
            else onDone(true)
        }
    }
}
