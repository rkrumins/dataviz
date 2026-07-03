"""Regression: ``FalkorProjector._verify_and_heal`` must always return a 2-tuple
``(error_or_None, reseeded)``, even on the fallthrough "still mismatched after heal"
path. A bare string there breaks the caller's ``err, reseeded = await
self._verify_and_heal(...)`` unpack (``ValueError: too many values to unpack``),
aborting projection after apply but before the watermark write.

Pure unit test — no DB, no FalkorDB; monkeypatches the two count helpers directly
on the instance so the fallthrough path is reached deterministically.
"""
import asyncio

from backend.app.services.versioning.projection import FalkorProjector


def _unused_session():
    raise AssertionError("_verify_and_heal must not touch the session on this path")


def _unused_client_factory(name, provider_id=None):
    raise AssertionError("_verify_and_heal must not touch the client factory on this path")


async def _run(monkeypatch) -> tuple:
    proj = FalkorProjector(graph_client_factory=_unused_client_factory,
                           session_factory=_unused_session)

    async def fake_pg_counts(graph_id, main_id, to_seq, is_fork):
        return (5, 5)

    async def fake_falkor_counts(client):
        return (3, 3)

    monkeypatch.setattr(proj, "_pg_live_counts", fake_pg_counts)
    monkeypatch.setattr(proj, "_falkor_counts", fake_falkor_counts)

    # from_seq=0 skips the reseed branch (only taken when from_seq > 0); PG (5,5) > Falkor
    # (3,3) skips the tombstone-sweep/"Falkor has extra" branches — landing directly on the
    # "still mismatched after heal" fallthrough, the one path that used to return a bare str.
    return await proj._verify_and_heal(None, "g1", "main1", 0, 10, False)


def test_verify_and_heal_fallthrough_returns_two_tuple(monkeypatch):
    result = asyncio.run(_run(monkeypatch))
    assert isinstance(result, tuple) and len(result) == 2, result
    msg, reseeded = result
    assert isinstance(msg, str) and "mismatch" in msg
    assert reseeded is False
