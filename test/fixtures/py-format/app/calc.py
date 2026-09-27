"""Arithmetic."""

import math


def add(a: int, b: int) -> int:
    """Return the sum of a and b."""
    return a + b


def hypot(a: float, b: float) -> float:
    """Return the length of the hypotenuse."""
    return math.sqrt(a * a + b * b)
