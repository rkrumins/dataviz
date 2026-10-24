"""Whether each service account still has someone answering for it.

A service account's keys work while it has a manager in good standing, and
for a grace period after its last one goes (``serviceAccountUnmanagedGrace``),
so an integration keeps running while someone appoints a successor. When an
account loses its last manager, every super and org admin is told at once,
and again three days before its keys pause.

``refresh`` is called by every route that changes who manages an account, and
``sweep`` once an hour by the API key housekeeping loop, for what changes with
time alone: a manager's sign-in window lapsing, a team's membership synced from
the identity provider.

``key_audience`` says who hears about a key — misuse, its expiry, someone else
revoking it: its owner, or for a service account's key the people who can act
for the account.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import (
    app_auth_config_repo,
    binding_repo,
    notification_repo,
    service_account_repo,
    user_repo,
)
from backend.app.services.feature_flags import feature_flags
from backend.common.service_accounts import DEFAULT_GRACE_DAYS, grace_days, is_service_account

#: How far ahead of its keys pausing the administrators are reminded.
REMIND_AHEAD = timedelta(days=3)
#: Past this many accounts at once — a sign-in window shortened, someone who
#: managed many suspended — the administrators get one notice, not one each.
DIGEST_OVER = 5
#: The switches a key request reads (``api_key_auth._policy``), read here by
#: name: the control plane runs the sweep and must not import the request path.
_SSO_WINDOW_FLAG = "apiKeySsoSignInWindow"
_GRACE_FLAG = "serviceAccountUnmanagedGrace"


@dataclass(frozen=True)
class Policy:
    window_days: Optional[int]
    passwords_allowed: bool
    grace_days: int


def _window_days(value) -> Optional[int]:
    """The sign-in window switch as days, as ``api_key_auth._days`` reads it:
    anything that is not a positive number is no window."""
    try:
        days = int(str(value))
    except (TypeError, ValueError):
        return None
    return days if days > 0 else None


def _admin_link(account_id: str) -> str:
    """The administrators' Service accounts page, opened on the account."""
    return f"/admin/service-accounts?account={account_id}"


async def policy(session: AsyncSession) -> Policy:
    """The rules standing is judged by — the ones a key request reads."""
    values = await feature_flags.get_all(session)
    posture = await app_auth_config_repo.get_snapshot(session)
    return Policy(
        window_days=_window_days(values.get(_SSO_WINDOW_FLAG, "30")),
        passwords_allowed=posture.allow_local_login,
        grace_days=grace_days(values.get(_GRACE_FLAG, str(DEFAULT_GRACE_DAYS))),
    )


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def refresh(
    session: AsyncSession,
    account_ids: Optional[Iterable[str]] = None,
    *,
    now: Optional[datetime] = None,
    rules: Optional[Policy] = None,
) -> list[str]:
    """Bring these accounts' standing (or every one's) up to date, and tell
    the administrators about any that just lost their last manager. Returns
    those accounts."""
    now = now or datetime.now(timezone.utc)
    rules = rules or await policy(session)
    lost = await service_account_repo.refresh_standing(
        session, now=now, window_days=rules.window_days,
        passwords_allowed=rules.passwords_allowed, account_ids=account_ids,
    )
    accounts = await service_account_repo.unmanaged_accounts(session, lost)
    if len(accounts) > DIGEST_OVER:
        pauses = now + timedelta(days=rules.grace_days)
        await notification_repo.notify(
            session, user_ids=await binding_repo.platform_admin_user_ids(session),
            kind="service_account_unmanaged",
            title=f"{len(accounts)} service accounts have no manager left",
            body=(
                f"Nobody who manages {_some(accounts)} can act for them any more. "
                + (
                    f"Their keys keep working until {pauses.date().isoformat()}; appoint managers "
                    "to keep them working." if rules.grace_days > 0
                    else "Their keys are paused until each has a manager again."
                )
            ),
            link="/admin/service-accounts", resource_type="service_account",
        )
    elif accounts:
        admins = await binding_repo.platform_admin_user_ids(session)
        for account in accounts:
            if rules.grace_days > 0:
                pauses = _instant(account.unmanaged_since) + timedelta(days=rules.grace_days)
                body = (
                    f"Nobody who manages “{account.name}” can act for it any more. Its keys keep "
                    f"working until {pauses.date().isoformat()}; appoint a manager to keep them "
                    "working."
                )
            else:
                body = (
                    f"Nobody who manages “{account.name}” can act for it any more, so its keys "
                    "are paused. Appoint a manager and they work again at once."
                )
            await notification_repo.notify(
                session, user_ids=admins, kind="service_account_unmanaged",
                title="A service account has no manager left", body=body, link=_admin_link(account.id),
                resource_type="service_account", resource_id=account.id, dedupe_unread=True,
            )
    return lost


def _some(accounts) -> str:
    """A few accounts by name, and how many more."""
    named = ", ".join(f"“{a.name}”" for a in accounts[:3])
    return named if len(accounts) <= 3 else f"{named} and {len(accounts) - 3} more"


async def remind_pausing(
    session: AsyncSession, *, now: Optional[datetime] = None, rules: Optional[Policy] = None,
) -> int:
    """Remind the administrators of accounts whose keys pause within three
    days for want of a manager — or, the grace period shortened, have paused
    already — once as that time draws near. Returns how many."""
    now = now or datetime.now(timezone.utc)
    rules = rules or await policy(session)
    due = await service_account_repo.due_pause_reminder(
        session, now=now, grace_days=rules.grace_days, ahead=REMIND_AHEAD,
    )
    if not due:
        return 0
    admins = await binding_repo.platform_admin_user_ids(session)
    if len(due) > DIGEST_OVER:
        await notification_repo.notify(
            session, user_ids=admins, kind="service_account_pausing",
            title=f"{len(due)} service accounts still have no manager",
            body=(
                f"The keys of {_some(due)} stop working {rules.grace_days} days after their last "
                "manager went — within three days, or already. Appoint managers and they work again "
                "at once."
            ),
            link="/admin/service-accounts", resource_type="service_account",
        )
    else:
        for account in due:
            pauses = _instant(account.unmanaged_since) + timedelta(days=rules.grace_days)
            day = pauses.date().isoformat()
            # No unread check: a reminder is due once each time the pause draws
            # near, and a lengthened grace period moves that, so an earlier
            # one still unread says the wrong day.
            await notification_repo.notify(
                session, user_ids=admins, kind="service_account_pausing",
                title=(
                    "A service account's keys pause soon" if pauses > now
                    else "A service account's keys have paused"
                ),
                body=(
                    f"“{account.name}” still has no manager. Its keys stop working on {day} "
                    "unless you appoint one." if pauses > now
                    else f"“{account.name}” still has no manager, so its keys stopped working on "
                    f"{day}. Appoint one and they work again at once."
                ),
                link=_admin_link(account.id), resource_type="service_account", resource_id=account.id,
            )
    await service_account_repo.mark_pause_reminded(session, [a.id for a in due], now=now)
    return len(due)


async def sweep(session: AsyncSession, *, now: Optional[datetime] = None) -> tuple[int, int]:
    """One hourly pass over every account: how many lost their last manager,
    and how many reminders went out."""
    now = now or datetime.now(timezone.utc)
    rules = await policy(session)
    lost = await refresh(session, now=now, rules=rules)
    reminded = await remind_pausing(session, now=now, rules=rules)
    return len(lost), reminded


@dataclass(frozen=True)
class KeyAudience:
    """Who is told about a key, and the page the note sends them to."""
    user_ids: set[str]
    link: str
    #: The service account the key acts as, by name; ``None`` for a person's own.
    account: Optional[str] = None

    @property
    def whose(self) -> str:
        """Whose keys, mid-sentence: "your", or the service account's."""
        return "your" if self.account is None else f"“{self.account}”’s"

    def key(self, key) -> str:
        """A key, opening a sentence."""
        whose = "Your" if self.account is None else self.whose
        return f"{whose} key “{key.name}” ({key.token_prefix}…)"


async def tell_team_grew(
    session: AsyncSession, account_ids: Iterable[str], *, team: str,
    member_id: str, member_name: str, actor_id: Optional[str],
) -> None:
    """Someone joined a team that manages service accounts: they can now make
    keys that act as each. Those who answer for each account hear of it."""
    for account_id in sorted(set(account_ids)):
        audience = await key_audience(session, account_id)
        await notification_repo.notify(
            session, user_ids=audience.user_ids - {member_id},
            kind="service_account_team_joined",
            title=f"{member_name} can now act as “{audience.account}”",
            body=(
                f"They joined {team}, which manages this service account, so they can make keys "
                "that act as it. If that wasn't meant, take them out of the team."
            ),
            link=audience.link, actor_id=actor_id,
            resource_type="service_account", resource_id=account_id,
        )


async def tell_keys_outlive(
    session: AsyncSession, account_ids: Iterable[str], *, person: Optional[str] = None,
    team: Optional[str] = None, actor_id: Optional[str],
) -> None:
    """A person, or a team's members, may have stopped answering for these
    accounts. The keys they made that still work, on an account they can no
    longer act for, may have left with them in a copy: those who answer for
    the account hear of each, to rotate it."""
    wanted = sorted(set(account_ids))
    if not wanted:
        return
    keys = await service_account_repo.live_keys_made(session, by=person, by_team=team, account_ids=wanted)
    if not keys:
        return
    rules = await policy(session)
    still = await service_account_repo.people_who_can_act(
        session, {key.user_id for key in keys}, now=datetime.now(timezone.utc),
        window_days=rules.window_days, passwords_allowed=rules.passwords_allowed,
    )
    left: dict[tuple[str, str], list] = {}
    for key in keys:
        if key.created_by not in still[key.user_id]:
            left.setdefault((key.user_id, key.created_by), []).append(key)
    if not left:
        return
    names = await user_repo.get_identities_by_ids(session, sorted({maker for _account, maker in left}))
    for (account_id, maker), made in sorted(left.items()):
        audience = await key_audience(session, account_id)
        who = (names.get(maker) or {}).get("name") or "Someone"
        them = "it" if len(made) == 1 else "them"
        await notification_repo.notify(
            session, user_ids=audience.user_ids - {maker}, kind="service_account_maker_left",
            title=f"Keys {who} made for “{audience.account}” still work",
            body=(
                f"{who} no longer answers for this service account, and may have kept a copy of "
                + ", ".join(f"“{key.name}” ({key.token_prefix}…)" for key in made)
                + f". Rotate {them}, or revoke {them} if nothing uses {them} any more."
            ),
            link=audience.link, actor_id=actor_id,
            resource_type="service_account", resource_id=account_id,
        )


async def key_audience(
    session: AsyncSession, owner_id: str, *, maker: Optional[str] = None,
) -> KeyAudience:
    """Who hears about a key, or about the account it acts as: a person's own
    key, its owner. A service account's: its direct managers, and whoever
    made the key (``maker``) while they can still act for it; failing those, a
    few members of its managing teams (``service_account_repo.who_answers``);
    and while nobody can act for it, the administrators who appoint them."""
    if not is_service_account(owner_id):
        return KeyAudience({owner_id}, "/me/api-keys")
    found = await service_account_repo.get(session, owner_id)
    name = found[0].first_name if found else owner_id
    rules = await policy(session)
    people = await service_account_repo.who_answers(
        session, owner_id, maker=maker, now=datetime.now(timezone.utc),
        window_days=rules.window_days, passwords_allowed=rules.passwords_allowed,
    )
    if people:
        return KeyAudience(people, f"/me/service-accounts/{owner_id}", name)
    return KeyAudience(await binding_repo.platform_admin_user_ids(session), _admin_link(owner_id), name)
