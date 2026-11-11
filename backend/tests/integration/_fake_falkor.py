"""A FalkorDB fake that times out the way a real one does under pressure.

``TimeoutGraph`` is the projection tests' in-memory ``FakeGraph`` (it interprets the projector's
Cypher) with a timeout policy on top. It raises FalkorDB's own ``Query timed out``, which
``falkordb_provider._pressure_kind`` reads as a timeout, when:
- a statement's row list (``$batch``, ``$urns``, ``$ids``, ``$pairs``) holds more than
  ``max_rows`` rows;
- a ``DETACH DELETE`` would take a node with more than ``hub_degree`` relationships;
- the statement is the ``fail_after``-th one (a single mid-window failure);
- a statement writes an entity in ``poison``, named by urn, entity id or edge id.

It also answers the hub-safe delete's shapes: a page of a node's relationships deleted, and
whether any are left.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from backend.tests.integration.test_versioning_projection import FakeFalkor, FakeGraph, _Result

_TIMEOUT = "Query timed out"
#: A poisoned entity's writes time out; reading it does not (a large payload is slow to write).
_WRITES = re.compile(r"\b(MERGE|DELETE|SET)\b")
_PAGE_DELETE = re.compile(r"MATCH \(n:([^ ]+) \{urn: \$u\}\)-\[r\]-\(\) WITH DISTINCT r LIMIT \$k DELETE r")
_ANY_LEFT = re.compile(r"MATCH \(n:([^ ]+) \{urn: \$u\}\)-\[r\]-\(\) RETURN 1 LIMIT 1")


class TimeoutGraph(FakeGraph):
    def __init__(self, *, max_rows: Optional[int] = None, hub_degree: Optional[int] = None,
                 fail_after: Optional[int] = None, poison: Iterable[str] = ()) -> None:
        super().__init__()
        self.max_rows, self.hub_degree, self.fail_after = max_rows, hub_degree, fail_after
        self.poison = set(poison)
        self.statements = 0
        self.timeouts = 0
        self.sizes: list = []
        self.cyphers: list = []

    def _incident(self, urn: str) -> list:
        return [k for k, e in self.edges.items() if urn in (e["src"], e["tgt"])]

    @staticmethod
    def _names(rows) -> set:
        out = set()
        for row in rows:
            if isinstance(row, dict):
                out.update(str(v) for k, v in row.items() if k in ("urn", "eid", "entityId", "src", "tgt"))
            else:
                out.add(str(row))
        return out

    def _time_out(self):
        self.timeouts += 1
        return Exception(_TIMEOUT)

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        self.statements += 1
        self.cyphers.append(cypher)
        if self.fail_after is not None and self.statements == self.fail_after:
            raise self._time_out()
        rows = next((params[k] for k in ("batch", "urns", "ids", "pairs")
                     if isinstance(params.get(k), list)), None)
        if rows is not None:
            self.sizes.append(len(rows))
            if self.max_rows is not None and len(rows) > self.max_rows:
                raise self._time_out()
            if self.poison and self._names(rows) & self.poison and _WRITES.search(cypher):
                raise self._time_out()
            if (self.hub_degree is not None and "DETACH DELETE n" in cypher
                    and any(len(self._incident(u)) > self.hub_degree
                            for u in ([r if isinstance(r, str) else r.get("urn") for r in rows]))):
                raise self._time_out()
        m = _PAGE_DELETE.fullmatch(cypher)
        if m:
            if params["u"] in self.poison:
                raise self._time_out()
            for k in self._incident(params["u"])[:int(params["k"])]:
                self.edges.pop(k, None)
            return None
        if _ANY_LEFT.fullmatch(cypher):
            return _Result([[1]] if self._incident(params["u"]) else [])
        return await super().query(cypher, params)


class TimeoutFalkor(FakeFalkor):
    """One :class:`TimeoutGraph` per graph name, all with the same policy."""

    def __init__(self, **policy) -> None:
        super().__init__()
        self.policy = policy

    def __call__(self, name: str, provider_id=None) -> TimeoutGraph:
        return self.graphs.setdefault(name, TimeoutGraph(**self.policy))
