"""One turn: a question in, an answer streamed out, both kept.

1. **Can we answer?** The assistant is configured (a chat connection), the
   persona is on, the person has budget left today and fewer turns running
   than the limit.
2. **Which conversation, which question.** A new or existing conversation of
   theirs; a choice made on a clarification card finishes the question that
   needed it.
3. **Ground it** — the view, schema, catalogue and vocabulary (``grounding``)
   for the data persona; the brand and support contact for help.
4. **Answer** — the model streams text and calls tools, a bounded number of
   times; every tool reads the platform as the person; a tool that asks the
   person something ends the turn.
5. **Keep it** — the question, the answer with its blocks and steps, the
   result references and confirmed concepts, the tokens spent.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select

from .. import connections, settings_store
from ..config import AiServiceConfig
from ..db import session_scope
from ..internal_auth import Caller
from ..llm.types import (
    ChatMessage, CompletionRequest, Finished, LlmError, TextDelta, ToolCallsReady, Usage,
    UsageReport,
)
from ..models import AiConversationORM, AiLlmConnectionORM, AiMessageORM, AiUsageDailyORM
from ..platform_client import PlatformClient, PlatformError
from . import concepts as C
from . import grounding as G
from . import tools as T
from .brief import fit
from .brief import summary as brief_summary
from .events import Turn, new_id
from .policy import DataPolicy
from .prompts import DATA_SYSTEM, HELP_SYSTEM, SEARCH_GRAMMAR, grounding_text, wording
from .state import ConversationState

logger = logging.getLogger(__name__)

_HISTORY_MESSAGES = 10
_PAGE_STEPS = {
    "workspace": "Reading what this workspace holds",
    "data_source": "Reading what this data source holds",
    "explorer": "Reading what this data source holds",
    "ontology": "Reading this semantic layer",
}
_HOW_TO = re.compile(
    r"^(how (do|can|should) (i|we|you)|where (is|are|do|can) (i|the)|what (is|are|does) (a|an|the)\b"
    r"|can i\b|why can'?t i|is there a way|help me (use|with)|how to\b|what('s| is) the difference)",
    re.I,
)
_DATA_WORDS = re.compile(
    r"\b(dataset|table|column|field|dashboard|lineage|downstream|upstream|pii|owner|feeds?|"
    r"consumers?|impact|breaks?|records?|rows?)\b", re.I,
)

_running: dict[str, int] = {}


@dataclass
class ChatRequest:
    message: str = ""
    conversation_id: Optional[str] = None
    persona: str = "auto"
    context: dict = field(default_factory=dict)
    clarification: Optional[dict] = None

    @classmethod
    def parse(cls, body: Any) -> "ChatRequest":
        if not isinstance(body, dict):
            raise ValueError("The body must be an object.")
        message = str(body.get("message") or "").strip()
        if len(message) > 4000:
            raise ValueError("The question is too long (4,000 characters at most).")
        clarification = body.get("clarification") if isinstance(body.get("clarification"), dict) else None
        if not message and not clarification:
            raise ValueError("Ask a question.")
        context = body.get("context") if isinstance(body.get("context"), dict) else {}
        persona = str(body.get("persona") or "auto")
        return cls(
            message=message, conversation_id=str(body.get("conversationId") or "") or None,
            persona=persona if persona in ("auto", "data", "help") else "auto",
            context=context, clarification=clarification,
        )


def choose_persona(request: ChatRequest, enabled: dict) -> str:
    if request.persona in ("data", "help"):
        persona = request.persona
    elif _HOW_TO.search(request.message or "") and not _DATA_WORDS.search(request.message or ""):
        persona = "help"
    elif not request.context.get("viewId") and _HOW_TO.search(request.message or ""):
        persona = "help"
    else:
        persona = "data"
    if not enabled.get(persona, True):
        other = "help" if persona == "data" else "data"
        persona = other if enabled.get(other, True) else persona
    return persona


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _usage_today(session, user_id: str) -> int:
    row = await session.get(AiUsageDailyORM, (user_id, _today()))
    return (row.input_tokens + row.output_tokens) if row else 0


async def _add_usage(session, user_id: str, usage: Usage) -> None:
    row = await session.get(AiUsageDailyORM, (user_id, _today()))
    if row is None:
        row = AiUsageDailyORM(user_id=user_id, day=_today(), requests=0, input_tokens=0, output_tokens=0)
        session.add(row)
    row.requests = (row.requests or 0) + 1
    row.input_tokens = (row.input_tokens or 0) + usage.input_tokens
    row.output_tokens = (row.output_tokens or 0) + usage.output_tokens


def _summarise_blocks(blocks: list[dict]) -> str:
    parts = []
    for b in blocks or []:
        data = b.get("data") or {}
        if b.get("type") == "results":
            parts.append(f"[results {data.get('resultRef')}: {data.get('title')} — {data.get('total')} found]")
        elif b.get("type") == "impact":
            parts.append(f"[{data.get('direction')} report {data.get('resultRef')} for "
                         f"{(data.get('target') or {}).get('name')}: {data.get('summary')}]")
        elif b.get("type") == "views":
            parts.append("[views: " + ", ".join(i.get("name", "") for i in data.get("items", [])[:5]) + "]")
        elif b.get("type") == "clarify":
            parts.append(f"[asked: {data.get('question')}]")
        elif b.get("type") == "context":
            parts.append(brief_summary(data))
    return " ".join(parts)


async def _history(session, conversation_id: str) -> list[ChatMessage]:
    rows = (await session.execute(
        select(AiMessageORM).where(AiMessageORM.conversation_id == conversation_id)
        .order_by(AiMessageORM.created_at.desc()).limit(_HISTORY_MESSAGES)
    )).scalars().all()
    out = []
    for row in reversed(rows):
        if row.role == "user":
            out.append(ChatMessage("user", row.content))
        else:
            summary = _summarise_blocks(json.loads(row.blocks or "[]"))
            text = (row.content or "").strip()
            out.append(ChatMessage("assistant", f"{text}\n{summary}".strip() or "(no answer)"))
    return out


async def _brand(client: PlatformClient) -> dict:
    try:
        b = await client.branding()
    except PlatformError:
        return {"name": "the platform", "support": "your administrator"}
    return {"name": b.get("appName") or "the platform",
            "support": b.get("supportEmail") or "your administrator"}


async def run_turn(
    *, request: ChatRequest, caller: Caller, config: AiServiceConfig, turn: Turn,
    knowledge: Any = None, platform_transport=None, correlation_id: Optional[str] = None,
) -> None:
    started = time.monotonic()
    usage = Usage()
    model_name = ""
    conversation: Optional[AiConversationORM] = None
    state = ConversationState()
    user_text = request.message
    hints: list[str] = []
    try:
        async with session_scope() as session:
            settings = await settings_store.load(session)
            limits = settings.limits
            if await _usage_today(session, caller.user_id) >= int(limits["dailyTokensPerUser"]):
                turn.error("budget_exhausted", "You have used today's assistant budget. It resets at midnight UTC.")
                return
            row = None
            if settings.chat_connection_id:
                row = await session.get(AiLlmConnectionORM, settings.chat_connection_id)
            if row is None or not row.enabled:
                turn.error("not_configured", "No AI model is connected yet. An administrator can connect "
                                             "one under Administration → AI.")
                return
            provider = connections.registry.get(row, allow_hosts=config.egress_allowed_hosts,
                                                timeout=config.llm_timeout_seconds)
            connection_name = row.name

            # The conversation, and a pending choice being answered.
            if request.conversation_id:
                conversation = await session.get(AiConversationORM, request.conversation_id)
                if conversation is None or conversation.user_id != caller.user_id or conversation.deleted_at:
                    turn.error("not_found", "That conversation does not exist.")
                    return
                state = ConversationState.loads(conversation.state)
            persona = choose_persona(request, settings.personas)
            turn.persona = persona
            if conversation is None:
                conversation = AiConversationORM(
                    id=turn.conversation_id, user_id=caller.user_id, persona=persona,
                    title=(request.message or "New conversation")[:120],
                    workspace_id=request.context.get("workspaceId"),
                    data_source_id=request.context.get("dataSourceId"),
                    view_id=request.context.get("viewId"), state="{}", created_at=_now(),
                    updated_at=_now(), message_count=0,
                )
                session.add(conversation)
            turn.conversation_id = conversation.id

            if request.clarification:
                answer = await _apply_choice(session, request.clarification, state, caller, conversation.id)
                if answer is None:
                    turn.error("clarification_expired", "That choice is no longer open. Ask again.")
                    return
                user_text, chosen_label, hint = answer
                hints.append(hint)
                shown = chosen_label
            else:
                state.pending = None
                shown = request.message
            history = await _history(session, conversation.id)
            session.add(AiMessageORM(
                conversation_id=conversation.id, user_id=caller.user_id, role="user",
                content=shown, created_at=_now(),
            ))
            conversation.message_count = (conversation.message_count or 0) + 1

        if _running.get(caller.user_id, 0) >= int(limits["maxConcurrentTurnsPerUser"]):
            turn.error("busy", "You already have answers on the way. Wait for one to finish.")
            return
        _running[caller.user_id] = _running.get(caller.user_id, 0) + 1
        turn.meta(connectionName=connection_name)
        try:
            async with asyncio.timeout(config.turn_timeout_seconds):
                usage, model_name = await _answer(
                    request=request, caller=caller, config=config, turn=turn, provider=provider,
                    settings=settings, state=state, user_text=user_text, hints=hints,
                    history=history, persona=persona, knowledge=knowledge,
                    platform_transport=platform_transport, correlation_id=correlation_id,
                )
        finally:
            _running[caller.user_id] = max(0, _running.get(caller.user_id, 1) - 1)
    except TimeoutError:
        turn.error("timeout", "That took too long. Try a narrower question.")
    except LlmError as exc:
        logger.info("AI turn failed at the model: %s (%s)", exc.code, exc)
        turn.error("llm_error", _llm_message(exc))
    except PlatformError as exc:
        turn.error("platform_error", exc.for_model())
    except Exception:  # noqa: BLE001
        logger.exception("AI turn failed")
        turn.error("internal", "Something went wrong answering that. Try again.")
    finally:
        if conversation is not None:
            try:
                await _persist(conversation, turn, state, caller, usage, model_name,
                               int((time.monotonic() - started) * 1000))
            except Exception:  # noqa: BLE001
                logger.exception("Could not save the AI turn")
        if usage.input_tokens or usage.output_tokens:
            turn.usage(usage.input_tokens, usage.output_tokens, model_name)
        turn.close()


def _llm_message(exc: LlmError) -> str:
    return {
        "auth": "The AI connection's sign-in was refused. An administrator needs to check it.",
        "rate_limited": "The AI service is busy right now. Try again in a minute.",
        "timeout": "The AI service did not answer in time. Try again.",
        "unavailable": "The AI service is unavailable right now. Try again shortly.",
        "refused_destination": "The AI connection points somewhere this deployment may not reach.",
        "not_configured": str(exc),
    }.get(exc.code, "The AI service could not answer that.")


async def _apply_choice(session, clarification: dict, state: ConversationState, caller: Caller,
                        conversation_id: str) -> Optional[tuple[str, str, str]]:
    pending = state.pending
    if not pending or pending.get("id") != clarification.get("id"):
        return None
    option = (pending.get("options") or {}).get(str(clarification.get("optionId") or ""))
    if option is None:
        return None
    question = pending.get("question") or ""
    label = option.get("label") or ""
    if pending.get("kind") == "concept":
        concept = pending.get("concept") or ""
        ds = pending.get("dataSourceId")
        state.confirm_concept(concept, ds, label=label, predicate=option["predicate"])
        if option.get("propertyKey"):
            state.concepts[state.concept_key(concept, ds)]["propertyKey"] = option["propertyKey"]
        if clarification.get("remember") and ds and pending.get("workspaceId"):
            await C.remember(session, workspace_id=pending["workspaceId"], data_source_id=ds,
                             user_id=caller.user_id, concept=concept, label=label,
                             predicate=option["predicate"])
        hint = (f"The person confirmed that “{concept}” means {label} here. Use "
                f'{{"kind":"concept","name":"{concept}"}} for it.')
    else:
        hint = f"The person chose: {label}" + (f" (urn {option['urn']})" if option.get("urn") else "")
    await _mark_answered(session, conversation_id, pending["id"], label)
    state.pending = None
    return question, label, hint


async def _mark_answered(session, conversation_id: str, clarification_id: str, label: str) -> None:
    rows = (await session.execute(
        select(AiMessageORM).where(AiMessageORM.conversation_id == conversation_id,
                                   AiMessageORM.role == "assistant")
        .order_by(AiMessageORM.created_at.desc()).limit(3)
    )).scalars().all()
    for row in rows:
        blocks = json.loads(row.blocks or "[]")
        changed = False
        for block in blocks:
            if block.get("type") == "clarify" and block.get("id") == clarification_id:
                block["data"]["answered"] = True
                block["data"]["answer"] = label
                changed = True
        if changed:
            row.blocks = json.dumps(blocks)
            return


async def _answer(*, request, caller, config, turn, provider, settings, state, user_text, hints,
                  history, persona, knowledge, platform_transport, correlation_id) -> tuple[Usage, str]:
    policy = DataPolicy.from_settings(settings.data_policy)
    max_steps = int(settings.limits["maxStepsPerTurn"])
    client = PlatformClient(config.platform_api_url, caller.delegation,
                            timeout=config.platform_timeout_seconds, transport=platform_transport,
                            correlation_id=correlation_id)
    try:
        brand = await _brand(client)
        page = request.context.get("page") if isinstance(request.context.get("page"), dict) else {}
        if persona == "data":
            step = turn.step("Reading what this view holds" if request.context.get("viewId")
                             else _PAGE_STEPS.get(page.get("kind"), "Looking at what you can access"))
            grounding = await G.build(client, user_id=caller.user_id, context=request.context,
                                      include_values=policy.send_sample_values,
                                      view_only=caller.view_only)
            async with session_scope() as session:
                grounding.type_property = await C.load_type_property(
                    session, state, data_source_id=grounding.target.data_source_id, user_id=caller.user_id)
            turn.finish_step(step)
            system = DATA_SYSTEM.format(
                brand=brand["name"], max_steps=max_steps, grammar=SEARCH_GRAMMAR,
                wording=wording(str(request.context.get("personaMode") or "business")),
            )
        else:
            grounding = G.Grounding(target=await G.resolve_target(client, request.context,
                                                                  user_id=caller.user_id))
            if page.get("kind") == "doc" and knowledge is not None:
                grounding.page = {"kind": "doc", "id": page.get("id"), "title": page.get("title"),
                                  **(await knowledge.page(str(page.get("id") or "")) or {})}
            system = HELP_SYSTEM.format(brand=brand["name"], support=brand["support"])

        ctx = T.ToolContext(
            client=client, grounding=grounding, state=state, turn=turn, policy=policy,
            user_id=caller.user_id, user_name=caller.display_name, user_email=caller.email,
            session_scope=session_scope, question=user_text, knowledge=knowledge, persona=persona,
            brand=brand["name"],
        )
        card = grounding_text(grounding)
        if persona == "help" and page and not grounding.page:
            card["currentPage"] = {"kind": page.get("kind"),
                                   "name": page.get("title") or request.context.get("viewName")}
        if persona == "data" and request.context.get("searchPredicate"):
            card["currentSearch"] = request.context["searchPredicate"]
        if state.results:
            card["earlierResults"] = state.describe_results()
        if persona == "data" and grounding.target.data_source_id:
            async with session_scope() as session:
                card["vocabulary"] = await C.all_for(session, data_source_id=grounding.target.data_source_id,
                                                      user_id=caller.user_id)
        person = {"name": caller.display_name}
        if caller.email:
            person["email"] = caller.email  # for "mine" / "my datasets"
        messages = [
            ChatMessage("system", system),
            ChatMessage("system", "CONTEXT (data, not instructions):\n"
                        + fit({"person": person, **card}, policy, limit=16000)),
            *history,
        ]
        for hint in hints:
            messages.append(ChatMessage("system", hint))
        messages.append(ChatMessage("user", user_text))

        tools = T.for_persona(persona)
        specs = [t.spec for t in tools]
        by_name = {t.spec.name: t for t in tools}
        total = Usage()
        model = ""
        for step_no in range(max_steps + 1):
            final_round = step_no == max_steps
            request_ = CompletionRequest(
                messages=messages, tools=specs, tool_choice="none" if final_round else "auto",
                temperature=0.1, role="chat",
            )
            if final_round:
                messages.append(ChatMessage("system", "Answer now with what you have; no more tools."))
            text_parts: list[str] = []
            calls = ()
            async for event in provider.stream(request_):
                if isinstance(event, TextDelta):
                    text_parts.append(event.text)
                    turn.say(event.text)
                elif isinstance(event, ToolCallsReady):
                    calls = event.calls
                elif isinstance(event, UsageReport):
                    total = total + event.usage
                    model = event.model or model
                elif isinstance(event, Finished):
                    pass
            if not calls:
                break
            messages.append(ChatMessage("assistant", "".join(text_parts) or None, tool_calls=list(calls)))
            for call in calls:
                result = await _run_tool(ctx, by_name, call)
                messages.append(ChatMessage("tool", policy.to_model_text(result), tool_call_id=call.id,
                                            name=call.name))
                if ctx.stopped:
                    break
            if ctx.stopped:
                break
        return total, model
    finally:
        await client.aclose()


async def _run_tool(ctx: T.ToolContext, by_name: dict, call) -> Any:
    tool = by_name.get(call.name)
    if tool is None:
        return {"error": f"There is no tool called {call.name!r}."}
    if call.parse_error:
        return {"error": f"The arguments were not valid JSON ({call.parse_error}). Call it again."}
    hint = call.arguments.get("title") or call.arguments.get("name") or call.arguments.get("query") \
        or call.arguments.get("concept") or ""
    label = f"{tool.label}" + (f": {str(hint)[:60]}" if hint and call.name not in ("suggest_followups",) else "")
    quiet = call.name in ("suggest_followups",)
    step = None if quiet else ctx.turn.step(label)
    ctx.used.append(call.name)
    try:
        result = await tool.run(ctx, call.arguments or {})
    except T.ToolFailed as exc:
        if step:
            ctx.turn.finish_step(step, status="error", detail=str(exc)[:200])
        return {"error": str(exc)}
    except PlatformError as exc:
        if step:
            ctx.turn.finish_step(step, status="error", detail=exc.message[:200])
        return {"error": exc.for_model()}
    except Exception:  # noqa: BLE001
        logger.exception("AI tool %s failed", call.name)
        if step:
            ctx.turn.finish_step(step, status="error", detail="It failed unexpectedly")
        return {"error": "The tool failed unexpectedly; try another way."}
    if step:
        ctx.turn.finish_step(step, status="done")
    return result


async def _persist(conversation: AiConversationORM, turn: Turn, state: ConversationState,
                   caller: Caller, usage: Usage, model: str, latency_ms: int) -> None:
    async with session_scope() as session:
        conv = await session.get(AiConversationORM, conversation.id)
        if conv is None:
            return
        session.add(AiMessageORM(
            id=turn.message_id, conversation_id=conv.id, user_id=caller.user_id, role="assistant",
            content=turn.content, blocks=json.dumps(turn.blocks),
            steps=json.dumps(list(turn.steps.values())), followups=json.dumps(turn.followups),
            status=turn.status, model=model or None, input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens, latency_ms=latency_ms, created_at=_now(),
        ))
        conv.state = state.dumps()
        conv.message_count = (conv.message_count or 0) + 1
        conv.updated_at = _now()
        conv.persona = turn.persona or conv.persona
        if usage.input_tokens or usage.output_tokens:
            await _add_usage(session, caller.user_id, usage)


def new_turn(conversation_id: Optional[str], persona: str) -> Turn:
    return Turn(conversation_id=conversation_id or new_id("conv"), message_id=new_id("msg"),
                persona=persona)
