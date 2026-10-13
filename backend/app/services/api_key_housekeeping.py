"""Expiry reminders for API keys.

A key that expires unannounced breaks whatever depends on it — often at
night, often for someone who has forgotten the key exists. So its owner hears
about it a week ahead, once: in their inbox, and as an audit event. A key
made to live a week or less was made knowing it would, and gets no reminder.

The reminder follows the key's own expiry. A deployment's maximum lifetime,
lowered after a key was made, takes effect at once and is the admin's to
announce.

Runs on the CONTROLPLANE/DEV role only, like the other sweepers, and claims
an advisory lock per pass so two processes never send the same reminder.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.repositories import (
    api_key_repo,
    api_key_usage_repo,
    notification_repo,
    outbox_event_repo,
)

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
    for key in keys:
        created = _instant(key.created_at)
        expires = _instant(key.expires_at)
        if created is None or expires is None or expires - created <= REMIND_AHEAD:
            continue
        await notification_repo.notify(
            session,
            user_ids=[key.user_id],
            kind="api_key_expiring",
            title="An API key expires in less than a week",
            body=(
                f"“{key.name}” ({key.token_prefix}…) stops working on "
                f"{expires.date().isoformat()}. Rotate it to keep whatever uses it working."
            ),
            link="/me/api-keys",
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


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop until ``shutdown`` is set: remind owners of keys about
    to expire, and drop usage counts past their retention. A failed pass is
    logged and retried on the next tick."""
    logger.info("API key housekeeping started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            async with session_factory() as session:
                if await claim_this_pass(session, "auth:api-key-housekeeping"):
                    reminded = await remind_once(session)
                    if reminded:
                        logger.info("Sent %d API key expiry reminder(s)", reminded)
                    await api_key_usage_repo.prune(session)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("API key housekeeping failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # a whole interval with no shutdown: time for the next pass

    logger.info("API key housekeeping stopped")
