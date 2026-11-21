"""The data, over MCP — find, describe, search, trace and impact, for other teams' agents.

The assistant's own tools, run without a model. An agent names a view (or a
workspace) and gets back what the person's card in the assistant would show —
counts, the first items, the paths, the impact report — read as the person or
API key calling, through the read-only delegation the web tier minted for
this call.

Tools (all read-only): ``find_views``, ``describe_view``, ``find_entities``,
``get_entity``, ``search_entities``, ``count_entities``, ``trace_lineage``,
``analyze_impact``.

Stateless, like the knowledge server:

* a tool that needs a choice — which of several entities a name means, how to
  read a business term such as ``{"kind":"concept","name":"PII"}`` — answers
  ``status: "needs_choice"`` with the options. Call again with the option's
  ``urn``, or with ``choices: {clarificationId: optionId}``: a business
  term's clarification id is the same on every call, so answering needs no
  session;
* earlier results are not kept: compose with the ``query.predicate`` a search
  returned.

What comes back is what the caller may read. The data-sharing policy governs
what this deployment sends to its own model; no model is called here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from ..agent import brief
from ..agent import concepts as C
from ..agent import grounding as G
from ..agent import impact, views
from ..agent import tools as T
from ..agent.events import Turn
from ..agent.policy import DataPolicy
from ..agent.prompts import SEARCH_GRAMMAR
from ..agent.state import ConversationState
from ..config import get_config
from ..db import session_scope
from ..platform_client import PlatformClient, PlatformError
from .protocol import McpServer, McpTool, ToolError

INSTRUCTIONS = (
    "Read the organisation's data lineage as the person (or API key) calling. Start with "
    "find_views to find a view about a subject, describe_view to learn what it holds (its "
    "types, hierarchy, connections and caveats), then search, trace or analyse impact inside "
    "it. A tool may answer status needs_choice: call it again as its howToAnswer says."
)

#: The grammar the assistant's model gets, less what needs a conversation.
GRAMMAR = SEARCH_GRAMMAR.split("Assistant-only kinds")[0] + (
    '- {"kind":"concept","name":"PII"}   — a business term, read against the data source '
    "(may answer needs_choice)\n"
    "Limits: depth ≤ 6, ≤ 64 leaves, ≤ 24 children in an OR.\n"
)


@dataclass(frozen=True)
class DataCaller:
    """Who a call is for, and what the service reads with."""

    user_id: str
    delegation: str
    view_only: bool = False
    knowledge: Any = None
    transport: Any = None


Run = Callable[[T.ToolContext, dict], Awaitable[dict]]


async def _call(caller: DataCaller, arguments: dict, run: Run, *, place: bool = True) -> dict:
    """*run* where the arguments say (a view, or a workspace), as the caller."""
    context = {k: arguments[k] for k in ("viewId", "workspaceId", "dataSourceId")
               if isinstance(arguments.get(k), str) and arguments[k]}
    if place and not (context.get("viewId") or context.get("workspaceId")):
        raise ToolError("Say where to look: a viewId (find_views returns them), or a workspaceId.")
    config = get_config()
    client = PlatformClient(config.platform_api_url, caller.delegation,
                            timeout=config.platform_timeout_seconds, transport=caller.transport)
    try:
        if place:
            grounding = await G.build(client, user_id=caller.user_id, context=context,
                                      view_only=caller.view_only)
            if context.get("viewId") and not grounding.view and not grounding.schema:
                raise ToolError("That view could not be read.")
            async with session_scope() as session:
                grounding.type_property = await C.load_type_property(
                    session, None, data_source_id=grounding.target.data_source_id,
                    user_id=caller.user_id)
        else:
            grounding = G.Grounding(target=G.Target())
        choices = arguments.get("choices") if isinstance(arguments.get("choices"), dict) else {}
        ctx = T.ToolContext(
            client=client, grounding=grounding, state=ConversationState(),
            turn=Turn(conversation_id="mcp", message_id="mcp", persona="data"), policy=DataPolicy(),
            user_id=caller.user_id, user_name="", user_email="", session_scope=session_scope,
            knowledge=caller.knowledge, choices={str(k): str(v) for k, v in choices.items()},
        )
        result = await run(ctx, arguments)
    except T.ToolFailed as exc:
        raise ToolError(str(exc))
    except PlatformError as exc:
        raise ToolError(exc.message)
    finally:
        await client.aclose()
    if ctx.stopped:
        return _needs_choice(ctx)
    notices = [b["data"]["text"] for b in ctx.turn.blocks if b["type"] == "notice"]
    return {**result, "notices": notices} if notices else result


def _needs_choice(ctx: T.ToolContext) -> dict:
    asked = next(b["data"] for b in reversed(ctx.turn.blocks) if b["type"] == "clarify")
    pending = (ctx.state.pending or {}).get("options") or {}
    options = []
    for o in asked["options"]:
        option = {"id": o["id"], "label": o["label"], "description": o.get("description") or None,
                  "count": o.get("count"), "urn": (pending.get(o["id"]) or {}).get("urn")}
        options.append({k: v for k, v in option.items() if v is not None})
    how = ("Call again with the chosen option's urn." if any("urn" in o for o in options) else
           f'Call again with the same arguments and choices: {{"{asked["id"]}": "<option id>"}}.')
    return {"status": "needs_choice", "clarificationId": asked["id"], "question": asked["question"],
            "options": options, "howToAnswer": how}


def _card(ctx: T.ToolContext, kind: str) -> Optional[dict]:
    """The card a tool showed, as the person would see it — without the
    conversation's result reference, which means nothing here."""
    data = next((b["data"] for b in reversed(ctx.turn.blocks) if b["type"] == kind), None)
    return None if data is None else {k: v for k, v in data.items() if k != "resultRef"}


# ── The tools ───────────────────────────────────────────────────────────


async def _find_views(ctx: T.ToolContext, args: dict) -> dict:
    summary = await views.find_views(ctx, args)
    found = _card(ctx, "views")
    return {"views": found["items"] if found else [], "searchedFor": summary.get("searchedFor")}


async def _describe_view(ctx: T.ToolContext, args: dict) -> dict:
    return brief.for_ui(ctx.grounding)


async def _find_entities(ctx: T.ToolContext, args: dict) -> dict:
    return {"results": (await T._find_entities(ctx, args))["results"]}


async def _get_entity(ctx: T.ToolContext, args: dict) -> dict:
    summary = await T._get_entity(ctx, args)
    return _card(ctx, "entity") or summary


async def _search_entities(ctx: T.ToolContext, args: dict) -> dict:
    summary = await T._search_entities(ctx, args)
    return _card(ctx, "results") or summary


async def _count_entities(ctx: T.ToolContext, args: dict) -> dict:
    return await T._count_entities(ctx, args)


def _reported(tool: Run) -> Run:
    async def run(ctx: T.ToolContext, args: dict) -> dict:
        summary = await tool(ctx, args)
        return _card(ctx, "impact") or summary
    return run


_PLACE = {
    "viewId": {"type": "string", "description": "The view to work in (find_views returns ids)."},
    "workspaceId": {"type": "string",
                    "description": "With no viewId: a workspace. Its data source's most used view is read."},
    "dataSourceId": {"type": "string", "description": "With workspaceId: which data source."},
}
_CHOICES = {"type": "object", "additionalProperties": {"type": "string"},
            "description": "Answers to an earlier needs_choice: {clarificationId: optionId}."}
_TARGET = {"urn": {"type": "string"},
           "name": {"type": "string", "description": "When no urn: a name or path, e.g. customers/first_name"},
           "depth": {"type": "integer", "minimum": 1, "maximum": 25}}


def _schema(properties: dict, required: tuple[str, ...] = (), *, place: bool = True) -> dict:
    props = {**(_PLACE if place else {}), **properties, **({"choices": _CHOICES} if place else {})}
    return {"type": "object", "properties": props, "required": list(required)}


def build_server() -> McpServer:
    def tool(name: str, title: str, description: str, schema: dict, run: Run, *, place: bool = True):
        async def call(arguments: dict, caller: Any) -> dict:
            if not isinstance(caller, DataCaller) or not caller.delegation:
                raise ToolError("No caller: this endpoint is reached through the platform.")
            return await _call(caller, arguments, run, place=place)
        return McpTool(name, description, schema, call, title=title)

    return McpServer(
        name="data", version="1", instructions=INSTRUCTIONS,
        tools=[
            tool("find_views", "Find views",
                 "Views (curated canvases) about a topic, across every workspace you can read, ranked. "
                 "Give the topic and a few synonyms.",
                 _schema({"query": {"type": "string"},
                          "synonyms": {"type": "array", "items": {"type": "string"}}}, ("query",),
                         place=False),
                 _find_views, place=False),
            tool("describe_view", "Describe a view",
                 "What a view holds: its name, description, workspace and data source, semantic layer, "
                 "layers, entity types with counts, the containment hierarchy, every kind of connection "
                 "(from → to, with counts), the properties and tags its entities carry, and the caveats "
                 "that limit answers there (e.g. a generic schema whose kinds live in a property).",
                 _schema({}), _describe_view),
            tool("find_entities", "Find entities by name",
                 "Look entities up by name or path (\"customers/first_name\", or "
                 "[\"Snowflake\",\"sales\",\"orders\"]): how many each name matches, their urns and where "
                 "they sit.",
                 _schema({"names": {"type": "array", "items": {}}, "entityType": {"type": "string"},
                          "scope": T._SCOPE}, ("names",)),
                 _find_entities),
            tool("get_entity", "Get an entity",
                 "One entity's type, description, properties, tags and ancestor path.",
                 _schema({"urn": {"type": "string"}}, ("urn",)), _get_entity),
            tool("search_entities", "Search entities",
                 "Entities matching a predicate: the total (exact or a lower bound), counts by type and by "
                 "container, and the first items with their paths.\n\n" + GRAMMAR,
                 _schema({"predicate": {"type": "object", "description": "A predicate in the grammar above"},
                          "title": {"type": "string"}, "scope": T._SCOPE,
                          "limit": {"type": "integer", "minimum": 1, "maximum": 50}}, ("predicate",)),
                 _search_entities),
            tool("count_entities", "Count entities",
                 "Exact counts for up to 32 predicates (the search_entities grammar) at once.",
                 _schema({"rules": {"type": "array", "items": {"type": "object", "properties": {
                     "label": {"type": "string"}, "predicate": {"type": "object"}}}},
                          "scope": T._SCOPE}, ("rules",)),
                 _count_entities),
            tool("trace_lineage", "Trace lineage",
                 "Lineage around an entity in one direction — upstream (where it comes from) or "
                 "downstream (what consumes it): totals by type and container, the ends, owners, paths "
                 "with what each edge records, schedules, and which grain the walk used.",
                 _schema({**_TARGET, "direction": {"type": "string", "enum": ["upstream", "downstream"]}},
                         ("direction",)),
                 _reported(impact.trace_lineage)),
            tool("analyze_impact", "Analyse impact",
                 "What is affected if an entity is removed, dropped, renamed or changed: everything "
                 "downstream by type and container, the consumers at the end, owners, the paths (why), "
                 "the schedules on them (when), and a heuristic severity with its reasons.",
                 _schema({**_TARGET, "change": {"type": "string",
                                                "enum": ["drop", "remove", "rename", "type_change"]}}),
                 _reported(impact.analyze_impact)),
        ],
    )


SERVER = build_server()
