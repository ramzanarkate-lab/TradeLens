package com.tradelens.app.ui.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tradelens.app.R
import com.tradelens.app.core.theme.TextSecondary
import com.tradelens.app.core.ui.BrandHeader
import com.tradelens.app.core.ui.BrandSize

/** Shown while the app reads what it remembers (session, preferences), before the login or main screen. */
@Composable
fun SplashScreen() {
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        BrandHeader(BrandSize.Large)
        Text(
            stringResource(R.string.app_starting),
            style = MaterialTheme.typography.bodyLarge,
            color = TextSecondary,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}
