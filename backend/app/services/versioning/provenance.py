"""Who made a commit, and how — what every commit records for the audit trail (doc 19 §3.6).

A commit always recorded its ``actor``. That alone could not say whether a person or automation
made it, which API key it came through, or which request — so an auditor could not tell a
person's edit from a connector's run, and nothing else recorded it either. Every commit now also
records:

* ``actor_kind`` — ``human``, ``service`` (a service account) or ``system`` (the platform itself);
* ``api_key_id`` — the API key the change came through, when it did;
* ``correlation_id`` — the request it came from.

They are read from the request's bound activity context (``activity_context``), so no service
signature carries them. A job runs with the context of the request that queued it: the job keeps
:func:`snapshot` and its runner binds it again (:func:`bound`), so a publish or an import a key
started is recorded as that key's, hours later, on a worker.

**Automation** is a commit made by a service account, by the platform, or through an API key — a
person's own key included: a script acting as them. The publish gate lets a person publish past
automation that touched none of their entities (doc 19 §3.5), and history can show People or
Automation alone.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Mapping, Optional

from sqlalchemy import and_, case, func, literal, or_

from backend.app.common import activity_context
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

HUMAN, SERVICE, SYSTEM = "human", "service", "system"
ACTOR_KINDS = (HUMAN, SERVICE, SYSTEM)

#: An actor the platform itself writes as: ``system`` and ``system:<what>`` (lifecycle, migration).
_SYSTEM_PREFIX = "system:"
#: A service principal of doc 12's spec (``svc:ingest:<source>``), should one ever write.
_SERVICE_PRINCIPAL_PREFIX = "svc:"


def actor_kind(actor: Optional[str]) -> str:
    """What kind of actor ``actor`` is: no actor, or the platform's own, is ``system``."""
    if not actor or actor == SYSTEM or actor.startswith(_SYSTEM_PREFIX):
        return SYSTEM
    if is_service_account(actor) or actor.startswith(_SERVICE_PRINCIPAL_PREFIX):
        return SERVICE
    return HUMAN


def commit_provenance(actor: Optional[str]) -> Dict[str, Optional[str]]:
    """The provenance columns of a commit ``actor`` is making now. The API key is the bound
    context's only when that context acts as ``actor``: a commit written in someone else's name
    (a draft owner's staged edits folded at a merge) did not come through the requester's key."""
    ctx = activity_context.current()
    acting = bool(ctx.actor_id) and ctx.actor_id == actor
    return {
        "actor_kind": actor_kind(actor),
        "api_key_id": ctx.api_key_id if acting else None,
        "correlation_id": ctx.correlation_id,
    }


def snapshot() -> Optional[Dict[str, str]]:
    """This request's provenance, for a job to keep (``field_scope["provenance"]``) and bind
    again where it runs. ``None`` outside a request."""
    ctx = activity_context.current()
    out = {k: v for k, v in (("actor", ctx.actor_id), ("apiKeyId", ctx.api_key_id),
                             ("correlationId", ctx.correlation_id)) if v}
    return out or None


@contextmanager
def bound(saved: Optional[Mapping[str, Any]]) -> Iterator[None]:
    """Run the block with the provenance a job kept (:func:`snapshot`) bound, as its request had
    it — so its commits and its activity events name the key and request that started it. A job
    that kept none runs as it always did."""
    if not saved:
        yield
        return
    token = activity_context.bind(activity_context.ActivityContext(
        actor_id=saved.get("actor") or None,
        api_key_id=saved.get("apiKeyId") or None,
        correlation_id=saved.get("correlationId") or None,
    ))
    try:
        yield
    finally:
        activity_context.reset(token)


async def job_provenance(job_id: str, session_factory=None) -> Optional[Dict[str, Any]]:
    """The provenance a job kept (``jobs.provenance``), or ``None`` — also when it can't be read:
    it attributes the job's work, and must never be why a job doesn't run. ``session_factory``:
    the runner's own (default: the graphver session)."""
    from sqlalchemy import select

    from . import db
    from .models import JobORM

    try:
        async with (session_factory or db.graphver_session)() as s:
            saved = await s.scalar(select(JobORM.provenance).where(JobORM.id == job_id))
    except Exception:  # noqa: BLE001 — attribution is best-effort; the job runs either way
        logger.warning("job %s: its provenance could not be read; it runs unattributed", job_id,
                       exc_info=True)
        return None
    return saved if isinstance(saved, dict) else None


def actor_kind_sql(kind_col, actor_col):
    """``commits.actor_kind``, or for a commit from before it was recorded, what :func:`actor_kind`
    says of its ``actor`` — the same rule, in SQL."""
    derived = case(
        (actor_col.is_(None), literal(SYSTEM)),
        (actor_col == SYSTEM, literal(SYSTEM)),
        (actor_col.startswith(_SYSTEM_PREFIX, autoescape=True), literal(SYSTEM)),
        (actor_col.startswith("svc_", autoescape=True), literal(SERVICE)),
        (actor_col.startswith(_SERVICE_PRINCIPAL_PREFIX, autoescape=True), literal(SERVICE)),
        else_=literal(HUMAN),
    )
    return func.coalesce(kind_col, derived)


def is_automation_sql(kind_col, actor_col, key_col):
    """A commit automation made (see the module docstring), in SQL."""
    return or_(actor_kind_sql(kind_col, actor_col).in_((SERVICE, SYSTEM)), key_col.isnot(None))


def is_people_sql(kind_col, actor_col, key_col):
    """A commit a person made by hand: neither automation's nor through any API key."""
    return and_(actor_kind_sql(kind_col, actor_col) == HUMAN, key_col.is_(None))


def is_automation(kind: Optional[str], actor: Optional[str], api_key_id: Optional[str]) -> bool:
    """:func:`is_automation_sql`, on values already read."""
    return (kind or actor_kind(actor)) in (SERVICE, SYSTEM) or bool(api_key_id)
