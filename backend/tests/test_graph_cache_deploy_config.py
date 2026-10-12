"""Every k8s role caches payloads as large as compose's do.

``GRAPH_CACHE_MAX_PAYLOAD_BYTES`` is a property of the shared response
cache, so docker-compose sets it on every service that holds a cache client.
The k8s base set it nowhere, so pods ran the smaller code default and the
heaviest view-open reads (/edges/between, wide trace-closure pages) were
dropped as too large and recomputed on every open. Every cache-holding role
mounts common-config, which is the one place that mirrors compose.

Dependency-free, like test_analytics_deploy_config: a regex over uncommented
``KEY: "value"`` lines is the whole parser this needs.
"""
from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
_CONFIGMAPS = _ROOT / "deploy" / "k8s" / "base" / "configmaps"
_COMPOSE = _ROOT / "docker-compose.yml"
_KEY = "GRAPH_CACHE_MAX_PAYLOAD_BYTES"


def _values(path: Path, key: str) -> list[str]:
    """Every uncommented assignment of ``key`` in ``path``, in order."""
    pattern = re.compile(rf'^\s*{re.escape(key)}\s*:\s*"?([^"#\n]+)"?', re.M)
    uncommented = "\n".join(
        line for line in path.read_text().splitlines()
        if not line.lstrip().startswith("#")
    )
    return [m.strip() for m in pattern.findall(uncommented)]


def _compose_default() -> str:
    defaults = {
        re.fullmatch(r"\$\{" + _KEY + r":-(\d+)\}", v).group(1)
        for v in _values(_COMPOSE, _KEY)
    }
    assert len(defaults) == 1, f"compose sets {_KEY} to several defaults: {defaults}"
    return defaults.pop()


def test_k8s_sets_the_same_cache_cap_as_compose():
    assert _values(_CONFIGMAPS / "common-config.yaml", _KEY) == [_compose_default()]


def test_no_role_configmap_overrides_it_differently():
    expected = _compose_default()
    for name in ("viz-config.yaml", "controlplane-config.yaml", "worker-config.yaml"):
        assert set(_values(_CONFIGMAPS / name, _KEY)) <= {expected}, name
