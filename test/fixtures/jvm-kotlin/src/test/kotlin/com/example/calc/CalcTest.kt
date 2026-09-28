package com.example.calc

import kotlin.test.Test
import kotlin.test.assertEquals

class CalcTest {
    @Test
    fun addsTwoNumbers() {
        assertEquals(3, add(1, 2))
    }
}
