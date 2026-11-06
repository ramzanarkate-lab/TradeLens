package com.tradelens.app

import com.tradelens.app.core.alerts.AlertQueue
import com.tradelens.app.data.signals.SignalDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlertQueueTest {
    private fun signal(id: String, side: String = "BUY") =
        SignalDto(id, "BTCUSDT", side, "1h", 67_420.0, "ema_cross_up", "reason $id", 1_000)

    @Test
    fun `nothing is showing at first`() {
        assertNull(AlertQueue().current.value)
    }

    @Test
    fun `two signals are shown one after the other, in the order they arrived`() {
        val queue = AlertQueue()
        queue.offer(signal("first"))
        queue.offer(signal("second", "SELL")) // arrives while the first is still on screen

        assertEquals("first", queue.current.value?.id) // the second must NOT replace or overlap it
        queue.dismiss()
        assertEquals("second", queue.current.value?.id)
        assertEquals("SELL", queue.current.value?.side)
        queue.dismiss()
        assertNull(queue.current.value)
    }

    @Test
    fun `three signals keep their order`() {
        val queue = AlertQueue()
        listOf("a", "b", "c").forEach { queue.offer(signal(it)) }
        val shown = buildList {
            while (queue.current.value != null) {
                add(queue.current.value!!.id)
                queue.dismiss()
            }
        }
        assertEquals(listOf("a", "b", "c"), shown)
    }

    @Test
    fun `a signal that arrives after the queue emptied is shown straight away`() {
        val queue = AlertQueue()
        queue.offer(signal("one"))
        queue.dismiss()
        queue.offer(signal("two"))
        assertEquals("two", queue.current.value?.id)
    }

    @Test
    fun `the same signal heard twice is shown once, whether it is showing or waiting`() {
        val queue = AlertQueue()
        queue.offer(signal("x"))
        queue.offer(signal("x")) // duplicate of the one on screen
        queue.offer(signal("y"))
        queue.offer(signal("y")) // duplicate of a waiting one
        queue.dismiss()
        assertEquals("y", queue.current.value?.id)
        queue.dismiss()
        assertNull(queue.current.value)
    }

    @Test
    fun `dismissing an empty queue is harmless and clear drops everything`() {
        val queue = AlertQueue()
        queue.dismiss()
        assertNull(queue.current.value)

        queue.offer(signal("a"))
        queue.offer(signal("b"))
        queue.clear()
        assertNull(queue.current.value)
        queue.dismiss()
        assertNull(queue.current.value) // nothing left waiting
    }
}
