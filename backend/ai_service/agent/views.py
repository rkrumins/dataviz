"""Finding views about a topic — "do we have anything on supply-chain failures?".

Two retrievers, fused by reciprocal rank:

* **keyword, as the person** — the platform's own view search
  (``GET /views?search=``), once per term (the query's words and the synonyms
  the model adds: supplier, logistics, delay…). It sees every view the person
  can open, their private ones included.
* **meaning** — the views collection in the vector store, when there is one
  (``knowledge``). It only ever suggests: every view it returns is opened as
  the person before it is shown, and one they cannot open is dropped.

A view's place in the answer says why it was chosen ("matches supplier,
logistics").
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from ..platform_client import PlatformError
from .events import new_id
from .tools import ToolContext, ToolFailed

_STOP = frozenset({
    "the", "and", "for", "with", "about", "any", "have", "has", "our", "are", "there", "views",
    "view", "data", "find", "show", "where", "what", "which", "that", "this", "those", "from",
    "into", "can", "could", "would", "does", "did", "we", "do", "is", "a", "an", "of", "on", "in",
    "to", "or", "me", "my", "all", "some",
})
_RRF_K = 60


def terms_of(query: str, synonyms: list[str]) -> list[str]:
    words = [w for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9_\-]{2,}", query.lower()) if w not in _STOP]
    out: list[str] = []
    phrase = " ".join(words[:3])
    for term in [phrase, *words, *[s.lower().strip() for s in synonyms]]:
        if term and term not in out and len(term) >= 3:
            out.append(term)
    return out[:8]


def _card(view: dict, reasons: list[str]) -> dict:
    return {
        "id": view.get("id"), "name": view.get("name"), "description": view.get("description"),
        "workspaceName": view.get("workspaceName"), "dataSourceName": view.get("dataSourceName"),
        "tags": view.get("tags") or [], "updatedAt": view.get("updatedAt"),
        "reason": ("matches " + ", ".join(f"“{r}”" for r in reasons[:3])) if reasons else "related in meaning",
    }


async def find_views(ctx: ToolContext, args: dict) -> Any:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolFailed("Give the topic to look for.")
    synonyms = [str(s) for s in args.get("synonyms") or []][:8]
    terms = terms_of(query, synonyms)

    async def keyword(term: str):
        try:
            page = await ctx.client.list_views(search=term, limit=10)
        except PlatformError:
            return term, []
        return term, (page or {}).get("items") or []

    tasks = [keyword(t) for t in terms]
    vector_hits: list[dict] = []
    if ctx.knowledge is not None:
        try:
            vector_hits = await ctx.knowledge.search_collection("views", query, limit=10)
        except Exception:  # noqa: BLE001 — meaning is a bonus, keywords still answer
            vector_hits = []
    keyword_results = await asyncio.gather(*tasks)

    scores: dict[str, float] = {}
    views: dict[str, dict] = {}
    reasons: dict[str, list[str]] = {}
    for term, items in keyword_results:
        for rank, view in enumerate(items):
            vid = view.get("id")
            if not vid:
                continue
            views.setdefault(vid, view)
            scores[vid] = scores.get(vid, 0.0) + 1.0 / (_RRF_K + rank + 1)
            reasons.setdefault(vid, []).append(term)
    for rank, hit in enumerate(vector_hits):
        vid = (hit.get("metadata") or {}).get("viewId") or hit.get("sourceId")
        if not vid:
            continue
        scores[vid] = scores.get(vid, 0.0) + 1.0 / (_RRF_K + rank + 1)

    ranked = sorted(scores, key=lambda v: -scores[v])[:10]

    async def verify(vid: str):
        if vid in views:
            return views[vid]
        try:
            return await ctx.client.get_view(vid)
        except PlatformError:
            return None  # the person cannot open it: it never reaches the answer

    verified = await asyncio.gather(*(verify(v) for v in ranked))
    cards = [_card(view, reasons.get(view["id"], [])) for view in verified if view]
    if not cards:
        return {"found": 0, "searchedFor": terms,
                "note": "No views match. Say so, and suggest searching the data itself instead."}
    ctx.turn.block("views", {"items": cards})
    ctx.turn.add_actions([
        {"id": new_id("act"), "kind": "open_view", "label": f"Open {c['name']}", "payload": {"viewId": c["id"]}}
        for c in cards[:2]
    ])
    return {
        "found": len(cards), "searchedFor": terms,
        "views": [{"viewId": c["id"], "name": c["name"], "dataSource": c["dataSourceName"],
                   "workspace": c["workspaceName"], "why": c["reason"],
                   "description": (c["description"] or "")[:200]} for c in cards],
        "shownToPerson": "view cards with Open buttons",
    }
