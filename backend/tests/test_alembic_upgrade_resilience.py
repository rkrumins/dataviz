"""The upgrade survives what a real deployment hands it: a database an earlier image stamped with a
revision since renamed, and a running release holding a lock a migration waits for.

No database: the renamed-revision map is read from ``alembic/env.py`` (it runs only inside alembic)
and checked against the on-disk chain; the retry runs against a stand-in ``command.upgrade``."""
from __future__ import annotations

import ast
import os

import pytest
from alembic.script import ScriptDirectory
from sqlalchemy.exc import OperationalError

from backend.app.db.engine import _alembic_config
from backend.scripts import upgrade

_ENV = os.path.join(os.path.dirname(__file__), "..", "alembic", "env.py")


def _renamed_revisions() -> dict:
    with open(_ENV) as env:
        tree = ast.parse(env.read())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                getattr(t, "id", None) == "_RENAMED_REVISIONS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("alembic/env.py has no _RENAMED_REVISIONS")


@pytest.fixture(scope="module")
def chain() -> ScriptDirectory:
    return ScriptDirectory.from_config(_alembic_config())


def _ancestors(chain: ScriptDirectory, revision: str) -> set:
    return {r.revision for r in chain.walk_revisions(base="base", head=revision)}


def test_every_renamed_revision_leads_into_the_chain(chain):
    """A stamped old id is translated to a revision the chain holds, and the old id itself is gone:
    otherwise the translation would be skipped, or would leave the database unresolvable."""
    known = {r.revision for r in chain.walk_revisions()}
    for old, new in _renamed_revisions().items():
        assert old not in known, f"{old} is still in the chain: it needs no translation"
        assert new in known, f"{old} translates to {new}, which the chain does not hold"


def test_the_renumbered_served_revision_resumes_before_the_pressure_column(chain):
    """``20261112_1700_gv_ps_served`` (an image of 12 November) became ``20261112_1800_gv_ps_served``
    when ``20261112_1700_gv_ps_pressure`` was put before it. A database stamped with the old id
    lacks the pressure column, so it must resume below both: translating it to 1800 would mark the
    pressure column's migration applied and never add it."""
    target = _renamed_revisions()["20261112_1700_gv_ps_served"]
    assert target == chain.get_revision("20261112_1700_gv_ps_pressure").down_revision
    for applied_after in ("20261112_1700_gv_ps_pressure", "20261112_1800_gv_ps_served"):
        assert target in _ancestors(chain, applied_after) - {applied_after}


class _Orig(Exception):
    def __init__(self, pgcode: str):
        super().__init__(pgcode)
        self.pgcode = pgcode


def _db_error(pgcode: str) -> OperationalError:
    return OperationalError("ALTER TABLE graphver.projection_state ...", {}, _Orig(pgcode))


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, secs: float) -> None:
        self.pauses.append(secs)
        self.now += secs

    pauses: list


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    c.pauses = []
    monkeypatch.setattr(upgrade, "_long_transactions", lambda: "")
    return c


def test_a_migration_that_gave_up_on_a_lock_is_run_again(monkeypatch, clock):
    outcomes = [_db_error("55P03"), _db_error("55P03"), None]
    calls = []

    def fake_upgrade(cfg, revision):
        calls.append(revision)
        outcome = outcomes.pop(0)
        if outcome is not None:
            raise outcome

    monkeypatch.setattr(upgrade.command, "upgrade", fake_upgrade)
    upgrade._upgrade_retrying_locks(object(), "head", 180, sleep=clock.sleep, clock=clock)
    assert calls == ["head", "head", "head"]
    assert clock.pauses == [5.0, 10.0]              # growing pauses that let the release through


def test_the_upgrade_stops_retrying_at_its_budget(monkeypatch, clock):
    calls = []

    def always_locked(cfg, revision):
        calls.append(revision)
        raise _db_error("55P03")

    monkeypatch.setattr(upgrade.command, "upgrade", always_locked)
    with pytest.raises(OperationalError) as raised:
        upgrade._upgrade_retrying_locks(object(), "head", 40, sleep=clock.sleep, clock=clock)
    assert raised.value.orig.pgcode == "55P03"
    assert clock.pauses == [5.0, 10.0, 20.0]        # the next pause would pass 40 s
    assert len(calls) == 4


def test_any_other_failure_is_not_retried(monkeypatch, clock):
    calls = []

    def broken(cfg, revision):
        calls.append(revision)
        raise _db_error("42703")                    # undefined_column: a real defect

    monkeypatch.setattr(upgrade.command, "upgrade", broken)
    with pytest.raises(OperationalError):
        upgrade._upgrade_retrying_locks(object(), "head", 180, sleep=clock.sleep, clock=clock)
    assert calls == ["head"] and clock.pauses == []
