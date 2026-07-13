"""A re-sync too big to survive is refused, with the number that proves it.

`sync_ingest` rebuilds the whole graph several times over to do its 3-way merge. Measured on a
478,430-entity graph: 2.03 GB of RSS to compute 808 changes, in one HTTP request, on the web
tier — ~4.5 KiB per entity, linear. The 7.7M model would ask for ~30 GB and take the API
process down, killing every other request in flight with it.

Above the limit the operation does not work. So it refuses, and says how big and how much.
These tests exist to be DELETED along with the guard, once the streaming re-sync lands
(docs/versioning/11-resync-at-any-scale.md).
"""
import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.service import (
    GraphTooLargeToSync,
    GraphVersioningService,
    _SYNC_BYTES_PER_ENTITY,
)


class _Session:
    """Just enough session to answer the one COUNT the guard asks."""

    def __init__(self, entities: int):
        self._entities = entities

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def scalar(self, _q):
        return self._entities


def _svc(entities: int) -> GraphVersioningService:
    svc = GraphVersioningService()
    svc._session = lambda: _Session(entities)                       # type: ignore[assignment]

    async def _main(_s, _gid):
        return "br_main"
    svc._main_branch_id = _main                                     # type: ignore[assignment]
    return svc


async def test_a_graph_that_would_not_fit_is_refused(monkeypatch):
    monkeypatch.setattr(config, "RESYNC_MAX_ENTITIES", 250_000)
    with pytest.raises(GraphTooLargeToSync) as exc:
        await _svc(7_093_010)._assert_syncable("graph_1")
    assert exc.value.entities == 7_093_010
    assert exc.value.limit == 250_000


async def test_a_graph_that_fits_passes(monkeypatch):
    monkeypatch.setattr(config, "RESYNC_MAX_ENTITIES", 250_000)
    await _svc(19_000)._assert_syncable("graph_1")                  # no raise


async def test_the_limit_is_a_ceiling_not_a_cliff(monkeypatch):
    """Exactly at the limit is allowed; one over is not."""
    monkeypatch.setattr(config, "RESYNC_MAX_ENTITIES", 1_000)
    await _svc(1_000)._assert_syncable("graph_1")                   # no raise
    with pytest.raises(GraphTooLargeToSync):
        await _svc(1_001)._assert_syncable("graph_1")


async def test_an_operator_can_turn_the_guard_off(monkeypatch):
    """It is a guard rail, not a policy — someone who knows the memory is there may proceed."""
    monkeypatch.setattr(config, "RESYNC_MAX_ENTITIES", 0)
    await _svc(7_093_010)._assert_syncable("graph_1")               # no raise


def test_the_refusal_tells_the_truth_about_the_cost():
    """The number in the message is the whole point: a refusal an operator cannot act on is
    no better than a crash. The estimate is calibrated against a real measurement — a 478,430
    entity re-sync peaked at 2,095 MiB, and this predicts 2.05 GB."""
    exc = GraphTooLargeToSync(478_430, 250_000)
    gb = exc.estimated_bytes / 1_073_741_824
    assert 1.9 < gb < 2.2, f"estimate {gb:.2f} GB should track the measured 2.03 GB"
    assert "478,430 items" in str(exc)
    assert "250,000 items" in str(exc)
    assert "2.0 GB" in str(exc)


def test_the_per_entity_cost_is_the_measured_one():
    # 2,030 MiB of growth over 478,430 entities = 4.45 KiB/entity. If someone "tidies" this
    # constant, the message starts lying to operators about how much memory they need.
    assert 4_000 <= _SYNC_BYTES_PER_ENTITY <= 5_200
