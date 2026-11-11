"""The parts of reconciling an import in memory that need no database (the rest:
tests/integration/test_import_in_memory.py, against live Postgres).

Pins: what a pass has seen is never forgotten (a row named before is never taken as fresh), and
names it never saw are rarely taken as seen (under 2% at the capacity it is sized for); the cursor
of an in-memory import names its windows and its edge pass; and the switch, when it can't be read,
is off.
"""
from __future__ import annotations

import pytest

from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import _Seen, _window_after


def test_what_a_pass_has_seen_is_never_forgotten_and_rarely_imagined():
    seen = _Seen(50_000)
    names = [f"p:urn:acme:table:{i}" for i in range(50_000)]
    for name in names:
        seen.add(name)
    assert all(name in seen for name in names)
    imagined = sum(f"p:urn:other:{i}" in seen for i in range(20_000))
    assert imagined < 400, f"{imagined} of 20,000 unseen names taken as seen"


@pytest.mark.parametrize("cursor, step", [
    ("node:4", ("node", 4)), ("mnode:-1", ("mnode", -1)), ("mnode:9", ("mnode", 9)),
    ("eparse:120", ("eparse", 120)), ("edge:-1", ("edge", -1)),
    ("replace", (None, -1)), ("mparse:5", (None, -1)), (None, (None, -1)),
])
def test_the_cursor_says_which_window_or_pass_is_next(cursor, step):
    assert _window_after(cursor) == step


async def test_a_switch_that_cannot_be_read_is_off(monkeypatch):
    from backend.app.services import feature_flags

    async def broken(*_args, **_kwargs):
        raise ConnectionError("the management database is down")

    monkeypatch.setattr(feature_flags.feature_flags, "is_enabled_self_session", broken)
    assert await import_worker._in_memory_switch() is False
