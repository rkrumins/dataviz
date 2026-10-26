"""Which entities a name reference names.

A reference names an entity by its path of display names from a top-level
entity (``Country / United Kingdom``), with ``**`` for any number of levels
(``Country / ** / London``), or from anywhere in the search's scope when it
starts with ``**``. The semantics are ``StubDeepSearchProvider._named``'s;
the live test holds this module to them.

Every step is an index seek or a short walk:

* a first name is a per-label ``displayName`` index seek, kept to entities
  inside no other;
* a name after a name walks one containment level down;
* ``**`` then a name seeks that name and keeps the entities with an
  ancestor in the set so far. Upward walks are cheap (S0 A7); a downward
  walk of a large subtree is not, so it is used only when the name is so
  common the seek would hand back too many;
* a leading ``**`` seeks the name and keeps what lies in the search's scope.

Ignoring case reads names instead of seeking them, which is why a path with
``**`` compares exactly (the model refuses the other). A share link's
references are kept to its view.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_deep_search import (
    _hydrate_ancestors,
    _sanitize_label,
    _searchable_labels,
)
from backend.app.providers.falkordb_search.plan import _containment, _ids_of, _rel
from backend.common.models.search import NODE_REF_ANY_DEPTH, NODE_REF_MATCHES_MAX

#: How far below its anchor a ``**`` looks.
REF_ANY_DEPTH_MAX = 20
#: The most entities one step of a path may hand to the next.
REF_STEP_MAX = 1_000
#: A name this common is found by walking down from the anchors instead.
_SEEK_MAX = 5_000

_RESOLVED: Dict[Tuple, Tuple[List[str], Optional[str]]] = {}
_RESOLVED_MAX = 2048


async def resolve_refs(provider, scope, refs: Sequence[Any], *, run, data_version: str = "",
                       confined: bool = False, with_paths: bool = False,
                       timeout_s: float = 5.0) -> List[Dict[str, Any]]:
    """One answer per reference: ``{"urns", "entities", "error"}``, the
    entities listing at most ``SEARCH_RESOLVE_MATCHES_SHOWN`` — each with
    its ``ancestorPath`` when ``with_paths``. ``run(cypher, params)``
    executes one statement under the caller's admission."""
    resolver = _Resolver(provider, scope, run, confined)
    answers = []
    for ref in refs:
        key = _cache_key(provider, data_version, scope, ref, confined)
        cached = _RESOLVED.get(key) if key else None
        if cached is None:
            cached = await resolver.resolve(ref, timeout_s)
            if key:
                if len(_RESOLVED) >= _RESOLVED_MAX:
                    _RESOLVED.pop(next(iter(_RESOLVED)))
                _RESOLVED[key] = cached
        urns, error = cached
        answers.append({"urns": list(urns), "error": error, "entities": []})
    shown = {u for a in answers for u in a["urns"][:10]}
    entities = await resolver.describe(sorted(shown), with_paths=with_paths)
    for answer in answers:
        answer["entities"] = [entities[u] for u in answer["urns"][:10] if u in entities]
    return answers


def _cache_key(provider, data_version: str, scope, ref, confined: bool) -> Optional[Tuple]:
    """Answers hold for one graph at one data version — never cached
    without one."""
    if not data_version:
        return None
    return (str(getattr(provider, "_graph_name", "") or ""), data_version,
            ref.model_dump_json(by_alias=True),
            tuple(scope.root_urns or ()), int(scope.max_depth or 12),
            tuple(sorted(scope.entity_types or ())), scope.scope_mode, confined)


class _Resolver:
    def __init__(self, provider, scope, run, confined: bool) -> None:
        self._provider = provider
        self._scope = scope
        self._run = run
        self._confined = confined
        self._labels: Optional[List[str]] = None
        self._roots: Optional[List[int]] = None
        self._rel = _rel(_containment(provider))

    async def resolve(self, ref, timeout_s: float) -> Tuple[List[str], Optional[str]]:
        if ref.urn is not None and not self._confined:
            return [ref.urn], None
        self._labels = self._labels or await _searchable_labels(self._provider,
                                                                timeout_s=timeout_s)
        if ref.urn is not None:
            # A share link learns nothing of an entity outside its view, not
            # even by naming it: the picker would show its name and type.
            ids = await self._in_scope(await _ids_of(self._run, self._labels, [ref.urn]))
            return ([ref.urn] if ids else []), None
        if not self._rel:
            return [], ("containment edge types are not configured for this data "
                        "source, so a name path can't be followed")
        segments = list(ref.path)
        exact = ref.case_sensitive
        if segments[0] == NODE_REF_ANY_DEPTH:
            ids = await self._in_scope(await self._seek(segments[1]))
            rest = segments[2:]
        else:
            ids = await self._top_level(segments[0], exact)
            rest = segments[1:]
        walked = [segments[0]] if segments[0] != NODE_REF_ANY_DEPTH else segments[:2]
        while rest and ids:
            if len(ids) > REF_STEP_MAX:
                return [], (f"'{' / '.join(walked)}' reaches more than {REF_STEP_MAX} "
                            "entities — name a narrower path")
            if rest[0] == NODE_REF_ANY_DEPTH:
                ids = await self._below(ids, rest[1])
                walked += rest[:2]
                rest = rest[2:]
            else:
                ids = await self._children(ids, rest[0], exact)
                walked.append(rest[0])
                rest = rest[1:]
        if self._confined and ids:
            ids = await self._in_scope(ids)
        rows = await self._rows(ids)
        if ref.entity_type:
            wanted = ref.entity_type.lower()
            rows = [r for r in rows if str(r[2] or "").lower() == wanted]
        urns = sorted({str(r[0]) for r in rows if r[0]})
        if len(urns) > NODE_REF_MATCHES_MAX:
            return [], (f"'{ref.label()}' names more than {NODE_REF_MATCHES_MAX} "
                        "entities — name a deeper path or a type")
        return urns, None

    # --- steps ----------------------------------------------------------------

    def _name_test(self, var: str, exact: bool) -> str:
        return (f"{var}.displayName = $_name" if exact
                else f"toLower(toString({var}.displayName)) = $_name")

    async def _top_level(self, name: str, exact: bool) -> List[int]:
        """Entities inside no other, by name: an index seek when exact."""
        union = " UNION ALL ".join(
            f"MATCH (_r:`{_sanitize_label(lbl)}`) WHERE {self._name_test('_r', exact)} "
            f"AND NOT (_r)<-[:{self._rel}]-() RETURN ID(_r) AS id"
            for lbl in self._labels or ())
        if not union:
            return []
        return await self._ids(union, {"_name": name if exact else name.lower()})

    async def _seek(self, name: str) -> List[int]:
        """Every entity with this exact name, through the per-label index."""
        union = " UNION ALL ".join(
            f"MATCH (_r:`{_sanitize_label(lbl)}`) WHERE _r.displayName = $_name "
            "RETURN ID(_r) AS id" for lbl in self._labels or ())
        return await self._ids(union, {"_name": name}) if union else []

    async def _children(self, ids: List[int], name: str, exact: bool) -> List[int]:
        return await self._ids(
            "UNWIND $_ids AS _i MATCH (_p) WHERE ID(_p) = _i "
            f"MATCH (_p)-[:{self._rel}]->(_c) WHERE {self._name_test('_c', exact)} "
            "RETURN DISTINCT ID(_c)",
            {"_ids": ids, "_name": name if exact else name.lower()})

    async def _below(self, anchors: List[int], name: str) -> List[int]:
        """``**`` then ``name``: entities so named with an ancestor among
        ``anchors``, at most ``REF_ANY_DEPTH_MAX`` levels up."""
        found = await self._seek(name)
        if len(found) <= _SEEK_MAX:
            return await self._ids(
                "UNWIND $_ids AS _i MATCH (_c) WHERE ID(_c) = _i "
                f"MATCH (_c)<-[:{self._rel}*1..{REF_ANY_DEPTH_MAX}]-(_a) "
                "WHERE ID(_a) IN $_anchors RETURN DISTINCT ID(_c)",
                {"_ids": found, "_anchors": anchors})
        # So common a name that checking each one upward would cost more
        # than walking down from the anchors; stop just past the step cap.
        return await self._ids(
            "UNWIND $_ids AS _i MATCH (_p) WHERE ID(_p) = _i "
            f"MATCH (_p)-[:{self._rel}*1..{REF_ANY_DEPTH_MAX}]->(_c) "
            "WHERE _c.displayName = $_name RETURN DISTINCT ID(_c) LIMIT $_lim",
            {"_ids": anchors, "_name": name, "_lim": REF_STEP_MAX + 1})

    async def _in_scope(self, ids: List[int]) -> List[int]:
        """The entities inside the search's scope: below its roots, or of
        its entity types when it has none. The whole data source in
        ``data_source`` mode — except for a share link, held to its view."""
        scope = self._scope
        if not ids or (scope.scope_mode == "data_source" and not self._confined):
            return ids
        if scope.root_urns:
            if self._roots is None:
                self._roots = await _ids_of(self._run, self._labels or [], scope.root_urns)
            if not self._roots:
                return []
            return await self._ids(
                "UNWIND $_ids AS _i MATCH (_c) WHERE ID(_c) = _i "
                f"MATCH (_c)<-[:{self._rel}*0..{int(scope.max_depth or 12)}]-(_s) "
                "WHERE ID(_s) IN $_roots RETURN DISTINCT ID(_c)",
                {"_ids": ids, "_roots": self._roots})
        if scope.entity_types:
            wanted = [t.lower() for t in scope.entity_types]
            return await self._ids(
                "UNWIND $_ids AS _i MATCH (_c) WHERE ID(_c) = _i "
                "AND toLower(labels(_c)[0]) IN $_types RETURN ID(_c)",
                {"_ids": ids, "_types": wanted})
        return ids

    async def _rows(self, ids: List[int]) -> List[list]:
        if not ids:
            return []
        res = await self._run(
            "UNWIND $_ids AS _i MATCH (_n) WHERE ID(_n) = _i "
            "RETURN _n.urn, _n.displayName, labels(_n)[0]", {"_ids": ids})
        return list(res.result_set or [])

    async def _ids(self, cypher: str, params: Dict[str, Any]) -> List[int]:
        res = await self._run(cypher, params)
        return sorted({int(r[0]) for r in res.result_set or [] if r and r[0] is not None})

    # --- what the picker shows ------------------------------------------------

    async def describe(self, urns: List[str], *, with_paths: bool) -> Dict[str, Dict[str, Any]]:
        """Name and type of each urn, and its containers when asked."""
        if not urns:
            return {}
        self._labels = self._labels or await _searchable_labels(self._provider, timeout_s=5.0)
        union = " UNION ALL ".join(
            f"MATCH (_n:`{_sanitize_label(lbl)}`) WHERE _n.urn IN $_urns "
            "RETURN _n.urn AS urn, _n.displayName AS name, labels(_n)[0] AS type"
            for lbl in self._labels or ())
        out: Dict[str, Dict[str, Any]] = {}
        if union:
            res = await self._run(union, {"_urns": urns})
            for urn, name, label in res.result_set or []:
                out[str(urn)] = {"urn": str(urn), "displayName": str(name or ""),
                                 "entityType": str(label or "")}
        for urn in urns:
            out.setdefault(urn, {"urn": urn, "displayName": "", "entityType": ""})
        if with_paths:
            hits = [SimpleNamespace(node=SimpleNamespace(urn=u), ancestor_path=None) for u in urns]
            await _hydrate_ancestors(self._provider, hits)
            for hit in hits:
                out[hit.node.urn]["ancestorPath"] = [
                    json.loads(a.model_dump_json(by_alias=True)) for a in hit.ancestor_path or []]
        return out
