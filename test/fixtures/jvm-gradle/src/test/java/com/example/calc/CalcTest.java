package com.example.calc;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalcTest {
  @Test
  void addsTwoNumbers() {
    assertEquals(3, Calc.add(1, 2));
  }
}
