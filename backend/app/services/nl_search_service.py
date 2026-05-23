"""
Natural-Language → SearchQuery translator. Powers the "Ask" tab in
SearchMapPanel and any AI-agent client that prefers plain English over
hand-authored JSON.

The pipeline:

1. The user's English question lands at `POST /search/nl` with the
   target view's id.
2. `NLSearchService` builds a prompt with three sections that benefit
   from Anthropic prompt caching (the prefix is identical across users
   and turns; only the question varies):
       a. The `SearchQuery` JSON Schema (machine-extracted from the
          Pydantic model — never drifts).
       b. The view's discovered entity types + native property keys,
          via the existing discover endpoint. Tells the model what's
          actually queryable in *this* graph.
       c. A few-shot example block loaded from `nl_examples.yaml`
          covering the four headline use cases plus a couple of
          negative examples (so the model politely refuses
          mutation-style requests).
3. Claude returns a JSON object. Pydantic validates it as a
   `SearchQuery`. On parse / validation failure the service retries
   once with the error in the prompt; second failure raises
   `NLTranslationError`.
4. The validated query is returned to the caller (the endpoint then
   runs it through `AdvancedSearchService.search()` so the result
   pipeline — ViewScopeResolver, caps, audit — is identical to every
   other search).

Conversation state (multi-turn) is kept in a small in-memory store
keyed by `conversation_id` for v1. Promoting to Redis (with the same
TTL semantics) is a follow-up that mirrors the result-cache wiring.

Cost & safety:
* Per-user soft budget (50/hr) + hard budget (200/day) enforced at the
  service edge. Exceeding either returns HTTP 429.
* The Anthropic SDK call is wrapped in a timeout; on connection failure
  the service surfaces a clear "NL search is temporarily unavailable"
  message rather than masking the LLM dependency.
* The model only ever produces JSON conforming to `SearchQuery`; it
  *cannot* emit raw Cypher or any other shape. The Pydantic validator
  is the safety net.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, ValidationError

from backend.common.models.search import SearchQuery


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public exceptions
# ---------------------------------------------------------------------------

class NLSearchUnavailableError(RuntimeError):
    """The translator can't reach the LLM (missing key, network error,
    quota exhausted). The endpoint maps this to HTTP 503 with a clear
    message so the FE can show 'Ask is offline — use templates' rather
    than a generic failure."""


class NLTranslationError(ValueError):
    """The model returned something that didn't validate as a
    SearchQuery, even after one retry with the validation error in the
    prompt. The endpoint maps to HTTP 422 and includes the model's
    last output in the audit log."""


class NLBudgetExceededError(RuntimeError):
    """The caller has used their hourly or daily Ask budget."""


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------

class NLSearchRequest(BaseModel):
    """POST body for `/search/nl`."""
    question: str = Field(min_length=1, max_length=2_000)
    view_id: str = Field(alias="viewId", min_length=1)
    scope_hint: Optional[Literal["view", "workspace"]] = Field(
        "view", alias="scopeHint",
        description="Default 'view' clamps to the active view's URN set. "
                    "'workspace' widens to the workspace (still subject to "
                    "ViewScopeResolver rules in the executor).",
    )
    conversation_id: Optional[str] = Field(
        None, alias="conversationId",
        description="Echoed back in the response. Subsequent turns reuse "
                    "this id; the service replays the last N turns to "
                    "preserve refinement context.",
    )

    class Config:
        populate_by_name = True


class NLSearchResponse(BaseModel):
    interpreted_query: SearchQuery = Field(alias="interpretedQuery")
    interpretation_notes: str = Field(
        "", alias="interpretationNotes",
        description="The model's one-line summary of how it read the "
                    "question. Shown above the results in the Ask tab.",
    )
    model_used: str = Field(alias="modelUsed")
    conversation_id: str = Field(alias="conversationId")

    class Config:
        populate_by_name = True


# ---------------------------------------------------------------------------
# Conversation state — in-memory for v1, Redis follow-up.
# ---------------------------------------------------------------------------

@dataclass
class _ConvTurn:
    question: str
    interpreted: Dict[str, Any]
    ts: float


@dataclass
class _Conversation:
    conv_id: str
    turns: List[_ConvTurn] = field(default_factory=list)
    last_touched: float = field(default_factory=time.time)


class _ConversationStore:
    """Cheap in-memory rolling window. Expires entries after
    ``CONVERSATION_TTL_S``. Promote to Redis once we have multi-replica
    deployment (the keys / TTL semantics map 1:1 onto SET/EX).
    """
    CONVERSATION_TTL_S = 30 * 60  # 30 minutes
    MAX_TURNS = 8

    def __init__(self) -> None:
        self._store: Dict[str, _Conversation] = {}

    def _evict(self) -> None:
        cutoff = time.time() - self.CONVERSATION_TTL_S
        stale = [k for k, v in self._store.items() if v.last_touched < cutoff]
        for k in stale:
            self._store.pop(k, None)

    def get_or_create(self, conv_id: Optional[str]) -> _Conversation:
        self._evict()
        if conv_id and conv_id in self._store:
            c = self._store[conv_id]
            c.last_touched = time.time()
            return c
        # New conversation — use the supplied id if any, else mint one.
        new_id = conv_id or f"nl-{int(time.time() * 1000)}"
        c = _Conversation(conv_id=new_id)
        self._store[new_id] = c
        return c

    def append(self, conv: _Conversation, question: str,
               interpreted: Dict[str, Any]) -> None:
        conv.turns.append(_ConvTurn(
            question=question, interpreted=interpreted, ts=time.time(),
        ))
        # Roll oldest turns out so the prompt stays bounded.
        if len(conv.turns) > self.MAX_TURNS:
            conv.turns = conv.turns[-self.MAX_TURNS:]
        conv.last_touched = time.time()


# ---------------------------------------------------------------------------
# Per-user budget tracker — same in-memory caveat applies.
# ---------------------------------------------------------------------------

class _BudgetTracker:
    HOURLY_LIMIT = 50
    DAILY_LIMIT = 200

    def __init__(self) -> None:
        # key: (user_id, "hourly"|"daily"); value: (count, window_start)
        self._counts: Dict[tuple, tuple[int, float]] = {}

    def _reset_window(self, count_window: float, window_s: int) -> bool:
        """True iff we crossed into a new window since count_window."""
        return time.time() - count_window > window_s

    def check_and_increment(self, user_id: str) -> None:
        now = time.time()
        for key_suffix, limit, window_s in (
            ("hourly", self.HOURLY_LIMIT, 3600),
            ("daily", self.DAILY_LIMIT, 86_400),
        ):
            key = (user_id, key_suffix)
            cur = self._counts.get(key)
            if cur is None or self._reset_window(cur[1], window_s):
                self._counts[key] = (1, now)
                continue
            count, started = cur
            if count >= limit:
                raise NLBudgetExceededError(
                    f"Ask budget exceeded ({key_suffix}: {count}/{limit})."
                )
            self._counts[key] = (count + 1, started)


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------

# Model choices exposed via env. Defaults to Sonnet 4.6 (good
# structured-output performance / cost balance per the user memory).
_DEFAULT_MODEL = os.getenv("NL_SEARCH_MODEL", "claude-sonnet-4-6")
_API_KEY_ENV = "ANTHROPIC_API_KEY"
_CALL_TIMEOUT_S = 30


class NLSearchService:
    """Stateful service — owns the in-memory conversation + budget
    stores. Instantiated once per process by the FastAPI DI container.

    Keep this class testable: every external dependency is injected
    (provider for discover, anthropic client factory) so unit tests can
    stub them without touching the network or the real model.
    """

    def __init__(
        self,
        *,
        examples_path: str = "backend/app/services/nl_examples.yaml",
        client_factory: Optional[callable] = None,
    ):
        self._examples_path = examples_path
        self._client_factory = client_factory or self._default_client_factory
        self._conv = _ConversationStore()
        self._budget = _BudgetTracker()
        self._cached_prefix: Optional[str] = None

    # ----- prompt construction ---------------------------------------

    def _load_examples(self) -> Dict[str, Any]:
        try:
            import yaml  # type: ignore
        except ImportError:
            # PyYAML is a transitive dep of one of the existing libs;
            # we don't add it explicitly here. Surface a clear error.
            raise NLSearchUnavailableError(
                "PyYAML is required for NL search examples; install it"
            )
        with open(self._examples_path, "r") as f:
            return yaml.safe_load(f) or {}

    def _schema_block(self) -> str:
        """JSON Schema dump of SearchQuery. Cached because it never
        changes within a process lifetime."""
        return json.dumps(SearchQuery.model_json_schema(), indent=2)

    def _examples_block(self) -> str:
        ex = self._load_examples()
        pos = ex.get("examples", []) or []
        neg = ex.get("negative_examples", []) or []
        lines: List[str] = ["## Positive examples\n"]
        for item in pos:
            lines.append(f"### Question: {item['question']}")
            lines.append(f"Interpretation: {item['interpreted']}\n")
            lines.append("Query JSON:\n```json")
            lines.append(json.dumps(item["query"], indent=2))
            lines.append("```\n")
        if neg:
            lines.append("\n## Refusal examples")
            lines.append(
                "For these question shapes, respond with `{\"refusal\": "
                "\"<one-line reason>\"}` instead of a query.\n"
            )
            for item in neg:
                lines.append(f"- {item['question']} → {item['response']}")
        return "\n".join(lines)

    def _system_prompt(self, *, view_facts: Dict[str, Any]) -> str:
        """Built once per request (the view's facts vary) but the
        non-view portions are stable — Anthropic prompt caching kicks
        in on the prefix so we pay for the cache build once."""
        return (
            "You translate plain-English questions about a graph "
            "catalog into a single JSON object that conforms to the "
            "SearchQuery schema below. Reply with the JSON object "
            "only — no preamble, no explanation outside the "
            "`interpretationNotes` field.\n\n"
            "Rules:\n"
            "- Output JUST a JSON object: either `{\"query\": "
            "{...SearchQuery...}, \"notes\": \"<one line>\"}` or "
            "`{\"refusal\": \"<one line>\"}` for non-searchable "
            "requests (mutations, anything outside SearchQuery's "
            "capabilities).\n"
            "- The query MUST match the SearchQuery JSON Schema "
            "exactly — every field name and discriminator value as "
            "shown in examples.\n"
            "- Use camelCase field names (sourceUrns, edgePredicate, "
            "etc.) — they match the schema aliases.\n"
            "- Prefer Map-mode (`results: both` with an aggregation "
            "by `ancestorType`/`entityType`) when the user wants an "
            "overview; use `results: hits` when they want a concrete "
            "list.\n"
            "- Use `kind: path` ONLY when the question explicitly "
            "names two endpoints.\n"
            "- Use `kind: withinHops` for 'within N hops of X' "
            "lineage drill questions.\n"
            "- Property keys must match what's available in this view "
            "(see View facts below) — if the user references a key "
            "you don't see, use the closest plausible match and "
            "explain in `notes`.\n"
            "- Never invent URNs. If the user references 'this view', "
            "do NOT set `scope.rootUrns`; the executor stamps "
            "`scope.viewId` itself.\n\n"
            f"## SearchQuery JSON Schema\n```json\n{self._schema_block()}\n```\n\n"
            f"{self._examples_block()}\n\n"
            "## View facts\n"
            f"Entity types in this view: {', '.join(view_facts.get('entityTypes', [])) or '(none)'}\n"
            f"Sample property keys per label: "
            f"{json.dumps(view_facts.get('keysByLabel', {}), indent=2)}\n"
        )

    # ----- the call --------------------------------------------------

    def _default_client_factory(self):
        if not os.getenv(_API_KEY_ENV):
            raise NLSearchUnavailableError(
                "ANTHROPIC_API_KEY is not configured on the backend."
            )
        try:
            import anthropic  # type: ignore
        except ImportError as e:
            raise NLSearchUnavailableError(
                "anthropic SDK is not installed; "
                "`pip install -r backend/requirements.txt`"
            ) from e
        return anthropic.Anthropic(timeout=_CALL_TIMEOUT_S)

    def _call_llm(
        self,
        *,
        system: str,
        history: List[_ConvTurn],
        question: str,
        retry_with_error: Optional[str] = None,
    ) -> str:
        """Returns the raw assistant text (expected to be JSON)."""
        client = self._client_factory()
        messages: List[Dict[str, Any]] = []
        for turn in history:
            messages.append({"role": "user", "content": turn.question})
            messages.append({
                "role": "assistant",
                "content": json.dumps(turn.interpreted),
            })
        user_content = question
        if retry_with_error:
            user_content += (
                "\n\nYour previous reply did not validate as a "
                f"SearchQuery. Validation error:\n{retry_with_error}\n"
                "Reply with corrected JSON only."
            )
        messages.append({"role": "user", "content": user_content})
        resp = client.messages.create(  # type: ignore[union-attr]
            model=_DEFAULT_MODEL,
            max_tokens=2048,
            system=[{
                "type": "text",
                "text": system,
                # Cache the static schema + examples prefix across
                # turns. Keeps the marginal cost of each Ask request
                # to roughly the size of the user's question.
                "cache_control": {"type": "ephemeral"},
            }],
            messages=messages,
        )
        # Anthropic returns a list of content blocks; pull the first
        # text block.
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                return block.text  # type: ignore[attr-defined]
        return ""

    # ----- the entry point ------------------------------------------

    def translate(
        self,
        request: NLSearchRequest,
        *,
        user_id: str,
        view_facts: Dict[str, Any],
    ) -> NLSearchResponse:
        """Turn the user's English question into a validated SearchQuery."""
        self._budget.check_and_increment(user_id)
        conv = self._conv.get_or_create(request.conversation_id)
        system = self._system_prompt(view_facts=view_facts)

        # First attempt.
        raw = self._call_llm(
            system=system, history=conv.turns, question=request.question,
        )
        parsed = self._parse_response(raw)
        if parsed is None:
            # One retry with the validation error in the prompt.
            raw2 = self._call_llm(
                system=system, history=conv.turns,
                question=request.question,
                retry_with_error=(
                    "JSON was malformed or did not match SearchQuery."
                ),
            )
            parsed = self._parse_response(raw2)
        if parsed is None:
            raise NLTranslationError(
                "Could not produce a valid SearchQuery after one retry. "
                f"Last model output: {raw[:400]!r}"
            )
        if "refusal" in parsed:
            raise NLTranslationError(
                f"Question is not searchable: {parsed['refusal']}"
            )

        query_dict = parsed.get("query") or {}
        notes = parsed.get("notes") or ""
        # Stamp the view id regardless of what the model produced.
        scope = query_dict.get("scope") or {}
        scope["viewId"] = request.view_id
        query_dict["scope"] = scope

        try:
            query = SearchQuery.model_validate(query_dict)
        except ValidationError as e:
            raise NLTranslationError(
                f"Model output failed Pydantic validation: {e}"
            )

        # Record the turn so subsequent questions get context.
        self._conv.append(conv, request.question, query_dict)
        return NLSearchResponse(
            interpreted_query=query,
            interpretation_notes=str(notes),
            model_used=_DEFAULT_MODEL,
            conversation_id=conv.conv_id,
        )

    @staticmethod
    def _parse_response(raw: str) -> Optional[Dict[str, Any]]:
        """Pull a JSON object out of the model's text reply. Models
        sometimes wrap JSON in ```json fences — strip those first.
        Returns None on parse failure so the caller can retry."""
        text = raw.strip()
        if text.startswith("```"):
            # Drop the opening fence (with optional ```json) and the
            # trailing fence.
            lines = text.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            logger.warning("nl_search: model produced non-JSON output")
            return None
