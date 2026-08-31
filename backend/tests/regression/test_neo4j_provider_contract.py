"""Neo4j contract test — pins every ABC method's response shape.

Env vars (only NEO4J_TEST_HOST is required):

    NEO4J_TEST_HOST       -- required to run; TCP-checked before connecting.
    NEO4J_TEST_PORT       -- defaults to the descriptor's default port (7687).
    NEO4J_TEST_GRAPH      -- the target database name; defaults to a
                             per-process "test_regression_<pid>" name (set
                             this to your server's actual database, e.g.
                             "neo4j", if it isn't Enterprise-Edition
                             multi-database).
    NEO4J_TEST_TLS        -- "1"/"true" to connect via bolt+s.
    NEO4J_TEST_USERNAME / NEO4J_TEST_PASSWORD -- defaults to Neo4jProvider's
                             own default ("neo4j" / "") when unset.

Distinct from `NEO4J_URI` / `NEO4J_USERNAME` / `NEO4J_PASSWORD` /
`NEO4J_DATABASE` (documented in backend/scripts/README.md for other
scripts) -- this test builds its provider through the catalog, which
wants discrete host/port/tls fields, not a combined URI.

Run before Phase C (Neo4j reshape onto the shared base):

    UPDATE_PROVIDER_SNAPSHOTS=1 \\
        NEO4J_TEST_HOST=localhost NEO4J_TEST_PASSWORD=test \\
        pytest backend/tests/regression/test_neo4j_provider_contract.py -v

    # Env unset -> reports skipped, never failed:
    pytest backend/tests/regression/test_neo4j_provider_contract.py -v
"""
from __future__ import annotations

from . import _runner


async def _cleanup(provider) -> None:
    """Neo4j's deletion primitive: DETACH DELETE everything under the
    urn:test: prefix this fixture writes."""
    try:
        await provider._run_write(
            "MATCH (n) WHERE n.urn STARTS WITH 'urn:test:' DETACH DELETE n",
            {},
        )
    except Exception:
        pass


test_neo4j_provider_contract = _runner.make_contract_test(
    "neo4j", env_prefix="NEO4J_TEST", cleanup=_cleanup,
)
