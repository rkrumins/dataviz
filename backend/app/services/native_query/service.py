"""One native read-only query, from request to answer.

The order keeps it cheap to refuse and safe to run:

1. **how often** — ``NATIVE_QUERY_RATE`` per person (429);
2. **what** — the guard, then the row cap written into the query;
3. **how many at once** — ``NATIVE_QUERY_CONCURRENCY`` per data source, per
   process (429);
4. **the engine** — once, cancelled when the person goes away;
5. **how big** — the answer cut at ``MAX_RESPONSE_BYTES``;
6. **the record** — one activity event for every run that reached the guard,
   committed before a row is sent: no record, no rows (503);
7. metrics, and one log line that never carries the query.

Who may run it is decided before this (``access``). Every failure leaves as a
``NativeQueryFailure`` — a status, a code, plain words, and where in the query
when known — and never names a host, a port or a credential.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.bulkhead import Bulkhead, Busy
from backend.app.jobs.metrics import increment, observe
from backend.app.services.activity.recorder import record_for_request
from backend.app.services.native_query import guard
from backend.app.services.native_query.limit import cap_rows
from backend.app.services.native_query.settings import NativeQuerySettings, get_native_query_settings
from backend.auth_service.ratelimit import get_account_limiter
from backend.common.adapters import ProviderBusy, ProviderUnavailable
from backend.common.interfaces.native_query import (
    NativeQueryError,
    NativeQueryTimeout,
    NativeQueryTooLarge,
)
from backend.common.models.search import NativeQueryRequest, NativeQueryResponse

logger = logging.getLogger(__name__)

EVENT = "workspace.data_source.native_query_run"
#: The most an answer may weigh, as JSON.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
#: How much of the query the activity record keeps.
AUDIT_QUERY_CHARS = 8_192
#: How often to ask whether the person is still there.
_DISCONNECT_POLL_S = 0.5
_RATE_SCOPE = "native_query"


class NativeQueryFailure(Exception):
    """A refusal or failure, as the person reads it."""

    def __init__(self, status: int, code: str, message: str, *, position: Optional[int] = None,
                 retry_after: Optional[int] = None, permission: Optional[str] = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.position, self.retry_after, self.permission = position, retry_after, permission


@dataclass(frozen=True)
class NativeRun:
    """Who runs it, where, and how they were let in."""
    workspace_id: str
    data_source_id: str
    data_source_label: str
    user_id: str
    engine: str
    via: str
    view_id: Optional[str]
    request_id: str


class _ClientGone(Exception):
    pass


_bulkheads: Dict[str, Bulkhead] = {}


def _bulkhead(data_source_id: str, settings: NativeQuerySettings) -> Bulkhead:
    held = _bulkheads.get(data_source_id)
    if held is None or held.limit != settings.concurrency:
        held = _bulkheads[data_source_id] = Bulkhead(
            "native queries on this data source", settings.concurrency,
            wait_seconds=2.0, retry_after_seconds=5,
        )
    return held


async def run_native_query(
    provider: Any, run: NativeRun, body: NativeQueryRequest, session: AsyncSession, *,
    is_disconnected: Callable[[], Awaitable[bool]],
    settings: Optional[NativeQuerySettings] = None,
) -> NativeQueryResponse:
    settings = settings or get_native_query_settings()
    limiter = get_account_limiter()
    if not await limiter.consume(_RATE_SCOPE, run.user_id, settings.rate):
        retry = await limiter.retry_after_seconds(_RATE_SCOPE, run.user_id, settings.rate,
                                                  consumed=True)
        raise NativeQueryFailure(
            429, "rate_limited",
            "You've run a lot of queries in a short time. Try again in a moment.",
            retry_after=retry,
        )

    limit = min(body.limit or settings.default_rows, settings.max_rows)
    timeout_ms = min(body.timeout_ms or settings.default_timeout_ms, settings.max_timeout_ms)
    # One spelling of a line break for the guard, the row cap and the engine.
    query = guard.normalized(body.query)
    query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]
    started = time.monotonic()
    notes: List[str] = []
    if body.limit and body.limit > settings.max_rows:
        notes.append(f"At most {settings.max_rows:,} rows can be shown.")
    if body.timeout_ms and body.timeout_ms > settings.max_timeout_ms:
        notes.append(f"A query may run for at most {settings.max_timeout_ms / 1000:g}s.")

    answer: Optional[NativeQueryResponse] = None
    failure: Optional[NativeQueryFailure] = None
    try:
        tokens = guard.check(query, engine=run.engine)
        capped = cap_rows(query, tokens, limit=limit, engine=run.engine)
        notes = list(capped.notes) + notes
        async with _bulkhead(run.data_source_id, settings).slot():
            result = await _unless_gone(
                provider.run_readonly_cypher(
                    capped.text, row_cap=limit + 1, timeout_ms=timeout_ms,
                    max_reply_bytes=settings.max_reply_bytes,
                ),
                is_disconnected,
            )
        rows, reason = _fit(result.rows, limit)
        answer = NativeQueryResponse(
            engine=run.engine, columns=result.columns, rows=rows, row_count=len(rows),
            truncated=reason is not None, truncated_reason=reason, limit_applied=limit,
            timeout_ms=timeout_ms, executed_query=capped.text, query_hash=query_hash,
            elapsed_ms=_ms_since(started), notes=notes, request_id=run.request_id,
        )
    except NativeQueryError as exc:
        failure = NativeQueryFailure(_status_of(exc), exc.code, exc.message, position=exc.position)
    except (Busy, ProviderBusy) as exc:
        failure = NativeQueryFailure(
            429, "busy", "Too many queries are running on this data source. Try again shortly.",
            retry_after=exc.retry_after_seconds,
        )
    except ProviderUnavailable as exc:
        failure = NativeQueryFailure(
            503, "unavailable", "The data source isn't answering. Try again shortly.",
            retry_after=exc.retry_after_seconds,
        )
    except NotImplementedError:
        failure = NativeQueryFailure(
            501, "native_query_unavailable", "Native queries aren't available on this data source.",
        )
    except _ClientGone:
        failure = NativeQueryFailure(499, "cancelled", "The query was cancelled.")
    except Exception:                                     # noqa: BLE001 — never the details
        logger.exception("native query failed (request %s)", run.request_id)
        failure = NativeQueryFailure(
            500, "native_query_failed",
            "The query failed on the server. Try again; if it keeps failing, tell an "
            "administrator, quoting the request id.",
        )

    outcome = "ok" if failure is None else failure.code
    elapsed_ms = _ms_since(started)
    try:
        await _record(session, run, query, query_hash, outcome=outcome, limit=limit,
                      timeout_ms=timeout_ms, answer=answer, elapsed_ms=elapsed_ms)
    except Exception:                                     # noqa: BLE001 — told below
        logger.exception("native query: the activity record failed (request %s)", run.request_id)
        if failure is None:
            failure = NativeQueryFailure(
                503, "audit_unavailable",
                "The run couldn't be recorded, so its answer is withheld. Try again shortly.",
                retry_after=5,
            )
            answer, outcome = None, failure.code
    _observe(run, outcome, query_hash, elapsed_ms, answer)
    if failure is not None:
        raise failure
    return answer


async def _unless_gone(work: Awaitable[Any], is_disconnected: Callable[[], Awaitable[bool]]) -> Any:
    """``work``'s result — or, when the person goes away first, ``_ClientGone``
    with the work cancelled (the engine's connection with it)."""
    task = asyncio.ensure_future(work)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=_DISCONNECT_POLL_S)
            if done:
                return task.result()
            if await is_disconnected():
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
                raise _ClientGone()
    except asyncio.CancelledError:
        task.cancel()
        raise


def _fit(rows: List[List[Any]], limit: int):
    """The rows a response carries — at most ``limit``, and no more than
    ``MAX_RESPONSE_BYTES`` of them — and why it stopped, if it did."""
    kept: List[List[Any]] = []
    size = 0
    for row in rows[:limit]:
        size += len(json.dumps(row, separators=(",", ":"), ensure_ascii=False)) + 1
        if size > MAX_RESPONSE_BYTES:
            return kept, "size"
        kept.append(row)
    return kept, ("rows" if len(rows) > limit else None)


def _status_of(exc: NativeQueryError) -> int:
    if isinstance(exc, NativeQueryTooLarge):
        return 422
    if isinstance(exc, NativeQueryTimeout):
        return 504
    return 400


async def _record(session: AsyncSession, run: NativeRun, query: str, query_hash: str, *,
                  outcome: str, limit: int, timeout_ms: int,
                  answer: Optional[NativeQueryResponse], elapsed_ms: int) -> None:
    """The run, in the activity log — committed now, so a run with no
    record never sends a row."""
    details: Dict[str, Any] = {
        "engine": run.engine,
        "outcome": outcome,
        "via": run.via,
        "queryHash": query_hash,
        "query": query[:AUDIT_QUERY_CHARS],
        "limit": limit,
        "timeoutMs": timeout_ms,
        "elapsedMs": elapsed_ms,
    }
    if len(query) > AUDIT_QUERY_CHARS:
        details["queryTruncated"] = True
    if run.view_id:
        details["viewId"] = run.view_id
    if answer is not None:
        details["rows"] = answer.row_count
        if answer.truncated:
            details["truncatedReason"] = answer.truncated_reason
    recorded = await record_for_request(
        session, EVENT, workspace_id=run.workspace_id, data_source_id=run.data_source_id,
        target_type="data_source", target_id=run.data_source_id,
        target_label=run.data_source_label, details=details,
    )
    if not recorded:
        raise RuntimeError("no signed-in person to record the run against")
    await session.commit()


def _observe(run: NativeRun, outcome: str, query_hash: str, elapsed_ms: int,
             answer: Optional[NativeQueryResponse]) -> None:
    rows = answer.row_count if answer is not None else 0
    increment("native_query_runs_total", engine=run.engine, outcome=outcome)
    observe("native_query_seconds", elapsed_ms / 1000, engine=run.engine)
    if rows:
        increment("native_query_rows_total", rows, engine=run.engine)
    logger.info(
        "native_query workspace=%s data_source=%s engine=%s via=%s outcome=%s rows=%d "
        "truncated=%s elapsed_ms=%d query_hash=%s request_id=%s",
        run.workspace_id, run.data_source_id, run.engine, run.via, outcome, rows,
        answer.truncated_reason if answer is not None and answer.truncated else "-",
        elapsed_ms, query_hash, run.request_id,
    )


def _ms_since(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
