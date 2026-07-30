"""An in-memory ``RefreshStore`` for tests that are not about rotation.

Allow-by-record means a refresh token is refused unless an active row says
otherwise, so a fake that answers "no row" to everything now *fails* every
rotation. Several tests use a stub store only to get past the bookkeeping
on the way to what they actually check (the SSO provider-slug lookup, the
group reconciler). Those need a store that genuinely stores.

Deliberately not in ``auth_service``: production code should not ship a
test double, and a fake that lives next to the real implementation tends
to get used as one.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from backend.auth_service.refresh import RefreshRecord


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class InMemoryRefreshStore:
    """Dict-backed ``RefreshStore``. Not concurrency-safe; tests are not."""

    def __init__(self) -> None:
        self.records: dict[str, RefreshRecord] = {}
        #: Last family passed to ``revoke_family``, for assertions.
        self.revoked_family: Optional[str] = None
        #: Stand-ins for the pre-inversion denylist — see
        #: ``legacy_revocation``. Empty means "nothing predates this
        #: revision", which is true of every test that does not opt in.
        self.legacy_families: set[str] = set()
        self.legacy_jtis: set[str] = set()

    async def record_mint(
        self,
        *,
        jti: str,
        family_id: str,
        user_id: str,
        auth_time: Optional[int],
        mint_ms: int,
        expires_at_iso: str,
        revoked_at_iso: Optional[str] = None,
    ) -> bool:
        if jti in self.records:
            return False
        self.records[jti] = RefreshRecord(
            jti=jti,
            family_id=family_id,
            user_id=user_id,
            auth_time=auth_time,
            mint_ms=mint_ms,
            expires_at_iso=expires_at_iso,
            created_at_iso=_now_iso(),
            revoked_at_iso=revoked_at_iso,
        )
        return True

    async def get_record(self, jti: str) -> Optional[RefreshRecord]:
        return self.records.get(jti)

    async def consume(self, jti: str, *, successor_jti: str) -> bool:
        record = self.records.get(jti)
        if record is None or not record.is_active:
            return False
        self.records[jti] = RefreshRecord(
            **{
                **record.__dict__,
                "consumed_at_iso": _now_iso(),
                "successor_jti": successor_jti,
            }
        )
        return True

    async def revoke_family(self, family_id: str) -> bool:
        self.revoked_family = family_id
        marked = False
        for jti, record in list(self.records.items()):
            if record.family_id == family_id and record.revoked_at_iso is None:
                self.records[jti] = RefreshRecord(
                    **{**record.__dict__, "revoked_at_iso": _now_iso()}
                )
                marked = True
        return marked

    async def is_family_revoked(self, family_id: str) -> bool:
        return any(
            r.family_id == family_id and r.revoked_at_iso is not None
            for r in self.records.values()
        )

    async def legacy_revocation(
        self, jti: str, family_id: str,
    ) -> Optional[str]:
        """Verdicts from the pre-inversion denylist.

        Empty by default: this double has no legacy table behind it, and
        a test that wants a pre-deploy revocation says so by populating
        ``legacy_families`` / ``legacy_jtis``.
        """
        if family_id in self.legacy_families:
            return "family_revoked"
        if jti in self.legacy_jtis:
            return "reuse"
        return None
