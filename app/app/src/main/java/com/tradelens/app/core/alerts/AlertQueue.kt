package com.tradelens.app.core.alerts

import com.tradelens.app.data.signals.SignalDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Popups waiting to be shown. Only [current] is on screen; the rest wait their turn, so two signals can never
 * overlap. The screen shows [current] and calls [dismiss] when the user closes it (which reveals the next one).
 */
@Singleton
class AlertQueue @Inject constructor() {
    private val pending = ArrayDeque<SignalDto>()
    private val _current = MutableStateFlow<SignalDto?>(null)
    val current: StateFlow<SignalDto?> = _current.asStateFlow()

    /** Adds a signal. One that is already showing or waiting (same id) is ignored. */
    @Synchronized
    fun offer(signal: SignalDto) {
        if (_current.value?.id == signal.id || pending.any { it.id == signal.id }) return
        if (_current.value == null) _current.value = signal else pending.addLast(signal)
    }

    /** Closes the popup on screen and shows the next waiting one, if any. */
    @Synchronized
    fun dismiss() {
        _current.value = pending.removeFirstOrNull()
    }

    /** Drops everything, e.g. when the user signs out. */
    @Synchronized
    fun clear() {
        pending.clear()
        _current.value = null
    }
}
