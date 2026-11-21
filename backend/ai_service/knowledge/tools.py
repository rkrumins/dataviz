"""The ``search_docs`` tool: product knowledge as numbered, linked citations."""
from __future__ import annotations

from typing import Any

from .corpus import fill_brand
from .service import KnowledgeCaller


async def search_docs(ctx, args: dict) -> Any:
    from ..agent.tools import ToolFailed

    query = str(args.get("query") or "").strip() or ctx.question
    if ctx.knowledge is None:
        raise ToolFailed("The documentation index is not available in this deployment.")
    caller = KnowledgeCaller(user_id=ctx.user_id, delegation=getattr(ctx.client, "delegation", ""))
    hits = await ctx.knowledge.search_for_answer(query, caller=caller, persona=ctx.persona, limit=6)
    if not hits:
        return {"found": 0, "note": "Nothing in the docs answers this. Say so, and suggest who to ask."}
    brand = ctx.brand or "the platform"
    items = []
    for n, hit in enumerate(hits, start=1):
        text = fill_brand(hit.text, brand)
        items.append({
            "n": n, "title": fill_brand(hit.title, brand), "section": fill_brand(hit.heading, brand),
            "href": hit.url, "snippet": text[:280].rsplit(" ", 1)[0] + ("…" if len(text) > 280 else ""),
            "source": hit.metadata.get("area") if hit.source == "product" else hit.source,
            "trust": "product" if hit.source == "product" else "external",
        })
    ctx.turn.block("citations", {"items": items})
    return {
        "sections": [
            {"n": i["n"], "title": i["title"], "section": i["section"],
             "from": "the product docs" if i["trust"] == "product" else f"external source {i['source']}",
             "text": fill_brand(h.text, brand)[:1500]}
            for i, h in zip(items, hits)
        ],
        "cite": "Cite as [n]. The person sees these as linked citations.",
    }
