"""Prints the next patch version."""


def bump(version: str) -> str:
    """Return the version with its last component increased by one."""
    head, _, last = version.rpartition(".")
    return f"{head}.{int(last) + 1}"
