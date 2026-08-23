"""RevocationService — Redis-backed session revocation.

The global half of a session's permission claims rides in the JWT, so it
is valid for the duration of the access token. To make forced revocation
(suspend user, remove from group, drop binding) take effect sooner than
that, every session is tagged with a random ``sid`` claim and we maintain
a Redis SET of revoked sids. The ``requires(...)`` dependency checks the
set on every request and force-logs-out any session whose sid is present.

Keys live under ``rbac:revoked:<sid>`` and self-expire via Redis TTL,
so no cron is required.

The same ``sid`` also keys the session's **workspace** grants, which are
unbounded in tenant size and so cannot travel in a cookie at all. They
are a separate key read in the same pipelined round trip as the tombstone
— see ``read_session`` — which is what makes them free rather than a
second per-request lookup.

This module hides the Redis client behind a class so tests can swap in
an in-memory fake. Production code goes through the singleton
constructed by ``get_revocation_service()``.

Phase 1 ships this service alongside the migration but does NOT wire
it into endpoints — Phase 2 turns it on per area.
"""
from __future__ import annotations

import json
import logging
import time
import os
from dataclasses import dataclass
from typing import Iterable, Optional, Protocol

from backend.auth_service.core.config import (
    CLOCK_SKEW_LEEWAY_SECONDS,
    JWT_EXPIRY_MINUTES,
    JWT_REFRESH_EXPIRY_DAYS,
)

logger = logging.getLogger(__name__)


# ── Configuration ────────────────────────────────────────────────────

# Access-token TTL drives how long a revocation entry needs to live —
# we keep it for as long as a token can still be accepted, plus a buffer
# so a request that arrives at the very end of that window still finds
# the entry.
#
# DERIVED, not configured alongside it. These two were independent
# numbers and they drifted: the 360s default was sized for the 5-minute
# access TTL in code, while every shipped .env set 60 minutes and the
# k8s configmap set 15. At 60 minutes the tombstone expired 54 minutes
# before the token did, so revoking someone's access — suspending a
# user, dropping a binding — silently stopped working for the tail of
# every token. Deriving it means the invariant cannot be broken by
# changing one file.
#
# The clock-skew leeway is part of that derivation, not decoration: a
# token verifies for ``leeway`` seconds past its own ``exp``, so a
# tombstone sized to ``exp`` alone expires while the token it is meant
# to kill is still being honoured — reopening the exact gap above, but
# only for the last minute of each token and only on a pod whose clock
# is behind. Sizing it here is what keeps that from being something
# anyone has to notice.
_REVOCATION_TTL_BUFFER_SECONDS = 60
_DEFAULT_REVOCATION_TTL_SECONDS = (
    JWT_EXPIRY_MINUTES * 60
    + CLOCK_SKEW_LEEWAY_SECONDS
    + _REVOCATION_TTL_BUFFER_SECONDS
)
REVOCATION_TTL_SECONDS: int = int(
    os.getenv("RBAC_REVOCATION_TTL_SECONDS", str(_DEFAULT_REVOCATION_TTL_SECONDS))
)

# How long a session's stored claim payload lives. Sized to the REFRESH
# lifetime, not the access lifetime, and the distinction matters: one
# session rotates through many access tokens, so an entry that expired
# with the first of them would leave a still-valid session unable to
# resolve its own workspace grants partway through — presenting to the
# user as permissions vanishing for no reason. A day of margin covers the
# rotation that extends a family right at the boundary.
SESSION_CLAIMS_TTL_SECONDS: int = (
    JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 + 24 * 60 * 60
)

# ``is_revoked`` runs on EVERY authenticated request and on the 60s
# ``/me/permissions`` poll, so a slow or unreachable Redis here must fail
# FAST (fail-open, honouring the JWT) rather than hang the request until the
# 30s middleware deadline — which is what forces a user logout on refresh.
# Keep both the connect and per-command budgets tight and env-tunable.
_DEFAULT_REVOCATION_SOCKET_TIMEOUT_S = 2.0
REVOCATION_SOCKET_TIMEOUT_S: float = float(
    os.getenv(
        "RBAC_REVOCATION_SOCKET_TIMEOUT_S",
        str(_DEFAULT_REVOCATION_SOCKET_TIMEOUT_S),
    )
)

_KEY_PREFIX = "rbac:revoked:"
_USER_SIDS_PREFIX = "rbac:user_sids:"
# Per-session claim payload: the per-workspace grants that are too large
# to keep in the access cookie. Deliberately a DIFFERENT key from the
# revocation tombstone above, because there the *existence* of the key is
# the signal — storing a payload under it would make "revoked" and
# "has claims" indistinguishable. The two are read together in a single
# pipelined round trip; see ``read_session``.
_SESSION_CLAIMS_PREFIX = "rbac:sess:"


def _key(sid: str) -> str:
    return f"{_KEY_PREFIX}{sid}"


def _user_sids_key(user_id: str) -> str:
    return f"{_USER_SIDS_PREFIX}{user_id}"


def _session_claims_key(sid: str) -> str:
    return f"{_SESSION_CLAIMS_PREFIX}{sid}"


# ── Backend protocol (so tests can swap in a fake) ───────────────────

class RevocationBackend(Protocol):
    async def exists(self, key: str) -> bool: ...
    async def set_with_ttl(self, key: str, ttl_seconds: int) -> None: ...
    async def delete(self, key: str) -> None: ...
    # user → sids reverse index (a set keyed by user, whole-key TTL).
    async def add_to_set(self, key: str, member: str, ttl_seconds: int) -> None: ...
    async def set_members(self, key: str) -> set[str]: ...
    async def health(self) -> bool: ...
    # Session claim payload.
    async def set_value(self, key: str, value: str, ttl_seconds: int) -> None: ...
    async def set_if_absent(self, key: str, ttl_seconds: int) -> bool: ...
    # Existence of *flag_key* and the value at *value_key*, fetched
    # together. One method rather than two calls because this pair is read
    # on every authenticated request: separately it is two round trips, and
    # pipelined it is one.
    async def exists_and_get(
        self, flag_key: str, value_key: str,
    ) -> tuple[bool, Optional[str]]: ...


# ── Real Redis backend ────────────────────────────────────────────────

class RedisBackend:
    """Thin wrapper around redis.asyncio so the surface stays small.

    We hold one client per process. Connection errors are caught and
    re-raised as ``RevocationBackendError`` so the caller can decide on
    the fail-open / fail-closed policy.
    """
    def __init__(self, client):
        """Takes an already-built client from the central factory.

        It used to build its own ``from_url(REDIS_URL)``, which ignored
        REDIS_USERNAME / REDIS_PASSWORD / REDIS_TLS_* — so turning on AUTH
        authenticated the bus and silently broke revocation, which runs on every
        authenticated request. Never construct a Redis client here.
        """
        self._client = client

    async def exists(self, key: str) -> bool:
        try:
            return bool(await self._client.exists(key))
        except Exception as exc:  # broad on purpose — Redis errors → backend error
            raise RevocationBackendError(str(exc)) from exc

    async def set_with_ttl(self, key: str, ttl_seconds: int) -> None:
        try:
            await self._client.set(key, "1", ex=ttl_seconds)
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def set_if_absent(self, key: str, ttl_seconds: int) -> bool:
        """Claim ``key`` if nobody holds it. True when this caller won.

        ``NX`` matters: a read-then-write would let two concurrent
        replays of one assertion both observe "absent" and both proceed,
        which is exactly the race a replay defence exists to lose
        safely. Redis decides it in one round trip.
        """
        try:
            return bool(await self._client.set(
                key, "1", ex=max(ttl_seconds, 1), nx=True,
            ))
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def delete(self, key: str) -> None:
        try:
            await self._client.delete(key)
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def add_to_set(self, key: str, member: str, ttl_seconds: int) -> None:
        try:
            await self._client.sadd(key, member)
            # Refresh the whole-key TTL on every add so an active user's
            # index outlives their most recent session by the buffer.
            await self._client.expire(key, ttl_seconds)
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def set_members(self, key: str) -> set[str]:
        try:
            return set(await self._client.smembers(key))
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def set_value(self, key: str, value: str, ttl_seconds: int) -> None:
        try:
            await self._client.set(key, value, ex=ttl_seconds)
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def exists_and_get(
        self, flag_key: str, value_key: str,
    ) -> tuple[bool, Optional[str]]:
        """Both reads in one round trip.

        ``transaction=False`` — this is a pipeline for batching, not for
        atomicity. MULTI/EXEC would add nothing: the two keys are written
        at different times by different code paths, so there is no
        invariant between them to preserve, and on a Redis Cluster a
        transaction spanning two keys that may hash to different slots is
        rejected outright.
        """
        try:
            async with self._client.pipeline(transaction=False) as pipe:
                pipe.exists(flag_key)
                pipe.get(value_key)
                flag, value = await pipe.execute()
            if isinstance(value, bytes):
                value = value.decode("utf-8")
            return bool(flag), value
        except Exception as exc:
            raise RevocationBackendError(str(exc)) from exc

    async def health(self) -> bool:
        try:
            return bool(await self._client.ping())
        except Exception:
            return False


class InMemoryBackend:
    """Fallback used in tests and local dev when Redis is not reachable.

    Not safe across processes; do not use in production. The service
    initialiser logs a loud warning when this backend is selected.
    """
    def __init__(self) -> None:
        self._set: set[str] = set()
        self._sets: dict[str, set[str]] = {}
        self._values: dict[str, str] = {}

    async def exists(self, key: str) -> bool:
        return key in self._set

    async def set_value(self, key: str, value: str, ttl_seconds: int) -> None:
        # TTL ignored in the fake, as with ``set_with_ttl``.
        self._values[key] = value

    async def exists_and_get(
        self, flag_key: str, value_key: str,
    ) -> tuple[bool, Optional[str]]:
        return flag_key in self._set, self._values.get(value_key)

    async def set_with_ttl(self, key: str, ttl_seconds: int) -> None:
        # TTL is ignored in the fake; tests that need expiry should
        # call ``delete`` explicitly.
        self._set.add(key)

    async def set_if_absent(self, key: str, ttl_seconds: int) -> bool:
        # TTL ignored, as above. Single-process, so no race to lose.
        if key in self._set:
            return False
        self._set.add(key)
        return True

    async def delete(self, key: str) -> None:
        self._set.discard(key)
        self._sets.pop(key, None)
        self._values.pop(key, None)

    async def add_to_set(self, key: str, member: str, ttl_seconds: int) -> None:
        # TTL ignored in the fake (see set_with_ttl).
        self._sets.setdefault(key, set()).add(member)

    async def set_members(self, key: str) -> set[str]:
        return set(self._sets.get(key, ()))

    async def health(self) -> bool:
        return True


class RevocationBackendError(Exception):
    """Raised when the Redis backend rejects an operation. Callers
    decide fail-open vs fail-closed based on the operation context."""


@dataclass(frozen=True)
class SessionState:
    """What the store knows about one session.

    ``claims is None`` covers three different situations that the read
    path treats identically — no entry was ever written (a token minted
    before the split), the entry expired, or the payload was unreadable.
    All three mean "this store cannot answer", and all three resolve the
    same way: ask the database. Never "the user has no grants".
    """
    revoked: bool
    claims: Optional[dict]


# ── Service ──────────────────────────────────────────────────────────

class RevocationService:
    """Owns the Redis client and exposes the per-event helpers used by
    higher-level code (``users.suspend``, ``binding.create``, etc.).

    Phase 1 includes the helpers but their callers (the user / group /
    binding endpoints) start invoking them in Phase 2. Shipping the
    helpers now means the backend exists and is unit-tested by the time
    Phase 2 wires them.
    """
    def __init__(
        self,
        backend: RevocationBackend,
        *,
        ttl_seconds: int = REVOCATION_TTL_SECONDS,
    ):
        self._backend = backend
        self._ttl = ttl_seconds

    # Used by ``requires()`` per request.
    async def is_revoked(self, sid: str) -> bool:
        if not sid:
            return False
        return await self._backend.exists(_key(sid))

    # Granular revocation: caller knows the exact sid.
    async def revoke_session(self, sid: str) -> None:
        if not sid:
            return
        await self._backend.set_with_ttl(_key(sid), self._ttl)

    async def revoke_sessions(self, sids: Iterable[str]) -> None:
        for sid in sids:
            await self.revoke_session(sid)

    # Session tracking: every login/refresh mints a fresh sid; record
    # it under the user's reverse index so a later coarse revocation
    # can find every live session for that user. The set carries a
    # whole-key TTL (refreshed on each add) equal to the revocation
    # window, so stale sids self-expire — a revoked sid whose access
    # token has already lapsed is a harmless no-op anyway.
    async def record_session(
        self,
        user_id: str,
        sid: str,
        *,
        claims: Optional[dict] = None,
        claims_ttl_seconds: Optional[int] = None,
    ) -> None:
        if not user_id or not sid:
            return
        await self._backend.add_to_set(
            _user_sids_key(user_id), sid, self._ttl
        )
        if claims is None:
            return
        # The claim payload outlives the revocation window on purpose.
        # ``self._ttl`` is sized to the access token, but this entry has to
        # serve every access token in the refresh family — otherwise a
        # session that keeps rotating loses its workspace grants partway
        # through its own lifetime, which reads to the user as permissions
        # evaporating for no reason.
        await self._backend.set_value(
            _session_claims_key(sid),
            json.dumps(claims, separators=(",", ":")),
            claims_ttl_seconds or SESSION_CLAIMS_TTL_SECONDS,
        )

    async def read_session(self, sid: str) -> "SessionState":
        """Revocation status and stored claims, in one round trip.

        Read on every authenticated request, which is why it is one call:
        the tombstone check was already happening here, so folding the
        claim fetch into the same pipeline makes the claims free rather
        than doubling the per-request Redis cost.

        Raises ``RevocationBackendError`` on a backend failure — the
        caller owns the fail-open/fail-closed decision, and for claims
        that decision is "fall back to the database", never "assume the
        user has nothing".
        """
        if not sid:
            return SessionState(revoked=False, claims=None)
        revoked, raw = await self._backend.exists_and_get(
            _key(sid), _session_claims_key(sid),
        )
        if raw is None:
            return SessionState(revoked=revoked, claims=None)
        try:
            return SessionState(revoked=revoked, claims=json.loads(raw))
        except (ValueError, TypeError):
            # Corrupt payload is indistinguishable from absent: both mean
            # "cannot serve claims from here", and the caller's database
            # fallback handles it. Swallowing it silently would not —
            # hence the warning.
            logger.warning(
                "Session claim payload for sid=%s is not valid JSON; "
                "falling back to the database", sid,
            )
            return SessionState(revoked=revoked, claims=None)

    # Coarse revocation: caller knows the user but not their sids.
    # Reads the reverse index, revokes every sid in it, then drops the
    # index so a re-login starts a clean set.
    async def revoke_all_user_sessions(self, user_id: str) -> None:
        if not user_id:
            return
        key = _user_sids_key(user_id)
        sids = await self._backend.set_members(key)
        for sid in sids:
            await self.revoke_session(sid)
        await self._backend.delete(key)
        logger.info(
            "revoke_all_user_sessions: user=%s revoked %d session(s)",
            user_id, len(sids),
        )

    async def health(self) -> bool:
        return await self._backend.health()


# ── Binding-mutation fan-out helpers ────────────────────────────────
#
# Phase 7: when an admin demotes a user or revokes a binding, the
# resolver's read path catches the change at next login. Until then,
# the user's existing JWT carries the old claims for up to
# ``JWT_EXPIRY_MINUTES``. For enterprise security postures this is
# too slow — a fired employee retains workspace access for 5 minutes
# after their offboarding ticket completes.
#
# The helpers below convert a binding-shape change into the right
# ``revoke_*_user_sessions`` calls. Wrapped in try/except so a Redis
# outage never blocks the API mutation (the JWT expiry is still the
# safety net).


async def _emit_session_revoked(
    session, *, user_id: str, reason: str, sessions_killed: int = 1,
) -> None:
    """Phase 9: emit one ``user.session_revoked`` outbox event per
    user whose sessions we killed. Best-effort — a failure here must
    never block the binding mutation that triggered the revocation.
    The caller passes ``reason`` so the audit log shows WHY (the
    Phase-7 revoke helpers fan out from multiple call sites).
    """
    if session is None:
        return
    try:
        from backend.app.db.repositories import user_repo
        await user_repo.create_outbox_event(
            session,
            event_type="user.session_revoked",
            payload={
                "user_id": user_id,
                "reason": reason,
                "sessions_killed": sessions_killed,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "_emit_session_revoked(user=%s reason=%s) failed: %s",
            user_id, reason, exc,
        )


async def revoke_subject_sessions(
    subject_type: str,
    subject_id: str,
    *,
    expand_groups: bool = True,
    session=None,
    reason: str = "unspecified",
) -> int:
    """Revoke every live session belonging to a binding subject.

    For ``subject_type='user'`` the call is direct. For
    ``subject_type='group'`` we expand to every group member (so a
    group-binding revoke fans out across the membership).

    Returns the number of users whose sessions were revoked.
    Best-effort: a Redis failure or an empty session index returns 0
    silently — the JWT TTL is still the floor on staleness.

    Phase 9: ``reason`` is propagated to a ``user.session_revoked``
    outbox event per affected user so the audit log explains WHY
    each kill happened (binding revoked, role changed, etc.).
    """
    svc = get_revocation_service()
    if subject_type == "user":
        try:
            await svc.revoke_all_user_sessions(subject_id)
            await _emit_session_revoked(
                session, user_id=subject_id, reason=reason,
            )
            return 1
        except Exception as exc:  # noqa: BLE001 — best-effort by design
            logger.warning(
                "revoke_subject_sessions(user=%s) failed: %s", subject_id, exc,
            )
            return 0

    if subject_type == "group" and expand_groups:
        if session is None:
            logger.warning(
                "revoke_subject_sessions(group=%s): no DB session "
                "passed; skipping membership expansion. JWT TTL is "
                "the only floor on staleness.",
                subject_id,
            )
            return 0
        from backend.app.db.repositories import group_repo
        try:
            members = await group_repo.list_group_members(session, subject_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "revoke_subject_sessions(group=%s) membership lookup "
                "failed: %s", subject_id, exc,
            )
            return 0
        count = 0
        for m in members:
            try:
                await svc.revoke_all_user_sessions(m.user_id)
                await _emit_session_revoked(
                    session, user_id=m.user_id, reason=reason,
                )
                count += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "revoke_subject_sessions(group=%s, member=%s) failed: %s",
                    subject_id, m.user_id, exc,
                )
        return count

    return 0


#: Assertion-id keyspace. Separate prefix from the revocation keys so a
#: flush of one never takes the other with it.
_SAML_ASSERTION_PREFIX = "saml:asid:"


class SharedSamlReplayCache:
    """One-time-use enforcement for SAML assertion ids, shared fleet-wide.

    ``SamlProvider`` has always called a replay cache — it just never got
    a real one. ``build_saml_provider`` did not accept the argument, so
    every provider fell back to a process-local dict, and the registry
    rebuilds that provider every 60 s. The result looked like replay
    protection in code review and in the docs, and enforced nothing: a
    captured ``SAMLResponse`` re-POSTed inside its ``NotOnOrAfter``
    window minted a session as the victim on any of the 4N workers that
    had not seen it, or on the same worker a minute later.

    Backed by the revocation store rather than a second Redis client:
    it is the same shared, already-configured, already-monitored
    keyspace that session tombstones use.

    A store failure raises. That is deliberate and it is the one place
    in this module that does not degrade: everything else here fails
    open because the JWT TTL is still a floor, whereas "we could not
    check for a replay" has no floor under it at all — it is the whole
    control. The ACS turns the exception into a rejected sign-in.
    """

    def __init__(self, backend: RevocationBackend):
        self._backend = backend

    async def record(self, assertion_id: str, expires_at_epoch: int) -> bool:
        """True if this assertion is new; False if it has been seen.

        TTL is the assertion's own remaining validity — once it is past
        ``NotOnOrAfter`` the signature check refuses it anyway, so
        holding the key longer buys nothing and costs memory.
        """
        ttl = max(int(expires_at_epoch) - int(time.time()), 1)
        return await self._backend.set_if_absent(
            f"{_SAML_ASSERTION_PREFIX}{assertion_id}", ttl,
        )


def get_saml_replay_cache() -> Optional["SharedSamlReplayCache"]:
    """A fleet-wide replay cache, or ``None`` when there isn't one.

    ``None`` means the revocation service fell back to its in-process
    backend, so nothing here can be shared between workers. Callers must
    treat that as a configuration failure in production rather than
    substituting the local dict — see ``app/main.py``.
    """
    backend = getattr(get_revocation_service(), "_backend", None)
    if backend is None or isinstance(backend, InMemoryBackend):
        return None
    return SharedSamlReplayCache(backend)


async def revoke_every_session_for_user(
    user_id: str,
    *,
    session,
    reason: str,
) -> None:
    """End every session a user holds, durably. Both halves, always.

    ``revoke_subject_sessions`` tombstones the ``sid``s that are live
    right now, and those tombstones expire with the access token they
    guard. ``revoke_sessions_from_now`` stamps the cutoff that stops the
    next rotation minting a fresh, untombstoned session, and it only
    bites at that rotation. Either alone leaves a window: the first lets
    a refresh walk straight back in, the second leaves the current
    access token working until it expires.

    They were being called as a pair in one place and not at all in
    three others — the password-reset paths among them, which is the
    worst of the set. A user resetting a password after a compromise is
    performing the remediation; leaving the attacker's session alive
    through it defeats the point. This exists so the pair cannot be
    half-remembered again.

    Cookie clearing is deliberately NOT here. It only makes sense when
    the subject is the caller, and reaching for it on an admin action
    would sign the *admin* out. The caller-facing wrapper in
    ``users.py`` adds it.
    """
    from backend.app.db.repositories import user_repo

    await user_repo.revoke_sessions_from_now(session, user_id)
    await revoke_subject_sessions("user", user_id, session=session, reason=reason)


async def revoke_role_sessions(
    role_name: str, *, session, reason: str = "role_changed",
) -> int:
    """Revoke sessions for every user touched by a role-shape change.

    Used by ``PUT /admin/roles/{name}`` (the role's permission bundle
    changed) and ``DELETE`` (cascading after individual bindings are
    removed). Walks every binding that references the role, expands
    group bindings to their members, and dedupes per user.

    Best-effort throughout. Returns the count of distinct users
    revoked so the caller can audit-log the blast radius.

    Phase 9: emits one ``user.session_revoked`` event per affected
    user (with ``reason``) so the audit log captures the cascade.
    """
    from sqlalchemy import select
    from backend.app.db.models import RoleBindingORM
    from backend.app.db.repositories import group_repo

    try:
        rows = (await session.execute(
            select(RoleBindingORM).where(RoleBindingORM.role_name == role_name)
        )).scalars().all()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "revoke_role_sessions(%s) lookup failed: %s", role_name, exc,
        )
        return 0

    user_ids: set[str] = set()
    for b in rows:
        if b.subject_type == "user":
            user_ids.add(b.subject_id)
        elif b.subject_type == "group":
            try:
                members = await group_repo.list_group_members(
                    session, b.subject_id,
                )
            except Exception:  # noqa: BLE001
                continue
            for m in members:
                user_ids.add(m.user_id)

    svc = get_revocation_service()
    count = 0
    for uid in user_ids:
        try:
            await svc.revoke_all_user_sessions(uid)
            await _emit_session_revoked(session, user_id=uid, reason=reason)
            count += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "revoke_role_sessions(%s, user=%s) failed: %s",
                role_name, uid, exc,
            )
    return count


# ── Singleton wiring ──────────────────────────────────────────────────

_INSTANCE: Optional[RevocationService] = None


def build_revocation_backend() -> "RedisBackend":
    """Revocation rides the STREAMS endpoint — the same coordination Redis as the
    bus, with the same credentials and TLS, resolved centrally."""
    import dataclasses

    from backend.common.adapters.redis_endpoint import (
        RedisRole, build_redis_client, resolve_redis_config,
    )

    cfg = resolve_redis_config(RedisRole.STREAMS)
    # Revocation is on the hot auth path: keep its short fail-open budget.
    cfg = dataclasses.replace(
        cfg,
        socket_timeout=REVOCATION_SOCKET_TIMEOUT_S,
        socket_connect_timeout=REVOCATION_SOCKET_TIMEOUT_S,
        # STREAMS defaults retry_on_timeout=True (correct for the message
        # bus — one automatic reconnect+resend after a transient blip).
        # Revocation must fail open FAST: both timeouts above are already
        # the tight fail-open budget, and a retry would silently spend
        # that budget twice on every authenticated request during a
        # Redis blip. Always off here, regardless of the STREAMS default
        # or any REDIS_STREAMS_RETRY_ON_TIMEOUT override.
        retry_on_timeout=False,
    )
    return RedisBackend(build_redis_client(cfg))


def get_revocation_service() -> RevocationService:
    """Return the process-singleton service.

    Falls back to ``InMemoryBackend`` (with a warning) if Redis cannot
    be constructed at import time — this keeps unit tests and local
    dev usable without a running Redis.

    This runs on EVERY authenticated request. If backend construction
    raised past this function, ``_INSTANCE`` would stay ``None`` and
    the same exception would fire again on every subsequent call — a
    config typo or a mid-rotation secret-mount race would turn into a
    total, unrecoverable auth outage instead of the fail-open
    degradation this service exists to provide. So every failure mode
    below falls back to ``InMemoryBackend``, logged loudly (never the
    secret value) rather than swallowed silently.
    """
    global _INSTANCE
    if _INSTANCE is None:
        from backend.common.adapters.redis_endpoint import RedisConfigurationError

        try:
            backend: RevocationBackend = build_revocation_backend()
        except ImportError:
            logger.warning(
                "redis library not available — using InMemoryBackend. "
                "RBAC revocation will not survive process restarts."
            )
            backend = InMemoryBackend()
        except RedisConfigurationError as exc:
            # e.g. a missing/empty *_PASSWORD_FILE during a secret-mount
            # race, an incomplete sentinel config, or a stray cluster
            # var. resolve_redis_config's error strings never include
            # the secret value itself (only file paths / var names), so
            # this is safe to log verbatim.
            logger.error(
                "Revocation Redis config invalid (role=streams): %s — "
                "falling back to InMemoryBackend. RBAC revocation will "
                "not survive process restarts or be shared across "
                "replicas until this is fixed.",
                exc,
            )
            backend = InMemoryBackend()
        except Exception as exc:  # noqa: BLE001 — hot auth path: any other
            # construction failure (bad int/float env cast, TLS/client
            # kwarg error, ...) has the same catastrophic shape as the
            # two cases above, so it gets the same fail-open treatment
            # rather than escaping as an unhandled 500.
            logger.error(
                "Unexpected error building revocation Redis backend "
                "(role=streams): %s: %s — falling back to InMemoryBackend. "
                "RBAC revocation will not survive process restarts or be "
                "shared across replicas until this is fixed.",
                type(exc).__name__, exc,
            )
            backend = InMemoryBackend()
        _INSTANCE = RevocationService(backend)
    return _INSTANCE


def configure_revocation_service(service: RevocationService) -> None:
    """Test-only: install a custom service instance.

    Production code must not call this — it bypasses the URL and TTL
    config. Used by the test suite to install a fake-backed service.
    """
    global _INSTANCE
    _INSTANCE = service


__all__ = [
    "RevocationService",
    "RevocationBackend",
    "RedisBackend",
    "InMemoryBackend",
    "RevocationBackendError",
    "get_revocation_service",
    "build_revocation_backend",
    "configure_revocation_service",
    "REVOCATION_TTL_SECONDS",
]
