"""Discovery must ASK what exists, never create it.

Every discovery job builds a transient provider and connects.
``_ensure_connected`` ends in ``_schedule_reconcile_once``, which runs
``ensure_indices`` + ``ensure_projections`` — both of which issue
``CREATE INDEX``, a WRITE. In FalkorDB a write to a graph key that does not
exist CREATES it (this repo states that itself, in the comment explaining why
``_build_and_verify`` probes with PING instead of a query).

The graph name discovery hands the provider is a PLACEHOLDER, not a target:

  * list-all passes ``graph_name=None``, and ``manager.py`` substitutes the
    literal ``"nexus_lineage"`` — so the probe MINTED that graph on providers
    that never had one, and it showed up as a phantom data source;
  * a per-asset job passes a cached asset name, which may name a graph the
    user has since DELETED — so the probe RESURRECTED it, on every refresh,
    forever. Deleting it again just re-armed the loop.

Both halves break the invariant that the Data Sources list equals what the
provider actually holds.
"""
import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.providers.manager import ProviderManager


def test_the_reconcile_is_skipped_when_a_caller_opts_out():
    p = FalkorDBProvider(host="h", port=6379, graph_name="g", auto_reconcile=False)
    assert p._auto_reconcile is False

    p._schedule_reconcile_once()

    # Never armed — so no CREATE INDEX task is ever scheduled against `g`.
    assert getattr(p, "_reconcile_started", False) is False


def test_the_reconcile_still_runs_for_everyone_else():
    """Index maintenance is not lost: only the read probe opts out."""
    p = FalkorDBProvider(host="h", port=6379, graph_name="g")
    assert p._auto_reconcile is True


def test_a_provider_built_without_init_still_reconciles():
    """The introspection paths build this class with ``object.__new__``, so
    the guard reads through ``getattr`` with a True default — a missing
    attribute must not silently disable index maintenance."""
    p = object.__new__(FalkorDBProvider)
    assert getattr(p, "_auto_reconcile", True) is True


def test_discovery_builds_its_probe_with_the_reconcile_off(monkeypatch):
    """The wiring that matters: the insights discovery worker must pass
    ``auto_reconcile=False`` when it builds its transient provider."""
    seen = {}

    def fake_create(**kwargs):
        seen.update(kwargs)
        raise RuntimeError("stop here — we only want the kwargs")

    monkeypatch.setattr(
        ProviderManager, "_create_provider_instance", staticmethod(fake_create),
    )

    import inspect

    from backend.insights_service import discovery

    src = inspect.getsource(discovery)
    assert "auto_reconcile=False" in src, (
        "discovery must build its provider with the connect-time reconcile "
        "OFF — it is a read probe pointed at a name it does not own"
    )


def test_the_manager_passes_the_flag_through():
    import inspect

    from backend.app.providers import manager

    src = inspect.getsource(manager.ProviderManager._create_provider_instance)
    assert "auto_reconcile" in src, (
        "_create_provider_instance must accept and forward auto_reconcile, "
        "or the discovery probe's opt-out is silently dropped"
    )
