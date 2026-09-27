"""Older checks for app.calc, collected by unittest with -p '*_spec.py'."""

import unittest

from app.calc import add


class AddSpec(unittest.TestCase):
    """add()."""

    def test_add_negative(self) -> None:
        """Adding a negative number subtracts."""
        self.assertEqual(add(5, -2), 3)
