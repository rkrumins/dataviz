"""LIVE: FalkorDB's name search finds exactly what its match modes say — needs a real FalkorDB.

``FalkorDBProvider.search_names`` is what a past revision's name search reads of the store as it is
now (``DraftOverlayProvider.search_names`` corrects it by what changed since). Over a seeded graph
of mixed-case names, qualified names, a name kept only under ``name`` and two labels, every
(query, match mode, type filter) it is asked pages — three at a time, following its positions —
through exactly the nodes the Python reference (``name_matches``) picks, each once, in (name, urn)
order.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_names_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from backend.common.interfaces.provider import name_matches

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live name search.",
    ),
    # One event loop for the module: the provider's connections belong to it.
    pytest.mark.asyncio(loop_scope="module"),
]

#: (label, urn, displayName, qualifiedName); None leaves the property unset.
ROWS = [
    ("Table", "urn:t:1", "Orders", "sales.orders"),
    ("Table", "urn:t:2", "orders_archive", "sales.orders_archive"),
    ("Table", "urn:t:3", "Customer Orders", "crm.customer_orders"),
    ("Table", "urn:t:4", "Payments", None),
    ("Table", "urn:t:5", "ORDERS", "legacy.ORDERS"),
    ("Column", "urn:c:1", "order_id", "sales.orders.order_id"),
    ("Column", "urn:c:2", "Reorders", "sales.orders.reorders"),
    ("Column", "urn:c:3", "amount", "sales.payments.amount"),
    ("Column", "urn:c:4", None, "sales.orders.note"),
]
#: Named only under ``name``, as an id-keyed source keeps it: found by that name.
NAMED_ONLY = ("Table", "urn:t:6", "orders by name")


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"names_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    await p._ensure_connected()
    for label in ("Table", "Column"):
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        rows = [{"urn": u, "displayName": d, "qualifiedName": q}
                for lbl, u, d, q in ROWS if lbl == label]
        await p._graph.query(
            f"UNWIND $rows AS r CREATE (n:{label} {{urn: r.urn}}) "
            "SET n.displayName = r.displayName, n.qualifiedName = r.qualifiedName", {"rows": rows})
    await p._graph.query("CREATE (:Table {urn: $urn, name: $name})",
                         {"urn": NAMED_ONLY[1], "name": NAMED_ONLY[2]})
    try:
        yield p
    finally:
        await p._graph.delete()


def _want(q, match, types):
    rows = [(lbl, u, d, qn) for lbl, u, d, qn in ROWS] + [(*NAMED_ONLY, None)]
    return sorted(u for lbl, u, d, qn in rows
                  if (not types or lbl in types)
                  and (name_matches(d, q.lower(), match) or name_matches(qn, q.lower(), match)))


@pytest.mark.parametrize("q,match,types", [
    ("orders", "substring", None),
    ("ORDERS", "exact", None),
    ("order", "prefix", None),
    ("orders", "suffix", ["Table"]),
    ("sales.orders", "prefix", ["Column"]),
    ("orders", "substring", ["Column"]),
    ("by name", "suffix", None),
    ("nothing", "substring", None),
])
async def test_a_name_search_finds_what_its_mode_says(provider, q, match, types):
    seen, offset = [], 0
    for _ in range(20):
        page = await provider.search_names(q, match=match, entity_types=types, limit=3,
                                           offset=offset)
        seen += [n.urn for n in page.nodes]
        if not page.has_more:
            break
        offset = page.next_offset
    assert sorted(seen) == _want(q, match, types) and len(seen) == len(set(seen)), seen


async def test_an_empty_query_finds_nothing(provider):
    page = await provider.search_names("  ")
    assert page.nodes == [] and not page.has_more
