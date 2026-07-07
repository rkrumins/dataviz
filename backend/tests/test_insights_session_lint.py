"""Lint enforcement: insights_service must use the shielded session
helpers from ``backend.app.db.engine`` (``get_jobs_session`` /
``get_readonly_session``), never raw ``get_session_factory``.

The raw ``async with factory() as session`` pattern skips the
cancellation-shielded commit/rollback/close in ``_session_scope``
(engine.py). Tasks cancelled during the shutdown drain then abandon
asyncpg connections mid-close — the "Event loop is closed" teardown
noise this rule exists to prevent.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

# Empty on purpose — every insights_service module uses the shielded
# helpers. Do not add entries; open short sessions with
# get_jobs_session/get_readonly_session instead.
_ALLOWED: set[str] = set()

_FORBIDDEN = re.compile(r"get_session_factory\(")


def test_insights_service_uses_shielded_session_helpers() -> None:
    pkg = Path(__file__).resolve().parents[1] / "insights_service"
    hits: list[str] = []
    for py in sorted(pkg.glob("*.py")):
        if py.name in _ALLOWED:
            continue
        for lineno, line in enumerate(
            py.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if line.strip().startswith("#"):
                continue
            if _FORBIDDEN.search(line):
                hits.append(f"  {py.name}:{lineno}: {line.strip()}")
    if hits:
        pytest.fail(
            "Raw get_session_factory( use in insights_service — use the "
            "shielded get_jobs_session/get_readonly_session helpers from "
            "backend.app.db.engine instead:\n" + "\n".join(hits)
        )
