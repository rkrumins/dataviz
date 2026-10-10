"""The control plane runs the platform's housekeeping loops.

The outbox relay (which fills the activity ledger), the product-event and
refresh-token retention sweeps and the analytics warmer were all gated on
``runs_scheduler()`` in ``main.py`` — but the shipped topologies run the web
tier as ``SYNODIC_ROLE=web`` and the control plane as a different app
(``aggregation/controlplane.py``), so none of them ran anywhere but a dev-role
monolith. The ledger never filled, and two tables grew without bound. These
tests pin:

* the topology contract — the control plane's lifespan starts all four, and
  the monolith still does;
* the order of shutdown — they stop before Redis and the database pools close;
* the warmer reads through the READONLY pool, off the JOBS pool the job API
  needs;
* the loops import in a cold process with no signing secret and none of the
  web tier — the control plane must start without either.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

_APP = Path(__file__).resolve().parents[1] / "app"
_REPO_ROOT = str(Path(__file__).resolve().parents[2])
_LOOPS = ("run_relay(", "run_product_event_gc(", "run_refresh_token_gc(", "run_warmer(")


def _controlplane() -> str:
    return (_APP / "services" / "aggregation" / "controlplane.py").read_text()


@pytest.mark.parametrize("call", _LOOPS)
def test_the_control_plane_starts_every_housekeeping_loop(call):
    assert call in _controlplane(), f"controlplane.py lifespan must start {call}…)"


def test_the_monolith_still_starts_them_on_the_scheduler_role():
    source = (_APP / "main.py").read_text()
    for module in ("outbox_relay", "refresh_token_gc", "product_event_gc", "analytics_warmer"):
        assert f"services.{module} import" in source


def test_housekeeping_stops_before_redis_and_the_pools_close():
    source = _controlplane()
    stop = source.index("housekeeping_shutdown.set()")
    assert source.index("yield") < stop < source.index("await close_redis()")
    assert stop < source.index("await close_db()")


def test_the_warmer_reads_through_the_readonly_pool():
    assert "run_warmer(get_readonly_session" in _controlplane()


def test_the_loops_import_without_a_signing_secret_or_the_web_tier():
    source = textwrap.dedent("""
        import sys
        import backend.app.services.outbox_relay
        import backend.app.services.product_event_gc
        import backend.app.services.refresh_token_gc
        import backend.app.services.analytics_warmer
        bad = sorted(
            m for m in sys.modules
            if m.startswith(("backend.app.api", "backend.app.auth", "backend.auth_service.core"))
        )
        print("\\n".join(bad))
    """)
    result = subprocess.run(
        [sys.executable, "-c", source], capture_output=True, text=True, timeout=180,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": _REPO_ROOT, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.returncode == 0, result.stderr[-4000:]
    assert result.stdout.strip() == "", (
        "the housekeeping loops pulled in web-tier or auth-config modules:\n"
        + result.stdout
    )
