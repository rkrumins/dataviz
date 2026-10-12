"""Coherence guard for the analytics deployment settings.

``ANALYTICS_WARM_INTERVAL_SECONDS`` is read by TWO roles and means two things
at once: the controlplane warms on that cadence, and every web process snaps
its analytics windows to a grid of that width. The code now derives both from
one clamp (``analytics_cache.epoch_seconds``), which was a real bug — the two
readers used to clamp the same variable differently, so a short setting gave
the warmer one cadence and its readers another, and it warmed slots nobody
ever asked for. Silently: the only symptom was a dashboard that stopped being
fast.

Deployment config can reintroduce exactly that bug from the outside, by giving
the two roles different values. The Helm chart cannot — one ConfigMap feeds
every service — but the k8s base overlays are two separate files, and
docker-compose sets it per service. So the invariant is asserted here rather
than left to the comments beside each one.

Deliberately dependency-free (no PyYAML — it is not a direct requirement) and
tolerant of formatting: these are flat ``KEY: "value"`` maps, and a regex over
uncommented lines is the whole parser this needs.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


_ROOT = Path(__file__).resolve().parent.parent.parent
_VIZ = _ROOT / "deploy" / "k8s" / "base" / "configmaps" / "viz-config.yaml"
_CONTROLPLANE = _ROOT / "deploy" / "k8s" / "base" / "configmaps" / "controlplane-config.yaml"
_COMPOSE = _ROOT / "docker-compose.yml"

_GRID = "ANALYTICS_WARM_INTERVAL_SECONDS"
_RETENTION = "PRODUCT_EVENT_RETENTION_DAYS"


def _values(path: Path, key: str) -> list[str]:
    """Every uncommented assignment of ``key`` in ``path``, in order."""
    pattern = re.compile(rf'^\s*{re.escape(key)}\s*:\s*"?([^"#\n]+)"?', re.M)
    uncommented = "\n".join(
        line for line in path.read_text().splitlines()
        if not line.lstrip().startswith("#")
    )
    return [m.strip() for m in pattern.findall(uncommented)]


def test_both_roles_are_given_the_analytics_grid():
    """The web tier needs it as much as the warmer does.

    Omitting it from either is not a missing tuning knob — it is two roles
    disagreeing about which epoch is current.
    """
    assert _values(_VIZ, _GRID), f"{_VIZ.name} does not set {_GRID}"
    assert _values(_CONTROLPLANE, _GRID), f"{_CONTROLPLANE.name} does not set {_GRID}"


def test_the_k8s_roles_agree_on_the_grid():
    viz = _values(_VIZ, _GRID)
    control = _values(_CONTROLPLANE, _GRID)
    assert viz == control, (
        f"{_GRID} is {viz} in viz-config and {control} in controlplane-config. "
        "The warmer would write entries for epochs the web tier never asks "
        "for, and nothing would report an error."
    )


def test_compose_interpolates_one_variable_into_every_service():
    """Both services must read the SAME ``${VAR}``, not two literals.

    A literal on each side is the drift above waiting to happen the first time
    somebody tunes one of them.
    """
    settings = _values(_COMPOSE, _GRID)
    assert len(settings) >= 2, (
        f"expected {_GRID} on both the web and controlplane services, "
        f"found {len(settings)}"
    )
    assert all("${" + _GRID in s for s in settings), (
        f"{_GRID} is hard-coded per service in docker-compose.yml ({settings}); "
        "interpolate the single env var so the two cannot diverge"
    )
    assert len(set(settings)) == 1, f"services interpolate differently: {settings}"


def test_retention_is_set_where_the_sweep_actually_runs():
    """The sweep is gated on ``runs_scheduler()``, so it belongs to the
    controlplane. Setting it on the web tier would imply a sweep that role
    never runs."""
    assert _values(_CONTROLPLANE, _RETENTION), (
        f"{_CONTROLPLANE.name} does not set {_RETENTION}"
    )
    assert not _values(_VIZ, _RETENTION), (
        f"{_VIZ.name} sets {_RETENTION}, but the retention sweep does not run "
        "on the web role"
    )


@pytest.mark.parametrize("key", [_GRID, _RETENTION])
def test_operators_can_find_both_knobs(key):
    """A setting documented only in a changelog cannot be set by anybody."""
    for name in (".env.example", ".env.prod.example"):
        assert key in (_ROOT / name).read_text(), f"{key} is missing from {name}"
