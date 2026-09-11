"""THE TUNING GUIDE IS ONLY USEFUL IF ITS NUMBERS ARE STILL TRUE.

`docs/CONCURRENCY_TUNING.md` exists to be read during an incident, and its whole
value is the arithmetic: six ceilings, what each one is, and the rule that orders
the deadlines between them. A number that has drifted is worse than no number,
because someone will act on it at 3am.

These tests read the values out of the doc and compare them against the code that
actually decides them. They are deliberately narrow — they check the figures the
doc commits to, not its prose.
"""
import re
from pathlib import Path

import pytest

_DOC = Path(__file__).resolve().parents[2] / "docs" / "CONCURRENCY_TUNING.md"


@pytest.fixture(scope="module")
def doc() -> str:
    assert _DOC.exists(), f"{_DOC} is missing — the deployment docs link to it"
    return _DOC.read_text()


def test_the_ladder_table_matches_the_code(doc):
    """The six ceilings, read OUT OF THE DOC and compared against the code that
    decides them. Comparing the code against literals repeated in this file would
    only catch code drift; the failure mode that matters is the doc going stale
    while the code moves on."""
    from backend.app.config import resilience as R
    from backend.app.db.engine import PoolRole, _POOL_DEFAULTS
    from backend.app.providers import manager as M

    gr = _POOL_DEFAULTS[PoolRole.GRAPH_READ]
    hard, reserved = M._graph_inflight_limits()

    # (what the doc row must contain, the code's value)
    documented = [
        (r"ASGI request tier \|[^|]*?(\d+)s aggregation", R.HTTP_TIMEOUT_AGGREGATION_SECS),
        (r"ASGI request tier \|[^|]*?(\d+)s graph", R.HTTP_TIMEOUT_GRAPH_SECS),
        (r"Per-source admission gate \|[^|]*?\*\*(\d+)\*\*", hard),
        (r"`GRAPH_READ` DB session \|[^|]*?pool_size (\d+)", gr["pool_size"]),
        (r"`GRAPH_READ` DB session \|[^|]*?overflow (\d+)", gr["max_overflow"]),
        (r"Provider semaphore \|[^|]*?\*\*(\d+)\*\*", M._MAX_PROVIDER_CONCURRENCY),
        (r"Provider semaphore \|[^|]*?\+(\d+) waiters", M._SLOT_MAX_WAITERS),
        (r"Provider semaphore \|[^|]*?(\d+)s wait", M._SEMAPHORE_ACQUIRE_BUDGET_S),
    ]
    drifted = []
    for pattern, actual in documented:
        found = re.search(pattern, doc)
        if not found:
            drifted.append((pattern, "row missing or reworded", actual))
        elif float(found.group(1)) != float(actual):
            drifted.append((pattern, found.group(1), actual))
    assert not drifted, (
        "the ladder table in §1 no longer matches the code (pattern, doc says, code says): "
        f"{drifted}. The fleet arithmetic below it derives from these numbers."
    )

    # The per-source reserve is stated in prose in §2, not in the table.
    assert re.search(rf"default `pool // 8` = {reserved}\)", doc), (
        f"§2 no longer states the per-source reserve as {reserved}"
    )


def test_the_deadline_ordering_rule_actually_holds(doc):
    """§1 states: every outer deadline must outlast the one inside it. The doc is
    where that rule is written down, so it is also where a violation should be
    caught — an inversion means the outer layer cancels work the inner layer
    keeps doing, which is the shape of the outage this whole document exists
    downstream of."""
    from backend.app.config import resilience as R

    assert R.FALKORDB_AGGREGATED_READ_BUDGET_SECS < R.HTTP_TIMEOUT_AGGREGATION_SECS
    assert R.FALKORDB_EDGES_BETWEEN_TIMEOUT_SECS < R.HTTP_TIMEOUT_GRAPH_SECS
    assert R.FALKORDB_NODES_QUERY_TIMEOUT_SECS < R.HTTP_TIMEOUT_GRAPH_SECS


def test_the_fleet_arithmetic_is_self_consistent(doc):
    """The doc multiplies per-process ceilings by 12 worker processes. If either
    factor moves, the conclusion — that the app tier can present more concurrency
    than the store can execute — has to be re-derived, not assumed."""
    workers = re.search(r"GUNICORN_WORKERS (\d+)\s+= (\d+) worker processes", doc)
    assert workers, "§1 no longer states the worker count it multiplies by"
    per_pod, total = int(workers.group(1)), int(workers.group(2))
    replicas = total // per_pod
    assert total == replicas * per_pod, "the worker arithmetic in §1 does not multiply out"

    from backend.app.providers import manager as M
    hard, _ = M._graph_inflight_limits()
    assert re.search(rf"{total} × {hard}\s+= {total * hard} in flight", doc), (
        "the admitted-requests line in §1 no longer matches "
        f"{total} workers × {hard} admitted"
    )
    assert re.search(rf"{total} ×\s+{M._MAX_PROVIDER_CONCURRENCY}\s+=\s+{total * M._MAX_PROVIDER_CONCURRENCY} per provider", doc), (
        "the concurrent-FalkorDB-calls line in §1 no longer matches "
        f"{total} workers × {M._MAX_PROVIDER_CONCURRENCY} slots"
    )


def test_the_changed_values_table_matches_the_code(doc):
    """§3 lists what recently changed. These are the values an upgrading operator
    is told to stop overriding, so a wrong "Now" column sends them to pin the
    old one."""
    from backend.app.config import resilience as R
    from backend.app.services.aggregation.graph_store_limits import THREAD_COUNT_ASSUMED
    from backend.app.providers import manager as M

    for label, actual in [
        ("`THREAD_COUNT_ASSUMED`", THREAD_COUNT_ASSUMED),
        ("`FALKORDB_NODES_QUERY_TIMEOUT`", int(R.FALKORDB_NODES_QUERY_TIMEOUT_SECS)),
        ("`HTTP_TIMEOUT_GRAPH_SECS`", int(R.HTTP_TIMEOUT_GRAPH_SECS)),
        ("`PROVIDER_SLOT_MAX_WAITERS`", M._SLOT_MAX_WAITERS),
    ]:
        row = re.search(rf"^\| {re.escape(label)} \|.*?\| \*\*([\d.]+)\*\* \|", doc, re.M)
        assert row, f"§3 has no row for {label}"
        assert float(row.group(1)) == float(actual), (
            f"§3 says {label} is now {row.group(1)}; the code says {actual}"
        )


def test_every_doc_it_points_at_exists(doc):
    """A troubleshooting guide whose links 404 is a guide nobody trusts twice."""
    missing = [
        target for target in re.findall(r"\]\((([A-Z_0-9]+)\.md)\)", doc)
        if not (_DOC.parent / target[0]).exists()
    ]
    assert not missing, f"CONCURRENCY_TUNING.md links to missing docs: {missing}"
