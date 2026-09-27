"""Tests for app.calc."""

import unittest

from app.calc import add, hypot


class TestCalc(unittest.TestCase):
    """add() and hypot()."""

    def test_add(self) -> None:
        """Two and two make four."""
        self.assertEqual(add(2, 2), 4)

    def test_hypot(self) -> None:
        """A 3-4-5 triangle."""
        self.assertEqual(hypot(3, 4), 5)
