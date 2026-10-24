"""Expiry reminders for API keys, and the standing of service accounts.

A key that expires unannounced breaks whatever depends on it — often at
night, often for someone who has forgotten the key exists. So its owner hears
about it a week ahead, once: in their inbox, and as an audit event — for a
service account's key, those who answer for the account. A key made to live a
week or less was made knowing it would, and gets no reminder.

The reminder follows the key's own expiry. A deployment's maximum lifetime,
lowered after a key was made, takes effect at once and is the admin's to
announce.

Each pass first checks that every service account still has a manager in
good standing (``service_account_standing.sweep``): a manager's sign-in window
lapses with time alone, with no request to notice it, and that check is what
pauses the account's keys.

Runs on the CONTROLPLANE/DEV role only, like the other sweepers, and claims
an advisory lock for each step of a pass so two processes never send the same
reminder. Each step commits on its own: one that fails is logged and counted
(``api_key_housekeeping_steps_total``), and the others still run.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.jobs.metrics import increment as metrics_increment
from backend.app.db.repositories import (
    api_key_repo,
    api_key_usage_repo,
    notification_repo,
    outbox_event_repo,
)
from backend.app.services import service_account_standing

logger = logging.getLogger(__name__)

REMIND_AHEAD = timedelta(days=7)
_BATCH = 500
# Reminders are a week ahead, so an hour's resolution is more than enough.
_DEFAULT_INTERVAL_SECONDS = 3600.0


def _instant(value: Optional[str]) -> Optional[datetime]:
    """A stored ISO-8601 instant, aware (naive reads as UTC). Parsed here, not
    with the auth service's helper: the control plane starts without it."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def remind_once(session: AsyncSession) -> int:
    """Remind the owners of keys expiring within a week. Every key looked at
    is marked, reminded or not, so each is considered once. Returns how many
    reminders went out."""
    keys = await api_key_repo.due_for_expiry_reminder(
        session, within=REMIND_AHEAD, batch=_BATCH,
    )
    reminded = 0
    # Who answers for a key depends on its account and who made it, not on
    # the key: worked out once for each, however many keys share them.
    audiences: dict[tuple[str, Optional[str]], service_account_standing.KeyAudience] = {}
    for key in keys:
        created = _instant(key.created_at)
        expires = _instant(key.expires_at)
        if created is None or expires is None or expires - created <= REMIND_AHEAD:
            continue
        whose = (key.user_id, key.created_by)
        if whose not in audiences:
            audiences[whose] = await service_account_standing.key_audience(
                session, key.user_id, maker=key.created_by,
            )
        audience = audiences[whose]
        await notification_repo.notify(
            session,
            user_ids=audience.user_ids,
            kind="api_key_expiring",
            title="An API key expires in less than a week",
            body=(
                f"{audience.key(key)} stops working on "
                f"{expires.date().isoformat()}. Rotate it to keep whatever uses it working."
            ),
            link=audience.link,
            resource_type="api_key",
            resource_id=key.id,
            dedupe_unread=True,
        )
        await outbox_event_repo.emit(
            session,
            event_type="identity.api_key.expiring",
            aggregate_type="user",
            aggregate_id=key.user_id,
            payload={
                "user_id": key.user_id,
                "key_id": key.id,
                "key_name": key.name,
                "token_prefix": key.token_prefix,
                "expires_at": key.expires_at,
            },
        )
        reminded += 1
    await api_key_repo.mark_reminded(session, [key.id for key in keys])
    return reminded


async def _service_accounts(session: AsyncSession) -> None:
    lost, reminded = await service_account_standing.sweep(session)
    if lost or reminded:
        logger.info(
            "Service accounts: %d lost their last manager, %d reminded of their keys pausing",
            lost, reminded,
        )


async def _expiry_reminders(session: AsyncSession) -> None:
    reminded = await remind_once(session)
    if reminded:
        logger.info("Sent %d API key expiry reminder(s)", reminded)


#: A pass, most important first: whether a service account still has a
#: manager decides whether its keys work.
_STEPS = (
    ("service_accounts", _service_accounts),
    ("expiry_reminders", _expiry_reminders),
    ("usage_prune", lambda session: api_key_usage_repo.prune(session)),
)


async def _run_step(session_factory, step: str, run) -> bool:
    """One step of a pass, committed on its own. Returns False when another
    process holds the pass. A step that fails is logged and counted, so a
    check that stops working shows, and the next step runs regardless."""
    try:
        async with session_factory() as session:
            if not await claim_this_pass(session, "auth:api-key-housekeeping"):
                return False
            await run(session)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — the other steps, and the loop, carry on
        logger.warning("API key housekeeping: %s failed: %s", step, exc, exc_info=True)
        metrics_increment("api_key_housekeeping_steps_total", step=step, outcome="failed")
        return True
    metrics_increment("api_key_housekeeping_steps_total", step=step, outcome="done")
    return True


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop until ``shutdown`` is set: check that service accounts
    still have managers, remind owners of keys about to expire, and drop
    usage counts past their retention. A failed step is logged and retried on
    the next tick."""
    logger.info("API key housekeeping started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        for step, run in _STEPS:
            if not await _run_step(session_factory, step, run):
                break  # another process is running this pass

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # a whole interval with no shutdown: time for the next pass

    logger.info("API key housekeeping stopped")
