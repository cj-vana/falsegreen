package com.example.calc;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CalcTest {
    @Test
    public void addsTwoNumbers() {
        assertEquals(3, Calc.add(1, 2));
    }
}
