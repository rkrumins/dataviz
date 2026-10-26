"""The edge types a search names, as the data source spells them.

A person names an edge type in any case — ``produces``, ``Produces`` — and
the graph keeps its own spelling, which FalkorDB matches exactly. An engine
reads every named type through ``spell_edge_types``: matched whatever its
case, and refused — naming the nearest type — when the data source has
none by that name, rather than a condition that silently matches nothing.
"""
from __future__ import annotations

from difflib import get_close_matches
from typing import Iterable, List, Mapping, Optional, Sequence

from backend.app.services.deep_search.contracts import CompileError


def spell_edge_types(names: Iterable[str], spellings: Optional[Mapping[str, Sequence[str]]],
                     *, containment: Iterable[str] = (), link: bool = False) -> List[str]:
    """How the data source spells each of ``names``. ``spellings`` maps each
    type it has, in upper case, to its spellings there (None: not known —
    the names are taken as given). ``link``: the edges a relationship to a
    linked entity walks, which are never the hierarchy's."""
    contains = {str(t).upper() for t in containment}
    out: List[str] = []
    for name in names:
        key = str(name).upper()
        if link and key in contains:
            raise CompileError(
                f"{name} is a containment edge — follow it with Contains or Is inside "
                "(child, descendant, parent, ancestor) instead")
        if spellings is None:
            out.append(name)
            continue
        if key not in spellings:
            near = get_close_matches(key, sorted(spellings), n=1)
            hint = f" — did you mean {near[0]}?" if near else ""
            raise CompileError(f"Edge type '{name}' isn't in this data source{hint}")
        out.extend(spellings[key])
    return list(dict.fromkeys(out))
