"""The ``versioningEnabled`` admin flag gates every mutating versioning route.

Covers the three enforcement layers added for the flag:

* ``versioning_write_gate`` — router-level dependency on ``/{ws}/versioning``:
  mutating methods 403 with ``feature_disabled`` when the flag is off; GETs and
  the ops allowlist (projection rebuild/reconcile, exports) are never blocked
  by the gate; everything passes when the flag is on.
* ``require_versioning_enabled`` — per-route dependency on ``/graph/bootstrap``
  and ``/graph/resync``.
* ``VersionedWriteProvider`` backstop — canvas write-through raises
  ``FeatureDisabledError`` (mapped to the same 403 by ``main.py``).

The gates read flags through ``FeatureFlagService.is_enabled_self_session``
(cache-first). Tests prime the singleton's cache directly — the DB-loaded path
is covered by the live-stack verification and ``test_api_features_public.py``.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.services.feature_flags import FeatureDisabledError, feature_flags

WS = "ws_gate_test"


def _prime_flags(**values):
    """Prime the singleton flag cache so gates resolve without a DB."""
    feature_flags._cache = dict(values)
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture(autouse=True)
def _fresh_flag_cache():
    feature_flags.invalidate()
    yield
    feature_flags.invalidate()


def _is_feature_disabled(resp) -> bool:
    if resp.status_code != 403:
        return False
    detail = resp.json().get("detail")
    return isinstance(detail, dict) and detail.get("type") == "feature_disabled"


# ── flag OFF: mutating versioning routes are blocked at the router ──────────

async def test_writes_blocked_when_disabled(test_client: AsyncClient):
    _prime_flags(versioningEnabled=False)
    for method, path in [
        ("POST", f"/api/v1/{WS}/versioning/resolve"),
        ("POST", f"/api/v1/{WS}/versioning/graphs"),
        ("POST", f"/api/v1/{WS}/versioning/graphs/g1/branches"),
        ("POST", f"/api/v1/{WS}/versioning/graphs/g1/branches/b1/publish"),
        ("PATCH", f"/api/v1/{WS}/versioning/graphs/g1/branches/b1"),
        ("POST", f"/api/v1/{WS}/versioning/graphs/g1/commits/c1/revert"),
        ("POST", f"/api/v1/{WS}/versioning/pulls/pr1/merge"),
        ("POST", f"/api/v1/{WS}/versioning/merge-requests/mr1/merge"),
    ]:
        resp = await test_client.request(method, path, json={})
        assert _is_feature_disabled(resp), (
            f"{method} {path} should be feature_disabled 403, "
            f"got {resp.status_code}: {resp.text[:200]}"
        )
        assert resp.json()["detail"]["feature"] == "versioningEnabled"


async def test_bootstrap_and_resync_blocked_when_disabled(test_client: AsyncClient):
    _prime_flags(versioningEnabled=False)
    for path in (
        f"/api/v1/{WS}/graph/bootstrap?dataSourceId=ds_x",
        f"/api/v1/{WS}/graph/resync?dataSourceId=ds_x",
    ):
        resp = await test_client.post(path)
        assert _is_feature_disabled(resp), (
            f"POST {path} should be feature_disabled 403, got {resp.status_code}"
        )


# ── flag OFF: reads and the ops allowlist are NOT blocked by the gate ───────
# (They may still fail deeper in the stack in this unit env — the assertion is
# only that the versioning gate did not produce its typed 403.)

async def test_reads_not_blocked_when_disabled(test_client: AsyncClient):
    _prime_flags(versioningEnabled=False)
    for path in (
        f"/api/v1/{WS}/versioning/resolve?dataSourceId=ds_x",
        f"/api/v1/{WS}/versioning/graphs/g1",
        f"/api/v1/{WS}/versioning/graphs/g1/commits",
    ):
        resp = await test_client.get(path)
        assert not _is_feature_disabled(resp), f"GET {path} must not be flag-gated"


async def test_ops_allowlist_not_blocked_when_disabled(test_client: AsyncClient):
    _prime_flags(versioningEnabled=False)
    for path in (
        f"/api/v1/{WS}/versioning/graphs/g1/projection/rebuild",
        f"/api/v1/{WS}/versioning/graphs/g1/projection/reconcile",
        f"/api/v1/{WS}/versioning/graphs/g1/exports",
    ):
        resp = await test_client.post(path, json={})
        assert not _is_feature_disabled(resp), f"POST {path} must stay usable (ops surface)"


# ── flag ON (and default-missing): nothing is gated ─────────────────────────

async def test_writes_pass_gate_when_enabled(test_client: AsyncClient):
    _prime_flags(versioningEnabled=True)
    resp = await test_client.post(f"/api/v1/{WS}/versioning/resolve", json={})
    assert not _is_feature_disabled(resp)


async def test_missing_flag_defaults_to_enabled(test_client: AsyncClient):
    _prime_flags()  # cache primed but key absent → default=True must win
    resp = await test_client.post(f"/api/v1/{WS}/versioning/resolve", json={})
    assert not _is_feature_disabled(resp)


# ── write-through provider backstop ──────────────────────────────────────────

async def test_write_provider_backstop_raises_when_disabled():
    from backend.common.models.graph import GraphNode
    from backend.app.providers.versioned_write_provider import VersionedWriteProvider

    class _StubSvc:  # never reached — the flag check fires first
        async def resolve_graph(self, **kw):  # pragma: no cover
            raise AssertionError("flag check must precede any service call")

    provider = VersionedWriteProvider(
        object(), workspace_id=WS, data_source_id="ds_x",
        actor="tester", svc=_StubSvc(),
    )
    _prime_flags(versioningEnabled=False)
    node = GraphNode(urn="urn:x:1", display_name="X", entity_type="Node")
    with pytest.raises(FeatureDisabledError):
        await provider.create_node(node)


async def test_write_provider_passes_when_enabled():
    from backend.common.models.graph import GraphNode
    from backend.app.providers.versioned_write_provider import VersionedWriteProvider

    calls = {}

    class _StubSvc:
        async def resolve_graph(self, **kw):
            return {"graph_id": "g_stub"}

        async def apply_ops(self, **kw):
            calls["ops"] = kw["ops"]

    class _StubInner:
        async def create_node(self, node, containment_edge=None):
            calls["inner"] = node
            return True

    provider = VersionedWriteProvider(
        _StubInner(), workspace_id=WS, data_source_id="ds_x",
        actor="tester", svc=_StubSvc(),
    )
    _prime_flags(versioningEnabled=True)
    node = GraphNode(urn="urn:x:1", display_name="X", entity_type="Node")
    await provider.create_node(node)
    assert calls["ops"], "write must be recorded when the flag is on"
    assert calls["inner"] is node
