"""Impact and provenance: what breaks if something changes, and where it comes from.

The flagship playbook, deterministic so the same question gets the same
answer. For a target (by urn, or by name or path such as
``customers/first_name``):

1. **Resolve** it — several matches ask the person which one.
2. **Walk physical lineage** at the finest grain (``trace/closure``), up to a
   node budget. A container's lineage runs through what is inside it (a
   table's through its columns); the platform seeds that walk itself.
3. When the walk is cut short, read the **rolled-up lineage** (``coarse``,
   from the materialised ``AGGREGATED`` edges) for the breadth, and **count
   exactly** with a search walked from the target (``/search/counts``), so
   the totals hold however large the graph is. The report says which grain
   each number comes from.
4. From what was walked:
   * **who** — the consumers at the end (dashboards, reports, models) and the
     owners named on the affected assets or their containers;
   * **why** — the paths from the target to each consumer, with what each
     edge records about the transformation;
   * **when** — the schedules of the jobs on those paths ("the first job that
     reads it runs daily at 04:00 UTC");
   * a **severity**, with its reasons — a heuristic, and labelled as one.
5. The affected set is kept as a **result reference** (a predicate, not a
   list), so "who owns those?" or "only the dashboards" compose with it.

Nothing is guessed: no owner, schedule or transformation is reported that
the metadata does not carry, and the report says when it carries none.
"""
from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict, deque
from typing import Any, Optional

from ..platform_client import PlatformError
from . import predicates as P
from .events import new_id
from .tools import ToolContext, ToolFailed, ensure_searchable

logger = logging.getLogger(__name__)

_NODE_BUDGET = 2000
_CONSUMER_TYPES = re.compile(r"dashboard|chart|report|model|notebook|application|\bapp\b|metric|kpi|api|feature|workbook|tile", re.I)
_JOB_TYPES = re.compile(r"job|pipeline|flow|task|dag|process|workflow", re.I)
_SCHEDULE_KEYS = re.compile(r"schedule|cron|interval|frequency|trigger", re.I)
_TRANSFORM_KEYS = re.compile(r"transform|expression|logic|sql|mapping|formula|rule|derivation", re.I)
_OWNER_KEYS = ("owner", "owners", "data_owner", "dataOwner", "steward", "data_steward",
               "owner_email", "ownerEmail", "team", "owning_team", "contact")
_CRITICAL = re.compile(r"certified|critical|gold|tier ?[01]|sla|regulated|gdpr", re.I)


def _name(node: dict) -> str:
    return str(node.get("displayName") or node.get("urn") or "")


def _entity(node: dict, hops: Optional[int] = None) -> dict:
    out = {"urn": node.get("urn"), "name": _name(node), "type": node.get("entityType")}
    if hops is not None:
        out["hops"] = hops
    return out


def humanize_cron(expr: str) -> Optional[str]:
    """Plain words for the common cron shapes; None when it is not one."""
    parts = str(expr or "").split()
    if len(parts) != 5:
        return None
    minute, hour, dom, month, dow = parts
    if not (minute.isdigit() and hour.isdigit()):
        if minute.isdigit() and hour == "*" and dom == month == dow == "*":
            return f"hourly at :{int(minute):02d}"
        if minute.startswith("*/") and hour == "*":
            return f"every {minute[2:]} minutes"
        return None
    at = f"{int(hour):02d}:{int(minute):02d} UTC"
    if dom == month == dow == "*":
        return f"daily at {at}"
    days = {"0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday",
            "5": "Friday", "6": "Saturday", "7": "Sunday", "1-5": "weekdays"}
    if dom == month == "*" and dow in days:
        return f"{days[dow]} at {at}" if dow != "1-5" else f"weekdays at {at}"
    if dom.isdigit() and month == dow == "*":
        return f"monthly on day {dom} at {at}"
    return None


async def _resolve_target(ctx: ToolContext, args: dict) -> Optional[dict]:
    target = await ensure_searchable(ctx)
    urn = str(args.get("urn") or "").strip()
    if not urn:
        name = str(args.get("name") or "").strip()
        if not name and ctx.grounding.selection:
            urn = ctx.grounding.selection[0]["urn"]
        elif not name:
            raise ToolFailed("Name the entity (urn, or a name or path such as customers/first_name).")
        else:
            path = [p.strip() for p in re.split(r"\s*/\s*|\s*\.\s*(?=\S)", name) if p.strip()]
            refs = [{"path": (["**"] + path) if len(path) == 1 else path, "caseSensitive": False}]
            if len(path) > 1:
                refs.append({"path": ["**"] + path, "caseSensitive": False})
            try:
                body = await ctx.client.resolve(target.workspace_id, target.data_source_id,
                                                target.scope("data_source"), refs)
            except PlatformError as exc:
                raise ToolFailed(exc.for_model())
            matches = []
            for result in body.get("results") or []:
                for m in result.get("matches") or []:
                    if m.get("urn") not in {x.get("urn") for x in matches}:
                        matches.append(m)
            if not matches:
                raise ToolFailed(f"Nothing named {name!r} in this data source. Ask the person to check "
                                 "the name, or use find_entities with part of it.")
            if len(matches) > 1:
                options = [
                    {"label": " / ".join([a.get("displayName") for a in m.get("ancestorPath") or []]
                                         + [m.get("displayName")]),
                     "description": m.get("entityType"), "urn": m.get("urn")}
                    for m in matches[:6]
                ]
                payload = {
                    "id": new_id("clr"),
                    "question": f"More than one entity is called “{name}”. Which one do you mean?",
                    "concept": None,
                    "options": [{"id": f"opt_{i + 1}", "label": o["label"], "description": o["description"],
                                 "count": None} for i, o in enumerate(options)],
                    "allowRemember": False, "allowOther": True,
                }
                ctx.state.pending = {
                    "id": payload["id"], "kind": "choice", "question": ctx.question,
                    "options": {f"opt_{i + 1}": {"label": o["label"], "urn": o["urn"]}
                                for i, o in enumerate(options)},
                }
                ctx.turn.clarify(payload)
                ctx.stopped = True
                return None
            urn = matches[0]["urn"]
    try:
        node = await ctx.client.get_node(target.workspace_id, target.data_source_id, urn,
                                         view_id=target.view_id)
        chain = await ctx.client.ancestors(target.workspace_id, target.data_source_id, urn,
                                           view_id=target.view_id)
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    node["_path"] = [_name(c) for c in reversed(chain)]
    return node


async def _closure(ctx: ToolContext, urn: str, direction: str, depth: int, grain: str) -> dict:
    target = ctx.target
    body = {
        "urn": urn, "direction": direction,
        "upstreamDepth": depth if direction == "upstream" else 0,
        "downstreamDepth": depth if direction == "downstream" else 0,
        "maxNodes": _NODE_BUDGET, "grain": grain,
    }
    return await ctx.client.trace_closure(target.workspace_id, target.data_source_id, body,
                                          view_id=target.view_id)


async def _exact_counts(ctx: ToolContext, urn: str, direction: str, depth: int,
                        type_ids: list[str]) -> Optional[dict]:
    target = ctx.target
    far_end = P.any_of(P.is_urns([urn]), {"kind": "descendantOf", "urns": [urn]})
    hops = max(1, min(10, depth))
    axis = "upstream" if direction == "downstream" else "downstream"
    reached = {"kind": "related", "axis": axis, "where": far_end, "maxHops": hops}
    items = [{"id": "all", "predicate": reached}]
    for i, t in enumerate(type_ids[:20]):
        items.append({"id": f"t{i}", "predicate": P.all_of(reached, P.of_types([t]))})
    try:
        body = await ctx.client.counts(target.workspace_id, target.data_source_id,
                                       target.scope("data_source"), items, budget_seconds=25)
    except PlatformError as exc:
        logger.info("impact counts failed: %s", exc)
        return None
    counts = body.get("counts") or {}
    by_type = []
    for i, t in enumerate(type_ids[:20]):
        row = counts.get(f"t{i}") or {}
        if row.get("count"):
            by_type.append({"type": t, "label": ctx.grounding.type_label(t), "count": int(row["count"])})
    total_row = counts.get("all") or {}
    return {
        "total": total_row.get("count"),
        "exact": bool(body.get("complete")) and not total_row.get("lowerBound"),
        "byType": sorted(by_type, key=lambda r: -r["count"]),
        "predicate": reached, "hops": hops,
    }


def _transform_detail(edge: dict) -> Optional[str]:
    for key, value in (edge.get("properties") or {}).items():
        if _TRANSFORM_KEYS.search(str(key)) and value not in (None, ""):
            text = str(value)
            return text if len(text) <= 140 else text[:137] + "…"
    return None


def _owner_of(node: dict, parents: dict[str, str], nodes: dict[str, dict],
              owner_key: Optional[str]) -> Optional[tuple[str, str]]:
    seen = 0
    current: Optional[dict] = node
    while current is not None and seen < 6:
        props = current.get("properties") or {}
        keys = (owner_key,) if owner_key else _OWNER_KEYS
        for key in keys:
            value = props.get(key) if key else None
            if value not in (None, "", []):
                if isinstance(value, list):
                    value = ", ".join(str(v) for v in value[:3])
                return str(value)[:120], key
        parent = parents.get(current.get("urn"))
        current = nodes.get(parent) if parent else None
        seen += 1
    return None


async def _report(ctx: ToolContext, args: dict, *, direction: str, change: Optional[str]) -> Any:
    target_node = await _resolve_target(ctx, args)
    if target_node is None:
        return {"status": "waiting_for_person"}
    target = ctx.target
    urn = target_node["urn"]
    depth = max(1, min(25, int(args.get("depth") or 10)))
    step = ctx.turn.step(f"Walking {direction} lineage from {_name(target_node)}")
    try:
        fine = await _closure(ctx, urn, direction, depth, "fine")
    except PlatformError as exc:
        ctx.turn.finish_step(step, status="error", detail=exc.message)
        raise ToolFailed(exc.for_model())

    nodes = {n["urn"]: n for n in fine.get("nodes") or [] if n.get("urn")}
    edges = fine.get("edges") or []
    parents = {e.get("targetUrn"): e.get("sourceUrn") for e in fine.get("containmentEdges") or []}
    reached_key = "downstreamUrns" if direction == "downstream" else "upstreamUrns"
    reached = set(fine.get(reached_key) or [])
    inside = {u for u in nodes if _is_inside(u, urn, parents)} | {urn}
    reached -= inside
    frontier = fine.get("frontierDown" if direction == "downstream" else "frontierUp") or []
    truncated = bool(fine.get("truncated")) or bool(frontier) or bool(fine.get("seedTruncated"))
    ctx.turn.finish_step(step, detail=f"{len(reached):,} entities reached"
                         + (" (cut short — counting exactly next)" if truncated else ""))

    # Hops and parents along lineage, from the target and what is inside it.
    forward = defaultdict(list)
    for e in edges:
        s, t = (e.get("sourceUrn"), e.get("targetUrn"))
        if direction == "upstream":
            s, t = t, s
        forward[s].append((t, e))
    hops: dict[str, int] = {u: 0 for u in inside}
    came_from: dict[str, tuple[str, dict]] = {}
    queue = deque(inside)
    while queue:
        u = queue.popleft()
        for v, e in forward.get(u, []):
            if v not in hops:
                hops[v] = hops[u] + 1
                came_from[v] = (u, e)
                queue.append(v)

    type_counts = Counter(nodes[u].get("entityType") for u in reached if u in nodes)
    totals = {
        "entities": len(reached), "exact": not truncated,
        "byType": [{"type": t, "label": ctx.grounding.type_label(t or ""), "count": c}
                   for t, c in type_counts.most_common(10)],
    }
    notes: list[str] = []
    grain = "fine"
    if truncated:
        step = ctx.turn.step("Counting everything affected exactly")
        type_ids = [t["id"] for t in ctx.grounding.entity_types][:20] or list(type_counts)
        exact = await _exact_counts(ctx, urn, direction, depth, type_ids)
        if exact and exact.get("total") is not None:
            totals = {"entities": exact["total"], "exact": exact["exact"],
                      "byType": exact["byType"] or totals["byType"]}
            if depth > 10:
                notes.append("Exact counts reach 10 hops; the walk went further.")
            ctx.turn.finish_step(step, detail=f"{exact['total']:,} in total")
        else:
            ctx.turn.finish_step(step, status="error", detail="Counted what the walk reached only")
            notes.append(f"The walk stopped at {len(nodes):,} entities; there are more.")
        try:
            coarse = await _closure(ctx, urn, direction, depth, "coarse")
            coarse_nodes = [n for n in coarse.get("nodes") or [] if n.get("urn") not in inside]
            if coarse_nodes:
                grain = "coarse" if len(reached) < 5 else "fine"
                notes.append(f"Rolled-up lineage shows {len(coarse_nodes):,} containers downstream"
                             if direction == "downstream" else
                             f"Rolled-up lineage shows {len(coarse_nodes):,} containers upstream")
                for n in coarse_nodes:
                    nodes.setdefault(n["urn"], n)
        except PlatformError as exc:
            logger.info("coarse closure failed: %s", exc)

    # Containers holding what is affected.
    by_parent = Counter(parents.get(u) for u in reached if parents.get(u))
    by_container = [
        {"entity": _entity(nodes[p]) if p in nodes else {"urn": p, "name": p, "type": None}, "count": c}
        for p, c in by_parent.most_common(10)
    ]

    # Who: consumers at the end (or sources at the start), and owners.
    has_next = {s for s, outs in forward.items() if outs}
    frontier_urns = {f.get("urn") for f in frontier}
    ends = [u for u in reached if u in nodes and u not in has_next and u not in frontier_urns]
    ends.sort(key=lambda u: (not _CONSUMER_TYPES.search(str(nodes[u].get("entityType") or "")),
                             hops.get(u, 99)))
    if direction == "downstream":
        ends = [u for u in ends if _CONSUMER_TYPES.search(str(nodes[u].get("entityType") or ""))] or ends
    consumers = [_entity(nodes[u], hops.get(u)) for u in ends[:12]]

    owner_ref = ctx.state.confirmed("owner", target.data_source_id)
    owner_key = None
    if owner_ref and owner_ref.get("predicate", {}).get("kind") == "hasProperty":
        owner_key = owner_ref["predicate"].get("key")
    owners_map: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for u in reached:
        if u in nodes:
            found = _owner_of(nodes[u], parents, nodes, owner_key)
            if found:
                owners_map[found].append(_entity(nodes[u]))
    owners = [
        {"owner": owner, "property": key, "count": len(assets), "assets": assets[:3]}
        for (owner, key), assets in sorted(owners_map.items(), key=lambda kv: -len(kv[1]))[:8]
    ]
    if not owners:
        notes.append("No owner is recorded on the affected assets or their containers.")

    # Why: the path to each end.
    def path_to(end: str) -> Optional[dict]:
        chain_nodes, chain_edges = [end], []
        cursor = end
        guard = 0
        while cursor in came_from and guard < 30:
            prev, edge = came_from[cursor]
            chain_nodes.append(prev)
            chain_edges.append({"type": edge.get("edgeType"), "detail": _transform_detail(edge)})
            cursor = prev
            guard += 1
        if len(chain_nodes) < 2:
            return None
        chain_nodes.reverse()
        chain_edges.reverse()
        if direction == "upstream":
            chain_nodes.reverse()
            chain_edges.reverse()
        return {"nodes": [_entity(nodes[n]) if n in nodes else {"urn": n, "name": n} for n in chain_nodes],
                "edges": chain_edges}

    paths = [p for p in (path_to(c["urn"]) for c in consumers[:5]) if p]

    # When: schedules of the jobs on those paths, or among what is affected.
    on_paths = {n["urn"] for p in paths for n in p["nodes"]}
    jobs = [u for u in (on_paths | reached) if u in nodes
            and _JOB_TYPES.search(str(nodes[u].get("entityType") or ""))]
    schedules = []
    for u in sorted(jobs, key=lambda u: hops.get(u, 99)):
        for key, value in (nodes[u].get("properties") or {}).items():
            if _SCHEDULE_KEYS.search(str(key)) and value not in (None, ""):
                schedules.append({"job": _entity(nodes[u], hops.get(u)), "schedule": str(value)[:80],
                                  "human": humanize_cron(str(value))})
                break
        if len(schedules) >= 6:
            break
    timing = None
    if schedules:
        first = schedules[0]
        when = first["human"] or first["schedule"]
        timing = {"schedules": schedules,
                  "note": f"The first job on the way, {first['job']['name']}, runs {when}."
                  if direction == "downstream" else f"Its nearest job, {first['job']['name']}, runs {when}."}
    elif direction == "downstream":
        notes.append("No job schedules are recorded on the way, so when it breaks depends on the "
                     "next pipeline run.")

    # Severity — a heuristic, and labelled as one.
    reasons: list[str] = []
    bi = [c for c in consumers if _CONSUMER_TYPES.search(str(c.get("type") or ""))]
    if bi:
        reasons.append(f"Reaches {len(bi)} consumer{'s' if len(bi) != 1 else ''} such as "
                       f"{bi[0]['name']}")
    total = int(totals.get("entities") or 0)
    if total:
        reasons.append(f"{total:,} entities {'downstream' if direction == 'downstream' else 'upstream'}")
    critical = [u for u in reached if u in nodes and (
        any(_CRITICAL.search(str(t)) for t in nodes[u].get("tags") or [])
    )]
    if critical:
        reasons.append(f"{len(critical)} affected asset{'s' if len(critical) != 1 else ''} tagged as "
                       "critical or certified")
    direct = [u for u in reached if hops.get(u) == 1]
    if direct and direction == "downstream":
        reasons.append(f"{len(direct)} directly downstream")
    severity = "high" if (bi or critical or total >= 50) else "medium" if total >= 5 else "low"

    target_entity = {"urn": urn, "name": _name(target_node), "type": target_node.get("entityType"),
                     "path": target_node.get("_path")}
    verb = {"drop": "Dropping", "remove": "Removing", "rename": "Renaming",
            "type_change": "Changing the type of"}.get(change or "", "")
    if direction == "downstream":
        summary = (f"{verb + ' ' if verb else ''}{target_entity['name']} "
                   f"{'affects' if verb else 'feeds'} {total:,} "
                   f"{'entity' if total == 1 else 'entities'}"
                   + (f", including {len(bi)} consumer{'s' if len(bi) != 1 else ''}" if bi else "")
                   + ".")
    else:
        summary = (f"{target_entity['name']} is fed by {total:,} upstream "
                   f"{'entity' if total == 1 else 'entities'}"
                   + (f", starting from {len(consumers)} source{'s' if len(consumers) != 1 else ''}"
                      if consumers else "") + ".")

    far_end = P.any_of(P.is_urns([urn]), {"kind": "descendantOf", "urns": [urn]})
    result_predicate = P.validate({
        "kind": "related", "axis": "upstream" if direction == "downstream" else "downstream",
        "where": far_end, "maxHops": min(10, depth),
    })
    ref = ctx.state.add_result(
        label=f"{'Downstream of' if direction == 'downstream' else 'Upstream of'} {target_entity['name']}",
        predicate=result_predicate, workspace_id=target.workspace_id,
        data_source_id=target.data_source_id, view_id=target.view_id,
        scope_mode="data_source", total=total,
    )
    if fine.get("truncationReason") and fine.get("truncationReason") != "max_nodes":
        notes.append(f"The walk stopped early ({str(fine['truncationReason']).replace('_', ' ')}).")

    report = {
        "direction": direction, "target": target_entity, "change": change,
        "severity": severity, "severityReasons": reasons, "summary": summary,
        "totals": totals, "byContainer": by_container, "consumers": consumers,
        "owners": owners, "paths": paths, "timing": timing, "grain": grain,
        "truncated": truncated, "notes": notes,
        "trace": {"urn": urn, "direction": direction, "depth": min(depth, 25)},
        "resultRef": ref.id, "query": {"predicate": result_predicate, "scopeMode": "data_source"},
        "workspaceId": target.workspace_id, "dataSourceId": target.data_source_id,
        "viewId": target.view_id,
    }
    ctx.turn.block("impact", report)
    actions = []
    if target.view_id:
        actions.append({"id": new_id("act"), "kind": "open_trace", "label": "Open the trace",
                        "payload": {"viewId": target.view_id, "urn": urn, "direction": direction,
                                    "depth": min(depth, 25)}})
        actions.append({"id": new_id("act"), "kind": "open_search", "label": "Open in Advanced Search",
                        "payload": {"viewId": target.view_id, "predicate": result_predicate}})
    ctx.turn.add_actions(actions)
    if direction == "downstream":
        ctx.turn.add_followups([
            "Who owns the affected assets?" if owners else "Which teams should I tell?",
            "Show only the dashboards and reports",
            f"Where does {target_entity['name']} come from?",
        ])
    else:
        ctx.turn.add_followups([f"What does {target_entity['name']} feed?",
                                "Which of these sources are ingested tables?"])

    def path_text(p: dict) -> str:
        parts = [p["nodes"][0]["name"]]
        for edge, node in zip(p["edges"], p["nodes"][1:]):
            parts.append(f"-[{edge['type']}{': ' + edge['detail'] if edge.get('detail') else ''}]-> {node['name']}")
        return " ".join(parts)

    return {
        "resultRef": ref.id, "target": target_entity, "severity": severity, "reasons": reasons,
        "totals": totals, "consumers": [{"name": c["name"], "type": c["type"], "hops": c.get("hops")}
                                        for c in consumers],
        "owners": [{"owner": o["owner"], "count": o["count"]} for o in owners],
        "paths": [path_text(p) for p in paths[:4]],
        "timing": timing["note"] if timing else None,
        "grain": grain, "notes": notes,
        "shownToPerson": "an impact report card with all of this; summarise, do not repeat it",
    }


def _is_inside(urn: str, container: str, parents: dict[str, str]) -> bool:
    seen = 0
    current = parents.get(urn)
    while current and seen < 20:
        if current == container:
            return True
        current = parents.get(current)
        seen += 1
    return False


async def analyze_impact(ctx: ToolContext, args: dict) -> Any:
    change = args.get("change") if args.get("change") in ("drop", "remove", "rename", "type_change") else "remove"
    return await _report(ctx, args, direction="downstream", change=change)


async def trace_lineage(ctx: ToolContext, args: dict) -> Any:
    direction = "upstream" if args.get("direction") == "upstream" else "downstream"
    return await _report(ctx, args, direction=direction, change=None)


async def explain_rollup(ctx: ToolContext, args: dict) -> Any:
    target = await ensure_searchable(ctx)
    try:
        body = await ctx.client.edges_beneath(
            target.workspace_id, target.data_source_id, str(args.get("sourceUrn") or ""),
            str(args.get("targetUrn") or ""), view_id=target.view_id,
        )
    except PlatformError as exc:
        raise ToolFailed(exc.for_model())
    edges = body.get("edges") or []
    return {
        "total": body.get("total", len(edges)), "truncated": body.get("truncated"),
        "edges": [{"from": e.get("sourceUrn"), "to": e.get("targetUrn"), "type": e.get("edgeType"),
                   "detail": _transform_detail(e)} for e in edges[:25]],
        "note": "These are the physical lineage edges the rolled-up link summarises.",
    }
