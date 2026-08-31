"""FalkorDB contract test — pins every ABC method's response shape.

Env vars (only FALKORDB_HOST is required; the rest have sensible
defaults matching how the rest of the app already configures FalkorDB —
see DEVELOPER_GUIDE.md / .github/workflows/backend-tests.yml):

    FALKORDB_HOST       -- required to run; TCP-checked before connecting.
    FALKORDB_PORT       -- defaults to the descriptor's default port (6379).
    FALKORDB_GRAPH      -- defaults to a per-process "test_regression_<pid>" name.
    FALKORDB_TLS        -- "1"/"true" to connect with TLS.
    FALKORDB_USERNAME / FALKORDB_PASSWORD -- auth, when the instance requires it.

Run before Phase B (FalkorDB reshape onto the shared base):

    # Capture baseline (against the existing FalkorDB provider).
    UPDATE_PROVIDER_SNAPSHOTS=1 \\
        FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
        pytest backend/tests/regression/test_falkordb_provider_contract.py -v

    # During the reshape, run without UPDATE_PROVIDER_SNAPSHOTS:
    pytest backend/tests/regression/test_falkordb_provider_contract.py -v

    # Env unset -> reports skipped, never failed:
    pytest backend/tests/regression/test_falkordb_provider_contract.py -v

A diff means the reshape has changed externally observable behaviour —
fix the reshape, not the snapshot.
"""
from __future__ import annotations

# Registers "falkordb" in the provider catalog as an import side effect.
# `_runner.make_contract_test` resolves "falkordb" through the catalog,
# and (per `backend.common.providers.catalog`'s own docstring) FalkorDB
# is the one type that importing the catalog package alone does not
# register -- its concrete class lives under `backend.app`, which the
# dependency-free kernel package cannot import.
import backend.app.providers.falkordb  # noqa: F401

from . import _runner


async def _cleanup(provider) -> None:
    """FalkorDB's deletion primitive: drop the whole test graph."""
    try:
        await provider._graph.delete()
    except Exception:
        pass


test_falkordb_provider_contract = _runner.make_contract_test(
    "falkordb", env_prefix="FALKORDB", cleanup=_cleanup,
)
