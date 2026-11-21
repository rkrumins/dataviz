"""The tools the model may call, and what each one does with the platform.

Every tool reads through :class:`PlatformClient` as the person asking, and
returns two things:

* **for the person** — blocks on the turn (a results card, an impact report,
  a query, a clarification), with the full data and every caveat;
* **for the model** — a compact summary with the data policy applied and the
  rows bounded, so a million-entity answer costs a few hundred tokens.

Tools never return raw graphs to the model. Counts are exact where the
platform can count exactly, and say "at least" where it cannot.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from ..llm.types import ToolSpec
from ..platform_client import PlatformClient, PlatformError
from . import concepts as C
from . import predicates as P
from .events import Turn, new_id
from .grounding import Grounding, Target, default_view, entity_summary
from .policy import DataPolicy
from .state import ConversationState

logger = logging.getLogger(__name__)

PREDICATE_SCHEMA = {
    "type": "object",
    "description": (
        "A search predicate in the platform's SearchQuery grammar (see the system prompt). "
        "May contain {\"kind\":\"resultSet\",\"ref\":\"r1\"} for an earlier result and "
        "{\"kind\":\"concept\",\"name\":\"PII\"} for a confirmed business term."
    ),
}


@dataclass
class ToolContext:
    client: PlatformClient
    grounding: Grounding
    state: ConversationState
    turn: Turn
    policy: DataPolicy
    user_id: str
    user_name: str
    user_email: str
    session_scope: Callable[[], Any]
    question: str = ""
    knowledge: Any = None
    persona: str = "data"
    brand: str = ""
    #: Choices already made, by clarification id (query drafting resends them).
    choices: dict[str, str] = field(default_factory=dict)
    #: Set when a tool asked the person something: the turn ends there.
    stopped: bool = False
    used: list[str] = field(default_factory=list)

    @property
    def target(self) -> Target:
        return self.grounding.target


@dataclass(frozen=True)
class Tool:
    spec: ToolSpec
    run: Callable[[ToolContext, dict], Awaitable[Any]]
    label: str
    personas: tuple[str, ...] = ("data",)


class ToolFailed(Exception):
    """A tool could not do what was asked; the message is for the model."""


# ── Shared helpers ──────────────────────────────────────────────────────


def entity(node: dict, *, path: Optional[list] = None, g: Optional[Grounding] = None) -> dict:
    out = {"urn": node.get("urn"), "name": node.get("displayName") or node.get("name") or node.get("urn"),
           "type": (g.display_type(node) if g else None) or node.get("entityType") or node.get("type")}
    if path:
        out["path"] = [p.get("displayName") or p.get("name") for p in path if isinstance(p, dict)]
    return out


async def ensure_searchable(ctx: ToolContext) -> Target:
    """A view to bind searches to — the current one, or one of the data
    source's when the question names a source but no view."""
    target = ctx.target
    if target.searchable:
        return target
    if target.workspace_id:
        view = await default_view(ctx.client, target.workspace_id, target.data_source_id)
        if view:
            from . import grounding as G

            fresh = await G.build(ctx.client, user_id=ctx.user_id, view_only=target.view_only,
                                  include_values=ctx.policy.send_sample_values,
                                  context={"viewId": view.get("id"), "workspaceId": target.workspace_id,
                                           "dataSourceId": target.data_source_id or view.get("dataSourceId")})
            ctx.grounding.adopt(fresh)
            await load_type_property(ctx)
            ctx.turn.notice(f"Searched through **{view.get('name')}**, this data source's most used view.")
            return ctx.target
    raise ToolFailed(
        "No data source is in context. Ask the person which data source or view they mean, "
        "or use find_views to find one, then call set_context.",
    )


def _scope_mode(args: dict, target: Target) -> str:
    mode = str(args.get("scope") or "view")
    return mode if mode in ("view", "data_source") else "view"


async def prepare_predicate(ctx: ToolContext, raw: Any, *, applies_to: Optional[str] = None) -> Optional[dict]:
    """Expand and validate a model-written predicate. Returns None when a
    concept needs the person first (the clarification has been sent)."""
    target = ctx.target

    def result_set(ref: str) -> Optional[dict]:
        found = ctx.state.result(ref)
        return found.predicate if found else None

    def concept(name: str, _applies: Optional[str]) -> Optional[dict]:
        confirmed = ctx.state.confirmed(name, target.data_source_id)
        return confirmed["predicate"] if confirmed else None

    try:
        expanded = P.expand(raw, result_set=result_set, concept=concept)
    except P.ConceptNeeded as needed:
        resolution = await resolve_concept_flow(ctx, needed.name, applies_to=needed.applies_to or applies_to)
        if resolution.status in ("mapped", "auto"):
            return await prepare_predicate(ctx, raw, applies_to=applies_to)
        if resolution.status == "missing":
            raise ToolFailed(json.dumps(resolution.for_model()))
        return None
    except P.PredicateInvalid as exc:
        raise ToolFailed(str(exc))
    expanded = await _read_types(ctx, expanded)
    if expanded is None:
        return None
    try:
        return P.validate(expanded)
    except P.PredicateInvalid as exc:
        raise ToolFailed(str(exc))


async def _read_types(ctx: ToolContext, predicate: Any) -> Optional[Any]:
    """Entity types the data source doesn't have: a spelling to correct, a
    kind of thing read through the confirmed type property, a question to
    the person (once) about which property says what kind each entity is —
    or an error naming the types it does have."""
    g = ctx.grounding
    real = g.real_type_ids()
    named = P.entity_type_values(predicate)
    if not real or named <= real:
        return predicate
    by_lower = {t.lower(): t for t in real}
    predicate = P.map_types(predicate, lambda r: {**r, "values": [
        by_lower.get(str(v).lower(), v) for v in r.get("values") or []]})
    unknown = P.entity_type_values(predicate) - real
    if not unknown:
        return predicate
    if not g.type_property:
        offered = {str(v["value"]).lower() for c in g.type_candidates for v in c["values"]}
        if not any(_forms(u) & offered for u in unknown):
            raise ToolFailed(f"Unknown entity type(s): {', '.join(sorted(unknown))}. This data source's "
                             f"types are: {', '.join(sorted(real)[:30])}.")
        resolution = await resolve_concept_flow(ctx, C.TYPE_CONCEPT)
        if resolution.status not in ("mapped", "auto"):
            return None
    tp = g.type_property
    if not tp:
        return None
    known = {str(v["value"]) for v in g.display_types()}
    by_kind = {k.lower(): k for k in known}

    def kind_of(v: Any) -> Any:
        if v in real:
            return v
        return next((by_kind[f] for f in _forms(v) if f in by_kind), v)

    predicate = P.map_types(predicate, lambda r: {**r, "values": [kind_of(v) for v in r.get("values") or []]})
    kinds = (P.entity_type_values(predicate) - real) if not known else known
    return P.rewrite_types(predicate, on=tp["on"], key=tp["key"], kinds=kinds)


def _forms(word: Any) -> set[str]:
    """A kind as it may be asked for: "tables" for "table", "processes" for "process"."""
    w = str(word).lower()
    out = {w}
    if w.endswith("ies"):
        out.add(w[:-3] + "y")
    if w.endswith("es"):
        out.add(w[:-2])
    if w.endswith("s"):
        out.add(w[:-1])
    return out


async def load_type_property(ctx: ToolContext) -> None:
    async with ctx.session_scope() as session:
        ctx.grounding.type_property = await C.load_type_property(
            session, ctx.state, data_source_id=ctx.target.data_source_id, user_id=ctx.user_id)


async def resolve_concept_flow(ctx: ToolContext, name: str, *, applies_to: Optional[str] = None,
                               want: str = "predicate", synonyms: Optional[list[str]] = None,
                               scope_mode: str = "view") -> C.Resolution:
    target = await ensure_searchable(ctx)
    is_type = C.is_type_concept(name)
    confirmed = ctx.state.confirmed(name, target.data_source_id)
    if confirmed:
        if is_type:
            ctx.grounding.type_property = C.type_property_from(confirmed["predicate"])
        return C.Resolution("mapped", name, confirmed["label"], confirmed["predicate"],
                            property_key=confirmed.get("propertyKey"), source="conversation")
    if target.data_source_id:
        async with ctx.session_scope() as session:
            row = await C.stored(session, data_source_id=target.data_source_id,
                                 user_id=ctx.user_id, concept=name)
            if row is not None:
                row.uses = (row.uses or 0) + 1
                predicate = json.loads(row.predicate)
                ctx.state.confirm_concept(name, target.data_source_id, label=row.label,
                                          predicate=predicate)
                if is_type:
                    ctx.grounding.type_property = C.type_property_from(predicate)
                return C.Resolution("mapped", name, row.label, predicate, source=row.scope)
    if is_type:
        return _ask_type_property(ctx, target, name)
    candidates = C.candidates_from(ctx.grounding, name, synonyms=synonyms, want=want)
    if want == "predicate":
        glossary = ("tag", "glossaryterm", "term", "classification")
        entity_types = [t["id"] for t in ctx.grounding.entity_types
                        if C.norm(t.get("id")) in glossary or C.norm(t.get("name")) in glossary]
        candidates += await C.entity_candidates(ctx.client, target, name, entity_types)
    await C.count(ctx.client, target, candidates, scope_mode=scope_mode, applies_to=applies_to)
    live = [c for c in candidates if c.count]
    if not live:
        return C.Resolution("missing", name, candidates=candidates)
    picked = ctx.choices.get(C.clarification_id(name, target.data_source_id))
    if picked:
        chosen_predicate = (P.any_of(*(c.predicate for c in live)) if picked == "opt_any"
                            else next((c.predicate for c in live if c.id == picked), None))
        if chosen_predicate is not None:
            label = ("any of: " + "; ".join(c.label for c in live) if picked == "opt_any"
                     else next(c.label for c in live if c.id == picked))
            ctx.state.confirm_concept(name, target.data_source_id, label=label,
                                      predicate=chosen_predicate)
            return C.Resolution("mapped", name, label, chosen_predicate, source="choice",
                                candidates=live)
    if len(live) == 1 and live[0].exact:
        chosen = live[0]
        ctx.state.confirm_concept(name, target.data_source_id, label=chosen.label,
                                  predicate=chosen.predicate)
        ctx.turn.notice(f"Read “{name}” as {chosen.label} ({chosen.count:,} in scope).")
        return C.Resolution("auto", name, chosen.label, chosen.predicate,
                            property_key=chosen.property_key, source="data", candidates=live)
    applies_label = ctx.grounding.type_label(applies_to) if applies_to else "Entities"
    payload = C.clarification(name, live, applies_label=applies_label,
                              data_source_id=target.data_source_id)
    ctx.state.pending = {
        "id": payload["id"], "kind": "concept", "concept": name,
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "question": ctx.question,
        "options": {
            c.id: {"label": c.label, "predicate": c.predicate, "propertyKey": c.property_key}
            for c in live
        },
    }
    if len(live) >= 2:
        ctx.state.pending["options"]["opt_any"] = {
            "label": "any of: " + "; ".join(c.label for c in live),
            "predicate": P.any_of(*(c.predicate for c in live)), "propertyKey": None,
        }
    ctx.turn.clarify(payload)
    ctx.stopped = True
    return C.Resolution("ask", name, candidates=live, clarification=payload)


def _ask_type_property(ctx: ToolContext, target: Target, name: str) -> C.Resolution:
    """Which property says what kind of thing each entity is — asked once,
    with what each candidate holds; never assumed."""
    live = C.type_candidates(ctx.grounding)
    if not live:
        return C.Resolution("missing", name)
    picked = ctx.choices.get(C.clarification_id(name, target.data_source_id))
    chosen = next((c for c in live if c.id == picked), None)
    if chosen is not None:
        ctx.state.confirm_concept(name, target.data_source_id, label=chosen.label, predicate=chosen.predicate)
        ctx.grounding.type_property = C.type_property_from(chosen.predicate)
        return C.Resolution("mapped", name, chosen.label, chosen.predicate, source="choice", candidates=live)
    on = ctx.grounding.type_candidates[0]["on"]
    payload = C.clarification(
        name, live, applies_label=on, data_source_id=target.data_source_id, allow_any=False,
        question=f"Everything here is a ‘{on}’. Which property says what kind of thing each one is?")
    ctx.state.pending = {
        "id": payload["id"], "kind": "concept", "concept": name,
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "question": ctx.question,
        "options": {c.id: {"label": c.label, "predicate": c.predicate, "propertyKey": c.property_key}
                    for c in live},
    }
    ctx.turn.clarify(payload)
    ctx.stopped = True
    return C.Resolution("ask", name, candidates=live, clarification=payload)


def _aggregate_rows(page: dict, index: int) -> list[dict]:
    aggs = page.get("aggregates") or []
    if index >= len(aggs) or not isinstance(aggs[index], list):
        return []
    return aggs[index]


async def run_search(ctx: ToolContext, predicate: dict, *, title: str, scope_mode: str,
                     limit: int = 25, emit: bool = True) -> dict:
    target = await ensure_searchable(ctx)
    # What actually runs: a view read through a share stays inside the view.
    scope_mode = target.scope(scope_mode)["scopeMode"]
    query = {
        "predicate": predicate,
        "scope": target.scope(scope_mode),
        "options": {
            "results": "both", "pageSize": max(1, min(limit, 50)), "includeAncestorPath": True,
            "softDeadlineMs": 45000,
            "aggregations": [
                ({"by": "property", "propertyKey": ctx.grounding.type_property["key"], "maxBuckets": 12,
                  "sampleHitsPerBucket": 0} if ctx.grounding.type_property
                 else {"by": "entityType", "maxBuckets": 12, "sampleHitsPerBucket": 0}),
                {"by": "parent", "maxBuckets": 10, "sampleHitsPerBucket": 0},
            ],
        },
    }
    try:
        page = await ctx.client.search(target.workspace_id, target.data_source_id, query)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    hits = page.get("hits") or []
    total = page.get("totalCount")
    exact = page.get("countStatus") != "lowerBound" and page.get("status") != "running" \
        and not page.get("deadlineExceeded")
    by_type = [
        {"type": b.get("ancestorUrn") or b.get("ancestorDisplayName"),
         "label": ctx.grounding.type_label(b.get("ancestorUrn") or b.get("ancestorDisplayName") or ""),
         "count": b.get("matchCount")}
        for b in _aggregate_rows(page, 0)
    ]
    by_container = [
        {"entity": {"urn": b.get("ancestorUrn"), "name": b.get("ancestorDisplayName"),
                    "type": b.get("ancestorEntityType")}, "count": b.get("matchCount")}
        for b in _aggregate_rows(page, 1)
    ]
    items = [entity(h.get("node") or {}, path=h.get("ancestorPath"), g=ctx.grounding) for h in hits[:limit]]
    if total is None:
        total = sum(int(b.get("count") or 0) for b in by_type) or len(items)
    notes = list((page.get("scopeDiagnostics") or {}).get("notes") or [])
    if page.get("deadlineExceeded") or page.get("status") == "running":
        notes.append("The search ran out of time before it finished; the count is at least this many.")
    ref = ctx.state.add_result(
        label=title, predicate=predicate, workspace_id=target.workspace_id,
        data_source_id=target.data_source_id, view_id=target.view_id, scope_mode=scope_mode,
        total=total,
    )
    data = {
        "title": title, "total": total, "totalExact": exact, "byType": by_type,
        "byContainer": by_container, "items": items, "resultRef": ref.id,
        "query": {"predicate": predicate, "scopeMode": scope_mode},
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "viewId": target.view_id, "notes": notes,
    }
    if emit:
        ctx.turn.block("results", data)
        ctx.turn.add_actions([
            {"id": new_id("act"), "kind": "open_search", "label": "Open in Advanced Search",
             "payload": {"viewId": target.view_id, "predicate": predicate}},
        ])
    return {
        "resultRef": ref.id, "total": total, "exact": exact,
        "byType": [{"type": r["type"], "count": r["count"]} for r in by_type],
        "byContainer": [{"name": r["entity"]["name"], "type": r["entity"]["type"], "count": r["count"]}
                        for r in by_container[:8]],
        "sample": [{"urn": i["urn"], "name": i["name"], "type": i["type"], "path": i.get("path")}
                   for i in items],
        "notes": notes,
        "shownToPerson": "a results card with the counts, containers and first items",
    }


# ── Tools ───────────────────────────────────────────────────────────────


async def _search_entities(ctx: ToolContext, args: dict) -> Any:
    predicate = await prepare_predicate(ctx, args.get("predicate"))
    if predicate is None:
        return {"status": "waiting_for_person"}
    title = str(args.get("title") or "Matches")[:160]
    limit = int(args.get("limit") or 25)
    return await run_search(ctx, predicate, title=title, scope_mode=_scope_mode(args, ctx.target),
                            limit=limit)


async def _count_entities(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    rules = args.get("rules") or []
    if not isinstance(rules, list) or not rules:
        raise ToolFailed("Give rules: a list of {label, predicate}.")
    items, labels = [], {}
    for i, rule in enumerate(rules[:32]):
        predicate = await prepare_predicate(ctx, (rule or {}).get("predicate"))
        if predicate is None:
            return {"status": "waiting_for_person"}
        rid = f"c{i}"
        labels[rid] = str((rule or {}).get("label") or rid)
        items.append({"id": rid, "predicate": predicate})
    try:
        body = await ctx.client.counts(target.workspace_id, target.data_source_id,
                                       target.scope(_scope_mode(args, target)), items)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    out = []
    for rid, label in labels.items():
        row = (body.get("counts") or {}).get(rid) or {}
        out.append({"label": label, "count": row.get("count"),
                    "exact": row.get("status") == "complete" and not row.get("lowerBound"),
                    "error": row.get("error")})
    return {"counts": out, "complete": body.get("complete")}


async def _find_entities(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    names = args.get("names") or []
    if isinstance(names, str):
        names = [names]
    refs = []
    for name in names[:16]:
        if isinstance(name, list):
            path = [str(p) for p in name if str(p).strip()]
        else:
            path = [p.strip() for p in str(name).replace(" / ", "/").split("/") if p.strip()]
            if len(path) == 1:
                path = ["**", path[0]]
        # The platform compares names exactly under "**"; a full path may ignore case.
        ref: dict[str, Any] = {"path": path[:12], "caseSensitive": "**" in path}
        if args.get("entityType"):
            ref["entityType"] = str(args["entityType"])
        refs.append(ref)
    if not refs:
        raise ToolFailed("Give names to look up.")
    try:
        body = await ctx.client.resolve(target.workspace_id, target.data_source_id,
                                        target.scope(_scope_mode(args, target) if args.get("scope") else "data_source"),
                                        refs)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    out = []
    for name, result in zip(names, body.get("results") or []):
        matches = [
            {"urn": m.get("urn"), "name": m.get("displayName"), "type": m.get("entityType"),
             "path": [a.get("displayName") for a in m.get("ancestorPath") or []]}
            for m in result.get("matches") or []
        ]
        out.append({"name": name if isinstance(name, str) else "/".join(name),
                    "count": result.get("count"), "matches": matches, "error": result.get("error")})
    return {"results": out,
            "hint": "When a name has several matches, ask the person which one (ask_user) "
                    "unless the question makes it clear."}


async def _get_entity(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    urn = str(args.get("urn") or "")
    if not urn:
        raise ToolFailed("Give the entity's urn.")
    try:
        node = await ctx.client.get_node(target.workspace_id, target.data_source_id, urn,
                                         view_id=target.view_id)
        chain = await ctx.client.ancestors(target.workspace_id, target.data_source_id, urn,
                                           view_id=target.view_id)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    summary = entity_summary(node) or {}
    path = [c.get("displayName") for c in reversed(chain)]
    ctx.turn.block("entity", {
        "entity": {"urn": urn, "name": summary.get("name"), "type": summary.get("type"), "path": path},
        "description": summary.get("description"),
        "properties": [{"key": k, "value": v} for k, v in list((summary.get("properties") or {}).items())[:40]],
        "tags": summary.get("tags") or [],
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "viewId": target.view_id,
    })
    return {**summary, "path": path}


async def _resolve_concept(ctx: ToolContext, args: dict) -> Any:
    name = str(args.get("concept") or "").strip()
    if not name:
        raise ToolFailed("Name the concept.")
    want = "property" if args.get("want") == "property" else "predicate"
    synonyms = [str(s) for s in args.get("synonyms") or []][:12]
    resolution = await resolve_concept_flow(
        ctx, name, applies_to=args.get("appliesTo") or None, want=want, synonyms=synonyms,
        scope_mode=_scope_mode(args, ctx.target),
    )
    return resolution.for_model()


async def _property_values(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    key = str(args.get("key") or "")
    if not key:
        raise ToolFailed("Name the property key.")
    try:
        body = await ctx.client.values(target.workspace_id, target.data_source_id, target.view_id,
                                       key, q=args.get("q"), limit=int(args.get("limit") or 20))
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    if not ctx.policy.send_property_values:
        return {"key": key, "note": "Property values may not be shared with the model by policy.",
                "distinct": len((body or {}).get("values") or [])}
    return body


async def _show_query(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    predicate = await prepare_predicate(ctx, args.get("predicate"))
    if predicate is None:
        return {"status": "waiting_for_person"}
    count = None
    exact = False
    try:
        body = await ctx.client.counts(target.workspace_id, target.data_source_id,
                                       target.scope(_scope_mode(args, target)),
                                       [{"id": "q", "predicate": predicate}], budget_seconds=15)
        row = (body.get("counts") or {}).get("q") or {}
        count, exact = row.get("count"), row.get("status") == "complete"
    except PlatformError as exc:
        logger.info("show_query count failed: %s", exc)
    ctx.turn.block("query", {
        "language": "search", "predicate": predicate, "cypher": None,
        "explanation": str(args.get("explanation") or "")[:600],
        "assumptions": [str(a)[:200] for a in args.get("assumptions") or []][:6],
        "count": count, "countExact": exact, "guard": None,
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "viewId": target.view_id,
    })
    ctx.turn.add_actions([{"id": new_id("act"), "kind": "open_search", "label": "Open in Advanced Search",
                           "payload": {"viewId": target.view_id, "predicate": predicate}}])
    return {"shown": True, "count": count, "exact": exact}


async def _draft_cypher(ctx: ToolContext, args: dict) -> Any:
    from ..query_drafting import check_cypher

    target = ctx.target
    cypher = str(args.get("cypher") or "").strip()
    if not cypher:
        raise ToolFailed("Give the Cypher text.")
    guard = check_cypher(cypher)
    ctx.turn.block("query", {
        "language": "cypher", "predicate": None, "cypher": cypher,
        "explanation": str(args.get("explanation") or "")[:600], "assumptions": [],
        "count": None, "countExact": False, "guard": guard,
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "viewId": target.view_id,
    })
    if guard.get("ok"):
        ctx.turn.add_actions([{"id": new_id("act"), "kind": "open_cypher", "label": "Open in the Cypher tab",
                               "payload": {"viewId": target.view_id, "cypher": cypher}}])
    return {"shown": True, "guard": guard,
            "note": "The person reviews and runs it themselves; never claim to have run it."}


async def _ask_user(ctx: ToolContext, args: dict) -> Any:
    question = str(args.get("question") or "").strip()
    options = [o for o in args.get("options") or [] if isinstance(o, dict) and o.get("label")][:6]
    if not question or not options:
        raise ToolFailed("Give a question and two to six options.")
    payload = {
        "id": new_id("clr"), "question": question[:300], "concept": None,
        "options": [{"id": f"opt_{i + 1}", "label": str(o["label"])[:120],
                     "description": str(o.get("description") or "")[:200], "count": o.get("count")}
                    for i, o in enumerate(options)],
        "allowRemember": False, "allowOther": True,
    }
    ctx.state.pending = {
        "id": payload["id"], "kind": "choice", "question": ctx.question,
        "options": {o["id"]: {"label": o["label"]} for o in payload["options"]},
    }
    ctx.turn.clarify(payload)
    ctx.stopped = True
    return {"status": "waiting_for_person"}


async def _set_context(ctx: ToolContext, args: dict) -> Any:
    view_id = str(args.get("viewId") or "")
    if not view_id:
        raise ToolFailed("Give a viewId (from find_views).")
    try:
        view = await ctx.client.get_view(view_id)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    from . import grounding as G

    fresh = await G.build(ctx.client, user_id=ctx.user_id, view_only=ctx.target.view_only,
                          context={"workspaceId": view.get("workspaceId"),
                                   "dataSourceId": view.get("dataSourceId"), "viewId": view_id},
                          include_values=ctx.policy.send_sample_values)
    ctx.grounding.adopt(fresh)
    await load_type_property(ctx)
    from .brief import fit
    from .prompts import grounding_text

    return {"now": f"Working in the view {view.get('name')!r} ({view.get('dataSourceName')})",
            "grounding": json.loads(fit(grounding_text(ctx.grounding), ctx.policy, limit=8000))}


async def _describe_context(ctx: ToolContext, args: dict) -> Any:
    from . import brief

    card = brief.for_ui(ctx.grounding)
    ctx.turn.block("context", card)
    out: dict[str, Any] = {"shown": "a card with what is known about "
                                    f"{(card.get('about') or {}).get('name')}: its details, layers, types, "
                                    "hierarchy, connections, contents and caveats"}
    page = brief.section(card, str(args.get("section") or "") or None, int(args.get("offset") or 0))
    if page is not None:
        out["section"] = page
    return out


async def _suggest_followups(ctx: ToolContext, args: dict) -> Any:
    ctx.turn.add_followups([str(q)[:160] for q in (args.get("questions") or [])[:4]])
    return {"ok": True}


async def _feature_switches(ctx: ToolContext, args: dict) -> Any:
    try:
        body = await ctx.client.feature_values()
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    values = body.get("values") or {}
    return {"switches": {k: v for k, v in values.items() if isinstance(v, (bool, str, int))}}


def _schema(properties: dict, required: tuple[str, ...] = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required)}


_SCOPE = {"type": "string", "enum": ["view", "data_source"],
          "description": "view (default): the view's boundary. data_source: the whole data source."}


def _tools() -> dict[str, Tool]:
    from . import impact, views
    from ..knowledge import tools as knowledge_tools

    spec = ToolSpec
    entries = [
        Tool(spec("search_entities",
                  "Find entities matching a predicate. Shows the person a results card (counts by "
                  "type and container, first items) and returns a summary with a resultRef for "
                  "follow-ups.",
                  _schema({"predicate": PREDICATE_SCHEMA,
                           "title": {"type": "string", "description": "What the results are, in plain words"},
                           "scope": _SCOPE, "limit": {"type": "integer", "minimum": 1, "maximum": 50}},
                          ("predicate", "title"))),
             _search_entities, "Searching"),
        Tool(spec("count_entities",
                  "Exact counts for up to 32 predicates at once — cheap; use it to compare options.",
                  _schema({"rules": {"type": "array", "items": {"type": "object", "properties": {
                      "label": {"type": "string"}, "predicate": PREDICATE_SCHEMA}}},
                           "scope": _SCOPE}, ("rules",))),
             _count_entities, "Counting"),
        Tool(spec("find_entities",
                  "Look entities up by name or path (\"customers/first_name\", or [\"Snowflake\",\"sales\",\"orders\"]). "
                  "Returns how many each name matches and where they are.",
                  _schema({"names": {"type": "array", "items": {}},
                           "entityType": {"type": "string"}, "scope": _SCOPE}, ("names",))),
             _find_entities, "Looking up names"),
        Tool(spec("get_entity", "One entity's details: type, description, properties, tags and where it sits.",
                  _schema({"urn": {"type": "string"}}, ("urn",))),
             _get_entity, "Reading an entity"),
        Tool(spec("resolve_concept",
                  "Read a business term (PII, owner, updated, ingested, certified…) against this "
                  "data source. Uses a confirmed reading, or counts the candidates and asks the "
                  "person when it is not certain. want=property for attribute terms (owner, "
                  "updated) to get a property key.",
                  _schema({"concept": {"type": "string"}, "appliesTo": {"type": "string",
                           "description": "An entity type id the term is about, e.g. schemaField"},
                           "want": {"type": "string", "enum": ["predicate", "property"]},
                           "synonyms": {"type": "array", "items": {"type": "string"}},
                           "scope": _SCOPE}, ("concept",))),
             _resolve_concept, "Reading a business term"),
        Tool(spec("get_property_values", "The most common values of a property, optionally filtered.",
                  _schema({"key": {"type": "string"}, "q": {"type": "string"},
                           "limit": {"type": "integer"}}, ("key",))),
             _property_values, "Reading property values"),
        Tool(spec("analyze_impact",
                  "What is affected if an entity is removed, dropped, renamed or changed: everything "
                  "downstream, by type and container, the consumers at the end, owners, the paths "
                  "(why) and the job schedules on them (when). Shows an impact report.",
                  _schema({"urn": {"type": "string"},
                           "name": {"type": "string", "description": "When no urn: a name or path"},
                           "change": {"type": "string", "enum": ["drop", "remove", "rename", "type_change"]},
                           "depth": {"type": "integer", "minimum": 1, "maximum": 25}})),
             impact.analyze_impact, "Analysing impact"),
        Tool(spec("trace_lineage",
                  "Lineage around an entity in one direction — upstream (where it comes from: "
                  "sources, ingestion, jobs) or downstream (what consumes it). Shows a lineage report.",
                  _schema({"urn": {"type": "string"}, "name": {"type": "string"},
                           "direction": {"type": "string", "enum": ["upstream", "downstream"]},
                           "depth": {"type": "integer", "minimum": 1, "maximum": 25}}, ("direction",))),
             impact.trace_lineage, "Tracing lineage"),
        Tool(spec("explain_rollup",
                  "The physical lineage edges behind a rolled-up (aggregated) link between two "
                  "containers — evidence for 'why are these connected'.",
                  _schema({"sourceUrn": {"type": "string"}, "targetUrn": {"type": "string"}},
                          ("sourceUrn", "targetUrn"))),
             impact.explain_rollup, "Opening a rolled-up link"),
        Tool(spec("find_views",
                  "Find views (curated canvases) about a topic, across every workspace the person "
                  "can read. Give the topic and a few synonyms.",
                  _schema({"query": {"type": "string"},
                           "synonyms": {"type": "array", "items": {"type": "string"}}}, ("query",))),
             views.find_views, "Finding views", ("data", "help")),
        Tool(spec("set_context",
                  "Work inside a view found with find_views: loads its schema and catalogue.",
                  _schema({"viewId": {"type": "string"}}, ("viewId",))),
             _set_context, "Opening a view"),
        Tool(spec("describe_context",
                  "Show the person what you know about where they are — the view's details, layers, "
                  "types and hierarchy, every kind of connection, what its entities carry, and what "
                  "limits answers here — as a card. Use for 'what do you know / what's in the "
                  "context / what does this view show / explain the hierarchy'. Optionally page "
                  "through one section.",
                  _schema({"section": {"type": "string", "enum": ["about", "layers", "types", "hierarchy",
                                                                  "connections", "contents", "caveats"]},
                           "offset": {"type": "integer", "minimum": 0}})),
             _describe_context, "Reading what I know"),
        Tool(spec("show_query",
                  "Show the person a search as a query card they can open in Advanced Search, "
                  "with its count. Use when they ask you to write or build a search.",
                  _schema({"predicate": PREDICATE_SCHEMA, "explanation": {"type": "string"},
                           "assumptions": {"type": "array", "items": {"type": "string"}},
                           "scope": _SCOPE}, ("predicate", "explanation"))),
             _show_query, "Writing a search"),
        Tool(spec("draft_cypher",
                  "Show the person a read-only Cypher query you wrote, checked by the platform's "
                  "guard, to open in the Cypher tab. The person runs it; you never do.",
                  _schema({"cypher": {"type": "string"}, "explanation": {"type": "string"}},
                          ("cypher", "explanation"))),
             _draft_cypher, "Writing Cypher"),
        Tool(spec("search_docs",
                  "Search the product's documentation and user guide (and any knowledge sources "
                  "an administrator connected). Returns sections to cite.",
                  _schema({"query": {"type": "string"}}, ("query",))),
             knowledge_tools.search_docs, "Searching the docs", ("data", "help")),
        Tool(spec("get_feature_switches",
                  "Which product features are switched on or off in this deployment.",
                  _schema({})),
             _feature_switches, "Checking feature switches", ("help",)),
        Tool(spec("ask_user",
                  "Ask the person to choose when the question is ambiguous (which of several "
                  "entities, which data source). Ends the turn.",
                  _schema({"question": {"type": "string"}, "options": {"type": "array", "items": {
                      "type": "object", "properties": {"label": {"type": "string"},
                                                       "description": {"type": "string"}}}}},
                          ("question", "options"))),
             _ask_user, "Asking you", ("data", "help")),
        Tool(spec("suggest_followups", "Two to four short follow-up questions the person might ask next.",
                  _schema({"questions": {"type": "array", "items": {"type": "string"}}}, ("questions",))),
             _suggest_followups, "Suggesting follow-ups", ("data", "help")),
    ]
    return {t.spec.name: t for t in entries}


_REGISTRY: Optional[dict[str, Tool]] = None


def registry() -> dict[str, Tool]:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _tools()
    return _REGISTRY


def for_persona(persona: str) -> list[Tool]:
    return [t for t in registry().values() if persona in t.personas]
