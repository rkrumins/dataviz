"""Where an entity sits, as the five columns every file of entities carries.

The trace dock's file (``frontend/src/hooks/lib/traceExport.ts``) wrote them first. A member set's
download, a data export (every format, a view package's data included), a view file's manifest and
a search's export write the same five, meaning the same thing:

* ``parentUrn``, ``parentName``, ``parentType``: its direct container, empty at the top of the
  graph;
* ``path``: every container it sits in, by name, from the top of the graph down to its parent;
* ``pathUrns``: the same chain by URN.

NDJSON and JSON keep ``path`` and ``pathUrns`` as lists. A text cell (CSV, TSV, Excel) reads
``A / B`` and ``a; b`` (:data:`JOINED`): a URN may hold a ``/``.

They are informational. They say where a row came from and nothing more, so every import ignores
them: the record contract declares them as such (``import_export.contract``), the row model never
reads them (``rowmodel.normalize``), and the browser's simple files never make them properties. A
file exported with them imports exactly as it would without them.
"""
from __future__ import annotations

from collections import ChainMap
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

ANCESTRY_COLUMNS = ("parentUrn", "parentName", "parentType", "path", "pathUrns")
#: How a path is one text cell, as the trace dock's file writes it.
JOINED = {"path": " / ", "pathUrns": "; "}
#: Entities per chain read, and containers per name lookup.
CHUNK = 1_000
#: Container names one file keeps, so each is read once however many rows sit in it. Past it, a
#: name is read again for the rows that need it rather than held.
NAMES_MAX = 100_000

#: What an export's ``withPath`` option adds, as every route that takes it says.
WITH_PATH = ("Each entity's parent and path (parentUrn, parentName, parentType, path, pathUrns): "
             "informational columns, which an import ignores. One containment read for every "
             "thousand entities")

#: A container's name and type, by URN.
Names = Dict[str, Tuple[str, str]]
Chains = Callable[[List[str]], Awaitable[Dict[str, List[str]]]]
Lookup = Callable[[List[str]], Awaitable[Names]]


def empty() -> Dict[str, Any]:
    """The five columns, unknown."""
    return dict.fromkeys(ANCESTRY_COLUMNS)


def chains_to_columns(chain: Sequence[str], names: Mapping[str, Tuple[str, str]]) -> Dict[str, Any]:
    """An entity's five columns from its containment chain — its containers' URNs, parent first
    and root last, as ``get_ancestor_chains`` gives them — and their names and types by URN. A
    container ``names`` lacks reads as its URN. An empty chain is an entity at the top of the
    graph: an empty path, and no parent."""
    top_down = list(reversed(chain))
    out: Dict[str, Any] = {**empty(), "path": [names.get(a, (a, ""))[0] for a in top_down],
                           "pathUrns": top_down}
    if top_down:
        out["parentUrn"] = top_down[-1]
        out["parentName"], out["parentType"] = names.get(top_down[-1], (top_down[-1], ""))
    return out


def joined(record: Dict[str, Any]) -> Dict[str, Any]:
    """``record`` with its path lists as text cells (:data:`JOINED`); itself when it has none."""
    lists = {c: sep.join(record[c]) for c, sep in JOINED.items() if isinstance(record.get(c), list)}
    return {**record, **lists} if lists else record


async def place(records: List[Dict[str, Any]], chains: Chains, lookup: Lookup, known: Names) -> None:
    """Fill the five columns of ``records``, each named by its ``urn``, :data:`CHUNK` at a time:
    ``chains(urns)`` reads their containment chains (``get_ancestor_chains``'s answer, where an
    urn it could not answer for is absent and its cells stay empty), and ``lookup(urns)`` names
    the containers ``known`` lacks, which it then keeps for the next pages, up to
    :data:`NAMES_MAX`. A source that reads no chains (``NotImplementedError``) leaves every cell
    empty."""
    for i in range(0, len(records), CHUNK):
        chunk = [r for r in records[i:i + CHUNK] if r.get("urn")]
        if not chunk:
            continue
        try:
            found = await chains([r["urn"] for r in chunk])
        except NotImplementedError:
            return
        unnamed = sorted({a for r in chunk for a in found.get(r["urn"]) or () if a not in known})
        fresh: Names = {}
        for j in range(0, len(unnamed), CHUNK):
            fresh.update(await lookup(unnamed[j:j + CHUNK]))
        for urn, named in fresh.items():
            if len(known) >= NAMES_MAX:
                break
            known[urn] = named
        names = ChainMap(fresh, known)
        for r in chunk:
            chain = found.get(r["urn"])
            if chain is not None:
                r.update(chains_to_columns(chain, names))


# ── Read leniently ─────────────────────────────────────────────────────────────────────────────
# A file that comes back carries the columns as whatever its editor made of them (a spreadsheet
# reads a container named 2024 as a number). Nothing reads them, so a value that doesn't fit is
# read as nothing rather than refusing the row or the file.

_SCALAR = (str, int, float, bool)


def informational_text(value: Any) -> Optional[str]:
    """A ``parentUrn``/``parentName``/``parentType`` value as text, or ``None``."""
    return str(value) if isinstance(value, _SCALAR) else None


def informational_path(value: Any) -> Optional[Union[List[str], str]]:
    """A ``path``/``pathUrns`` value: its list, its text cell, or ``None``."""
    if isinstance(value, list):
        return [str(v) for v in value] if all(isinstance(v, _SCALAR) for v in value) else None
    return informational_text(value)
