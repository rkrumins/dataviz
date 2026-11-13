"""A new version built beside the serving key (read mode ``beside``), without a database server:
what a build is and when one is wanted (``candidates``), the key it is built in
(``keymigrate.build_key``: the serving key's hash tag, so ``GRAPH.COPY`` can copy into its cluster
slot), its columns declared and migrated, and a pass that finds a build taking its next step
instead of claiming the serving row. The build end to end is
``tests/integration/test_projection_builds_e2e.py``.
"""
from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

from backend.app.services.graph_store.topology import key_slot
from backend.app.services.versioning import candidates, keymigrate, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.tests.test_projection_fencing_unit import _PS, _projector

_REVISION = (Path(__file__).resolve().parents[1] / "alembic" / "versions"
             / "20261113_1400_gv_ps_candidate.py")


def test_a_window_is_built_beside_only_for_a_beside_graph_with_builds_on_over_the_threshold():
    base = dict(read_mode="beside", switch_on=True, owned=True, rows=10, above=5)
    assert candidates.wanted(**base)
    for change in ({"read_mode": "in_place"}, {"read_mode": "latest"}, {"switch_on": False},
                   {"switch_on": None}, {"owned": False}, {"rows": 5}):
        assert not candidates.wanted(**{**base, **change}), change


def test_a_build_is_asked_for_queued_and_reads_as_its_block():
    state = candidates.new_state("window", now="2026-11-13T12:00:00+00:00", rows=250_001)
    assert state["id"].startswith("build_") and state["step"] == "queued"
    assert (state["attempts"], state["mode"], state["rows"]) == (0, "copy", 250_001)
    ps = SimpleNamespace(candidate_state=state, candidate_seq=None)
    assert candidates.block(ps) == {
        "id": state["id"], "step": "queued", "reason": "window", "mode": "copy", "seq": None,
        "attempts": 0, "error": None, "waiting": None,
        "since": "2026-11-13T12:00:00+00:00", "rows": 250_001}
    assert candidates.block(SimpleNamespace(candidate_state=None)) is None


def test_a_build_key_keeps_the_serving_keys_slot_and_never_grows():
    serving = keymigrate.owned_key("graph_01HZZZZZZZZZZZZZZZZZZZZZZZ", 3)
    first = keymigrate.build_key(serving, {serving})
    assert first == f"{serving}#b1" and key_slot(first) == key_slot(serving)
    assert keymigrate.build_key(serving, {serving, first}) == f"{serving}#b2"
    # Built beside a build's key (once switched to it): the suffix is replaced, not added.
    assert keymigrate.build_key(first, {first}) == f"{serving}#b2"
    assert keymigrate.build_key(first, {first, serving}) == f"{serving}#b2"


def test_a_build_key_is_one_of_the_graphs_own_keys():
    gid = "graph_01HZZZZZZZZZZZZZZZZZZZZZZZ"
    serving = keymigrate.owned_key(gid, 1)
    assert keymigrate.is_owned_key(gid, serving)
    assert keymigrate.is_owned_key(gid, f"{serving}#b12")
    assert not keymigrate.is_owned_key(gid, f"{serving}#x1")
    assert not keymigrate.is_owned_key(gid, f"{serving}#b")
    assert not keymigrate.is_owned_key("graph_other", f"{serving}#b1")


def test_the_build_columns_are_declared_and_migrated():
    columns = ProjectionStateORM.__table__.c
    for name in ("candidate_graph_name", "candidate_provider", "candidate_seq",
                 "candidate_state"):
        assert columns[name].nullable and columns[name].server_default is None, name
    spec = importlib.util.spec_from_file_location(_REVISION.stem, _REVISION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261113_1300_gv_ps_read_mode"
    assert module.ensure_ps_candidate_columns is models.ensure_ps_candidate_columns


def test_a_pass_that_finds_a_build_takes_its_step_and_never_claims_the_serving_row(monkeypatch):
    ps = _PS(projected=3, target=5)
    ps.candidate_state = {"id": "build_1", "step": "catching_up"}
    proj, _ps, client, seen = _projector(monkeypatch, ps=ps)
    stepped = []

    async def advance(graph_id):
        stepped.append(graph_id)
        return {"projected": 3, "applied": 0, "noop": False, "build": "catching_up"}

    monkeypatch.setattr(proj, "_advance_candidate", advance)
    out = asyncio.run(proj.project_graph("g1"))
    assert stepped == ["g1"] and out["build"] == "catching_up"
    assert seen["claim"] == [] and seen["finish"] == [] and not client.touched


def test_a_pass_with_no_build_and_a_small_window_never_asks_for_one(monkeypatch):
    ps = _PS(projected=3, target=5)
    proj, _ps, _client, seen = _projector(monkeypatch, ps=ps)
    asked = []

    async def queue(*a):
        asked.append(a)
        return False

    monkeypatch.setattr(proj, "_queue_build", queue)
    asyncio.run(proj.project_graph("g1"))
    assert len(asked) == 1 and seen["claim"] == [("g1", 4, 3)]     # asked, then in place


def test_a_copys_room_is_checked_and_reserved_in_one_step_under_the_capacity_lock(monkeypatch):
    """Two builds never take the room one copy needs: the check and the reservation, in the
    governor's ledger every admission counts, happen under the capacity lock; refused, nothing
    is reserved."""
    from contextlib import asynccontextmanager

    from backend.app.services.aggregation import admission, redis_client
    from backend.app.services.versioning import residency
    from backend.app.services.versioning.residency import Admitted

    events = []
    answers = [(Admitted(True, "node1"), 1300), (Admitted(False, "node1", 5, "capacity"), 1300)]

    @asynccontextmanager
    async def admitting(wait_s=15.0):
        events.append("lock")
        yield
        events.append("unlock")

    async def copy_room(graph_id, provider, key, *, margin_pct, max_bytes):
        events.append(("check", key, margin_pct, max_bytes))
        return answers.pop(0)

    class _Admission:
        def __init__(self, redis):
            pass

        async def reserve(self, endpoint, holder, nbytes):
            events.append(("reserve", endpoint, holder, nbytes))
            return ("held", holder)

    monkeypatch.setattr(residency, "admitting", admitting)
    monkeypatch.setattr(residency, "_copy_room", copy_room)
    monkeypatch.setattr(admission, "AggregationAdmission", _Admission)
    monkeypatch.setattr(redis_client, "get_redis", lambda: None)

    def admit():
        return asyncio.run(residency.admit_build_copy("g1", None, "k#b1", "build_1",
                                                      margin_pct=130, max_bytes=0))

    assert admit() == (Admitted(True, "node1"), ("held", "build_1"))
    assert events == ["lock", ("check", "k#b1", 130, 0), ("reserve", "node1", "build_1", 1300),
                      "unlock"]
    events.clear()
    assert admit() == (Admitted(False, "node1", 5, "capacity"), None)
    assert events == ["lock", ("check", "k#b1", 130, 0), "unlock"]
