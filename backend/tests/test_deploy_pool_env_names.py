"""A pool-sizing env var that nothing reads is worse than one left unset.

``deploy/k8s/base/configmaps/viz-config.yaml`` carried
``DB_GRAPH_READ_MAX_OVERFLOW`` for a long time. The name the engine resolves
is ``DB_GRAPH_READ_POOL_MAX_OVERFLOW``, so the setting was simply ignored: the
overflow stayed at the code default and the pool ran two connections wider
than the manifest said, with no warning anywhere — os.getenv on a name nobody
sets is a silent default, not an error.

That went unnoticed because nothing depended on the number. Now something
does: the graph admission gate sizes its ceiling and its per-source reserve
from ``pool_size + max_overflow`` (``providers/manager.py::_graph_inflight_limits``),
so a misspelled key moves the shed thresholds too.

The legal names are derived here rather than listed, so adding a PoolRole or a
new knob to ``engine.py`` keeps this honest without an edit.
"""
from __future__ import annotations

import re
from pathlib import Path

from backend.app.db.engine import PoolRole

_ROOT = Path(__file__).resolve().parent.parent.parent
_ENGINE = _ROOT / "backend" / "app" / "db" / "engine.py"

# Pool-sizing-shaped keys only: anything with POOL or OVERFLOW in the name.
# Narrow enough to leave the other ``DB_*`` keys alone (``DB_INIT_DSN``,
# ``DB_CONNECT_TIMEOUT_SECS`` — consumed by jobs and scripts, not by the
# engine) and wide enough to catch the near-miss that started this, which
# omitted POOL entirely.
#
# Assignment-shaped lines only (``KEY: value`` in YAML, ``KEY=value`` in
# .env), commented or not — a commented example is how a wrong name gets
# copied into a real manifest in the first place.
_SHAPE = r"DB_[A-Z_]*(?:POOL|OVERFLOW)[A-Z_]*"
_ASSIGNMENT = re.compile(rf"^\s*#?\s*({_SHAPE})\s*[:=]", re.M)


def _legal_names() -> set[str]:
    """Every pool-shaped name the engine actually reads."""
    source = _ENGINE.read_text()
    names = set(re.findall(rf'os\.getenv\(\s*"({_SHAPE})"', source))
    # The per-role knobs are built from an f-string, so they are not literals.
    for role in PoolRole:
        prefix = f"DB_{role.value.upper()}_"
        names.add(f"{prefix}POOL_SIZE")
        names.add(f"{prefix}POOL_MAX_OVERFLOW")
    return names


def _files() -> list[Path]:
    return [
        *sorted((_ROOT / "deploy").rglob("*.yaml")),
        *sorted(_ROOT.glob("docker-compose*.yml")),
        _ROOT / ".env.example",
    ]


def test_every_pool_env_name_in_deployment_config_is_one_the_engine_reads():
    legal = _legal_names()
    unknown: list[str] = []

    for path in _files():
        for name in _ASSIGNMENT.findall(path.read_text()):
            if name not in legal:
                unknown.append(f"{path.relative_to(_ROOT)}: {name}")

    assert not unknown, (
        "These pool-sizing variables are set (or documented) under a name the "
        "engine never reads, so they silently do nothing:\n  "
        + "\n  ".join(unknown)
        + "\nLegal names: " + ", ".join(sorted(legal))
    )


def test_the_graph_read_knobs_are_among_the_legal_names():
    """Guards the guard: a regex that matched nothing would also pass above."""
    legal = _legal_names()
    assert "DB_GRAPH_READ_POOL_SIZE" in legal
    assert "DB_GRAPH_READ_POOL_MAX_OVERFLOW" in legal
    assert "DB_GRAPH_READ_MAX_OVERFLOW" not in legal
