"""``POST /api/v1/admin/versioning/watermarks/reset`` — the disaster-recovery reseed of every
versioned graph on one FalkorDB provider.

After a restore, a shard rebuild or a region loss the keys hold an older state than the
watermarks say, and graphs projected before pass markers existed cannot tell. The operator resets
the provider's watermarks; the projection worker then reseeds each key in place from Postgres.

* It is a platform administrator's action (``system:admin``), recorded in the activity log with
  who did it, and it is not open to API keys.
* It resets by provider only, and names its operator from the signed-in user.
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import catalogue

_PATH = "/api/v1/admin/versioning/watermarks/reset"


class _Svc:
    def __init__(self):
        self.calls = []

    async def reset_projection_watermarks(self, **kw):
        self.calls.append(kw)
        return ["g1", "g2"]


@pytest.mark.asyncio
async def test_the_reset_names_the_provider_and_its_operator_and_is_recorded():
    svc, recorded = _Svc(), []

    async def record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    with patch.object(va, "get_versioning_service", return_value=svc), \
            patch.object(va.recorder, "record_for_request", record):
        out = await va.reset_watermarks(va.WatermarkResetRequest(provider="falkor-eu"),
                                        user=SimpleNamespace(id="usr_admin"), session=object())

    assert svc.calls == [{"provider": "falkor-eu", "actor": "usr_admin"}]
    assert out == {"provider": "falkor-eu", "graphsReset": 2}
    assert len(recorded) == 1
    event_type, fields = recorded[0]
    assert event_type == "platform.versioning.watermarks_reset"
    assert fields["details"] == {"provider": "falkor-eu", "graphsReset": 2}
    assert fields["best_effort"] is True


def _route():
    found = [(m, r, d) for m, p, r, d in api_key_surface.routes(app) if p == _PATH]
    assert [m for m, _, _ in found] == ["POST"], found
    return found[0][1], found[0][2]


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_the_route_is_mounted_for_platform_admins_only():
    _, dependant = _route()
    assert "system:admin" in _gate_perms(dependant)


def test_an_api_key_cannot_reach_it():
    """Keys reach only the routes on the surface; this one is deliberately not there."""
    route, _ = _route()
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_can_say_what_happened():
    severity, summary = catalogue.summarize(
        "platform.versioning.watermarks_reset",
        {"details": {"provider": "falkor-eu", "graphsReset": 2}})
    assert severity == "warning"
    assert "falkor-eu" in summary
    assert catalogue.LABELS["platform.versioning.watermarks_reset"]
    assert catalogue.category_of("platform.versioning.watermarks_reset") == "platform"
