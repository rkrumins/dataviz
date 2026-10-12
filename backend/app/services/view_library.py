"""A view's library: its display rules and its saved queries, and the pack
they are exported and imported in.

Display rules stay where they have always lived — in the view's
``referenceLayout``, and in a draft's layout overlay — so a draft keeps its
own until it is promoted, as its layout does. What changes is how they are
written: one rule at a time (added or replaced, removed, reordered), read and
written back under a row lock. Two people editing different rules both keep
their edits, and a layout save no longer carries the rules at all.

Saved queries belong to the view, not to a branch, in ``view_saved_queries``.

No write here touches the view's ``updated_at``. It keys the view's resolved
scope (``view_scope``), and neither a rule nor a saved query is part of that:
changing one must not throw away the view's search sessions or its property
catalog.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple

from pydantic import TypeAdapter, ValidationError as PydanticValidationError
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.db.models import ViewLayoutOverlayORM, ViewORM, ViewSavedQueryORM
from backend.app.db.repositories import view_repo
from backend.app.services.advanced_search_service import (
    ValidationError as SearchValidationError,
    _validate_predicate,
)
from backend.app.services.deep_search import CompileError, get_deep_search_settings
from backend.app.services.view_scope import _collect_content_scope, _collect_reference_roots
from backend.common.models.search import Predicate
from backend.common.models.view_library import (
    LIBRARY_QUERIES_MAX,
    LIBRARY_RULES_MAX,
    DisplayRule,
    ImportStrategy,
    LibraryImportItem,
    LibraryImportResult,
    LibraryPack,
    LibraryPackSource,
    SavedQuery,
    SavedQueryInput,
    ViewLibrary,
)

_PREDICATE = TypeAdapter(Predicate)


class LibraryError(Exception):
    """A request the library refuses: ``status`` is the HTTP answer."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Predicates
# ---------------------------------------------------------------------------

def _check_predicate(raw: Any, *, rule: bool) -> Any:
    """``raw`` validated as a search's predicate is — its shape, its typed
    values, its size — or a 422 naming what is wrong. A rule also refuses
    ``withinHops`` and paths: they describe a route through the graph, and a
    rule is asked about one entity at a time. And it refuses what the engines
    that count and tag it would (``_rule_compile_problem``): saved, such a
    rule failed every time the canvas asked about it."""
    try:
        model = _PREDICATE.validate_python(raw)
    except PydanticValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise LibraryError(422, f"invalid predicate{f' at {where}' if where else ''}: "
                                f"{first.get('msg', 'not a predicate')}") from exc
    try:
        leaves = _validate_predicate(model, path="$.predicate")
    except SearchValidationError as exc:
        raise LibraryError(422, str(exc)) from exc
    max_leaves = get_deep_search_settings().max_leaf_count
    if leaves > max_leaves:
        raise LibraryError(422, f"predicate has {leaves} leaves (max {max_leaves})")
    if rule and _has_route(model):
        raise LibraryError(422, "A rule can't use 'within hops' or a path: they describe "
                                "a route through the graph, not an entity.")
    if rule:
        problem = _rule_compile_problem(model)
        if problem:
            raise LibraryError(422, problem)
    return model


def _rule_compile_problem(model: Any) -> Optional[str]:
    """What the membership and count engines would refuse in ``model``: a
    regex or fulltext match, a descendantOf under OR or NOT… Its own shape
    only — the edge types are stand-ins, so a graph whose ontology is still
    loading refuses nothing here."""
    from backend.app.providers.falkordb_deep_search import _Compiler
    try:
        _Compiler(lineage_edge_types={"_"}, containment_edge_types={"_"}).compile(model)
    except CompileError as exc:
        return str(exc)
    return None


def _flag_invalid(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``rules`` as a client is given them. A bundle import or a version
    restore stores a view's rules as given, and rules saved before this
    library checked them never were: one a rule may not be comes with
    ``invalid`` saying why, so it is shown as a rule that can't be counted
    rather than sent with the others (one bad predicate fails the batch it
    is counted in). What is stored is not changed."""
    out = []
    for rule in rules:
        try:
            _check_predicate(rule.get("predicate"), rule=True)
            out.append(rule)
        except LibraryError as exc:
            out.append({**rule, "invalid": exc.detail})
    return out


def _has_route(model: Any) -> bool:
    if getattr(model, "kind", None) in ("withinHops", "path"):
        return True
    return any(_has_route(c) for c in getattr(model, "children", None) or [])


def _entity_types_of(model: Any) -> List[str]:
    """The entity types an ``entityType`` leaf of the tree names."""
    out: List[str] = []
    if getattr(model, "kind", None) == "entityType":
        out.extend(getattr(model, "values", None) or [])
    for child in getattr(model, "children", None) or []:
        out.extend(_entity_types_of(child))
    return out


def _canonical(predicate: Any) -> str:
    return json.dumps(predicate, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Rules: in the view's referenceLayout, or a draft's overlay
# ---------------------------------------------------------------------------

def _published_layout(config: Dict[str, Any]) -> Dict[str, Any]:
    """The referenceLayout the published rules live in — the one
    ``view_repo._base_reference_layout`` reads, legacy spelling included —
    made when the view has none."""
    layout = config.get("layout")
    if isinstance(layout, dict) and isinstance(layout.get("referenceLayout"), dict):
        return layout["referenceLayout"]
    if isinstance(config.get("referenceLayout"), dict):
        return config["referenceLayout"]
    if not isinstance(layout, dict):
        layout = config["layout"] = {}
    layout["referenceLayout"] = {}
    return layout["referenceLayout"]


def _rules_of(layout: Any) -> List[Dict[str, Any]]:
    rules = layout.get("displayRules") if isinstance(layout, dict) else None
    return [r for r in rules if isinstance(r, dict)] if isinstance(rules, list) else []


async def _view(session: AsyncSession, view_id: str, *, lock: bool = False) -> ViewORM:
    query = select(ViewORM).where(ViewORM.id == view_id, ViewORM.deleted_at.is_(None))
    if lock:
        # populate_existing: the row may already be in the session, loaded
        # before the lock; read what the lock holds, not that.
        query = query.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(query)).scalar_one_or_none()
    if row is None:
        raise LibraryError(404, f"View '{view_id}' not found")
    return row


async def read_rules(session: AsyncSession, view: ViewORM,
                     branch_id: Optional[str]) -> List[Dict[str, Any]]:
    """The rules a canvas on ``branch_id`` shows: the draft's own, once it
    has an overlay, else the published ones."""
    config = await view_repo.effective_view_config(session, view, branch_id)
    return _rules_of(view_repo._base_reference_layout(config))


async def _write_rules(session: AsyncSession, view_id: str, branch_id: Optional[str],
                       change: Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]
                       ) -> List[Dict[str, Any]]:
    """Read the rules under a lock, ``change`` them, write them back —
    without touching the view's ``updated_at``. A draft's first write gives
    it its overlay, which forks the published layout as a layout edit does."""
    if branch_id:
        await _view(session, view_id)
        await view_repo.ensure_overlay(session, view_id, branch_id)
        overlay = (await session.execute(
            select(ViewLayoutOverlayORM).where(
                ViewLayoutOverlayORM.view_id == view_id,
                ViewLayoutOverlayORM.branch_id == branch_id,
            ).with_for_update().execution_options(populate_existing=True)
        )).scalar_one()
        layout = json.loads(overlay.reference_layout or "{}")
        if not isinstance(layout, dict):
            layout = {}
        rules = change(_rules_of(layout))
        layout["displayRules"] = rules
        overlay.reference_layout = json.dumps(layout)
    else:
        row = await _view(session, view_id, lock=True)
        config = json.loads(row.config or "{}")
        if not isinstance(config, dict):
            config = {}
        layout = _published_layout(config)
        rules = change(_rules_of(layout))
        layout["displayRules"] = rules
        text = json.dumps(config)
        # A Core UPDATE that assigns updated_at to itself, so the column's
        # onupdate doesn't stamp it (as the versioning fan-out does); the
        # loaded row is kept in step without being marked dirty.
        await session.execute(
            update(ViewORM).where(ViewORM.id == view_id)
            .values(config=text, updated_at=ViewORM.updated_at)
            .execution_options(synchronize_session=False)
        )
        set_committed_value(row, "config", text)
    await session.flush()
    return _flag_invalid(rules)


async def put_rule(session: AsyncSession, view_id: str, branch_id: Optional[str],
                   rule: DisplayRule) -> List[Dict[str, Any]]:
    """Add ``rule``, or replace the one with its id where it stands."""
    _check_predicate(rule.predicate, rule=True)
    stored = rule.model_dump(by_alias=True, exclude_none=True)
    stored.setdefault("createdAt", _now())

    def change(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        clash = next((r for r in rules if r.get("id") != rule.id
                      and str(r.get("name", "")).strip().lower() == rule.name.strip().lower()), None)
        if clash is not None:
            raise LibraryError(409, f"A rule named '{rule.name}' already exists in this view.")
        for i, r in enumerate(rules):
            if r.get("id") == rule.id:
                stored["createdAt"] = r.get("createdAt") or stored["createdAt"]
                return rules[:i] + [stored] + rules[i + 1:]
        if len(rules) >= LIBRARY_RULES_MAX:
            raise LibraryError(422, f"A view holds at most {LIBRARY_RULES_MAX} display rules.")
        return rules + [stored]

    return await _write_rules(session, view_id, branch_id, change)


async def delete_rule(session: AsyncSession, view_id: str, branch_id: Optional[str],
                      rule_id: str) -> List[Dict[str, Any]]:
    return await _write_rules(session, view_id, branch_id,
                              lambda rules: [r for r in rules if r.get("id") != rule_id])


def _reordered(items: List[Any], ids: List[str], id_of: Callable[[Any], str]) -> List[Any]:
    """``items`` in the order ``ids`` names them; any it leaves out keep
    their order after those."""
    rank = {item_id: i for i, item_id in enumerate(ids)}
    return sorted(items, key=lambda it: rank.get(id_of(it), len(rank)))  # stable


async def order_rules(session: AsyncSession, view_id: str, branch_id: Optional[str],
                      ids: List[str]) -> List[Dict[str, Any]]:
    return await _write_rules(session, view_id, branch_id,
                              lambda rules: _reordered(rules, ids, lambda r: r.get("id")))


# ---------------------------------------------------------------------------
# Saved queries: the view's own, whatever the branch
# ---------------------------------------------------------------------------

def _query_of(row: ViewSavedQueryORM) -> SavedQuery:
    return SavedQuery(
        id=row.id, name=row.name, description=row.description,
        predicate=json.loads(row.predicate or "{}"),
        created_at=row.created_at, created_by=row.created_by,
        updated_at=row.updated_at, updated_by=row.updated_by,
    )


async def _query_rows(session: AsyncSession, view_id: str) -> List[ViewSavedQueryORM]:
    return list((await session.execute(
        select(ViewSavedQueryORM).where(ViewSavedQueryORM.view_id == view_id)
        .order_by(ViewSavedQueryORM.position, ViewSavedQueryORM.created_at)
    )).scalars())


async def read_queries(session: AsyncSession, view_id: str) -> List[SavedQuery]:
    return [_query_of(row) for row in await _query_rows(session, view_id)]


async def put_query(session: AsyncSession, view_id: str, query_id: str,
                    body: SavedQueryInput, *, actor: Optional[str]) -> SavedQuery:
    """Save a query under ``query_id``: a new one, or a new name, description
    or predicate for one this view already has."""
    _check_predicate(body.predicate, rule=False)
    await _view(session, view_id)
    rows = await _query_rows(session, view_id)
    if any(r.id != query_id and r.name.strip().lower() == body.name.strip().lower() for r in rows):
        raise LibraryError(409, f"A query named '{body.name}' is already saved in this view.")
    row = next((r for r in rows if r.id == query_id), None)
    if row is None:
        taken = (await session.execute(
            select(ViewSavedQueryORM.view_id).where(ViewSavedQueryORM.id == query_id)
        )).scalar_one_or_none()
        if taken is not None:
            raise LibraryError(409, f"Query id '{query_id}' is taken.")
        if len(rows) >= LIBRARY_QUERIES_MAX:
            raise LibraryError(422, f"A view holds at most {LIBRARY_QUERIES_MAX} saved queries.")
        now = _now()
        row = ViewSavedQueryORM(
            id=query_id, view_id=view_id,
            position=max((r.position for r in rows), default=-1) + 1,
            name=body.name, description=body.description,
            predicate=json.dumps(body.predicate),
            created_by=actor, created_at=now, updated_by=actor, updated_at=now,
        )
        session.add(row)
    else:
        row.name, row.description = body.name, body.description
        row.predicate = json.dumps(body.predicate)
        row.updated_by, row.updated_at = actor, _now()
    await session.flush()
    return _query_of(row)


async def delete_query(session: AsyncSession, view_id: str, query_id: str) -> bool:
    result = await session.execute(delete(ViewSavedQueryORM).where(
        ViewSavedQueryORM.view_id == view_id, ViewSavedQueryORM.id == query_id))
    await session.flush()
    return bool(result.rowcount)


async def order_queries(session: AsyncSession, view_id: str, ids: List[str]) -> None:
    rows = await _query_rows(session, view_id)
    for position, row in enumerate(_reordered(rows, ids, lambda r: r.id)):
        row.position = position
    await session.flush()


# ---------------------------------------------------------------------------
# The library, the pack
# ---------------------------------------------------------------------------

async def read_library(session: AsyncSession, view: ViewORM, branch_id: Optional[str],
                       *, can_edit: bool) -> ViewLibrary:
    return ViewLibrary(
        view_id=view.id, branch_id=branch_id or None,
        display_rules=_flag_invalid(await read_rules(session, view, branch_id)),
        saved_queries=await read_queries(session, view.id),
        can_edit=can_edit,
    )


async def export_pack(session: AsyncSession, view: ViewORM,
                      branch_id: Optional[str]) -> LibraryPack:
    return LibraryPack(
        exported_at=_now(),
        source=LibraryPackSource(view_id=view.id, view_name=view.name,
                                 branch_id=branch_id or None),
        display_rules=await read_rules(session, view, branch_id),
        saved_queries=[
            q.model_dump(by_alias=True, exclude_none=True,
                         include={"id", "name", "description", "predicate"})
            for q in await read_queries(session, view.id)
        ],
    )


def _unique_name(name: str, taken: set) -> str:
    """``name``, or ``name (2)``, ``name (3)``… — the first no other item
    in the view has."""
    if name.lower() not in taken:
        return name
    n = 2
    while True:
        candidate = f"{name[:110]} ({n})"
        if candidate.lower() not in taken:
            return candidate
        n += 1


async def _view_entity_types(session: AsyncSession, view: ViewORM,
                             branch_id: Optional[str]) -> FrozenSet[str]:
    """The entity types the view limits itself to (lower-cased) — as its
    resolved scope reads them — or none when it shows every type."""
    config = await view_repo.effective_view_config(session, view, branch_id)
    _, layout_types, _ = _collect_reference_roots(config)
    _, content_types, _ = _collect_content_scope(config)
    return frozenset(t.lower() for t in layout_types | content_types)


def _type_warnings(model: Any, allowed: FrozenSet[str]) -> List[str]:
    if not allowed:
        return []
    missing = sorted({t for t in _entity_types_of(model) if t.lower() not in allowed})
    if not missing:
        return []
    return [f"Refers to entity types this view doesn't show: {', '.join(missing)}"]


def _plan(kind: str, incoming: List[Dict[str, Any]], existing: List[Dict[str, Any]],
          strategy: ImportStrategy, allowed: FrozenSet[str], limit: int,
          validate: Callable[[Dict[str, Any]], Tuple[Dict[str, Any], Any]]
          ) -> Tuple[List[LibraryImportItem], List[Dict[str, Any]]]:
    """What an import does with each incoming item of one kind — and the
    items it adds, ids new and names made unique."""
    keep = [] if strategy == "replace" else existing
    taken = {str(e.get("name", "")).lower() for e in keep}
    known = {(str(e.get("name", "")).lower(), _canonical(e.get("predicate"))) for e in keep}
    items: List[LibraryImportItem] = []
    added: List[Dict[str, Any]] = []
    for raw in incoming:
        name = str(raw.get("name") or "").strip() if isinstance(raw, dict) else ""
        source_id = str(raw.get("id")) if isinstance(raw, dict) and raw.get("id") else None
        try:
            if not isinstance(raw, dict):
                raise LibraryError(422, "not an object")
            item, model = validate(raw)
        except LibraryError as exc:
            items.append(LibraryImportItem(kind=kind, source_id=source_id, name=name or "(unnamed)",
                                           action="refuse", reason=exc.detail))
            continue
        warnings = _type_warnings(model, allowed)
        if strategy == "merge" and (name.lower(), _canonical(item["predicate"])) in known:
            items.append(LibraryImportItem(kind=kind, source_id=source_id, name=name,
                                           action="skip", reason="Already in this view.",
                                           warnings=warnings))
            continue
        if len(keep) + len(added) >= limit:
            items.append(LibraryImportItem(
                kind=kind, source_id=source_id, name=name, action="refuse",
                reason=f"The view would hold more than {limit}."))
            continue
        unique = _unique_name(name, taken)
        taken.add(unique.lower())
        known.add((unique.lower(), _canonical(item["predicate"])))
        added.append({**item, "id": f"{kind}_{uuid.uuid4().hex[:12]}", "name": unique})
        items.append(LibraryImportItem(kind=kind, source_id=source_id, name=name, action="add",
                                       new_name=unique if unique != name else None,
                                       warnings=warnings))
    return items, added


async def import_pack(session: AsyncSession, view: ViewORM, branch_id: Optional[str],
                      pack: LibraryPack, *, strategy: ImportStrategy, dry_run: bool,
                      actor: Optional[str], can_edit: bool) -> LibraryImportResult:
    """What importing ``pack`` into the view does, item by item — and, unless
    ``dry_run``, does it. ``merge`` adds what the view doesn't have (the same
    name and criteria is skipped; a taken name gets a number); ``replace``
    removes the view's rules and queries first; ``copy`` adds everything.
    Every item added gets a new id. An item naming entity types the view
    doesn't show is added with a warning: it matches nothing here."""
    allowed = await _view_entity_types(session, view, branch_id)
    rules_now = await read_rules(session, view, branch_id)
    query_rows = await _query_rows(session, view.id)
    queries_now = [{"name": r.name, "predicate": json.loads(r.predicate or "{}")}
                   for r in query_rows]

    def rule_of(raw: Dict[str, Any]):
        try:
            rule = DisplayRule.model_validate({**raw, "id": str(raw.get("id") or "incoming")})
        except PydanticValidationError as exc:
            raise LibraryError(422, _first_error(exc)) from exc
        model = _check_predicate(rule.predicate, rule=True)
        stored = rule.model_dump(by_alias=True, exclude_none=True)
        stored.setdefault("createdAt", _now())
        return stored, model

    def query_of(raw: Dict[str, Any]):
        try:
            body = SavedQueryInput.model_validate(raw)
        except PydanticValidationError as exc:
            raise LibraryError(422, _first_error(exc)) from exc
        model = _check_predicate(body.predicate, rule=False)
        return body.model_dump(by_alias=True, exclude_none=True), model

    rule_items, new_rules = _plan("rule", pack.display_rules, rules_now, strategy, allowed,
                                  LIBRARY_RULES_MAX, rule_of)
    query_items, new_queries = _plan("query", pack.saved_queries, queries_now, strategy, allowed,
                                     LIBRARY_QUERIES_MAX, query_of)
    items = rule_items + query_items
    result = LibraryImportResult(
        strategy=strategy, dry_run=dry_run, items=items,
        added=sum(i.action == "add" for i in items),
        skipped=sum(i.action == "skip" for i in items),
        refused=sum(i.action == "refuse" for i in items),
        removed=(len(rules_now) + len(queries_now)) if strategy == "replace" else 0,
    )
    if dry_run:
        return result

    if strategy == "replace" or new_rules:
        await _write_rules(session, view.id, branch_id,
                           lambda rules: (new_rules if strategy == "replace"
                                          else rules + new_rules))
    if strategy == "replace":
        await session.execute(delete(ViewSavedQueryORM).where(
            ViewSavedQueryORM.view_id == view.id))
        start = 0
    else:
        start = (await session.execute(
            select(func.max(ViewSavedQueryORM.position))
            .where(ViewSavedQueryORM.view_id == view.id)
        )).scalar_one_or_none()
        start = (start + 1) if start is not None else 0
    now = _now()
    for i, q in enumerate(new_queries):
        session.add(ViewSavedQueryORM(
            id=q["id"], view_id=view.id, position=start + i, name=q["name"],
            description=q.get("description"), predicate=json.dumps(q["predicate"]),
            created_by=actor, created_at=now, updated_by=actor, updated_at=now,
        ))
    await session.flush()
    result.library = await read_library(session, view, branch_id, can_edit=can_edit)
    return result


def _first_error(exc: PydanticValidationError) -> str:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()))
    return f"{where}: {first.get('msg', 'invalid')}" if where else first.get("msg", "invalid")
