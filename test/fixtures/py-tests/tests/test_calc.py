"""Tests for app.calc."""

import unittest

from app.calc import add


class TestAdd(unittest.TestCase):
    """add()."""

    def test_add(self) -> None:
        """Two and two make four."""
        self.assertEqual(add(2, 2), 4)
