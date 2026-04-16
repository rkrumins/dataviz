"""
Local username+password provider.

Verifies an email/password pair against an Argon2id hash stored on the
``users`` table. Constant-time against the dummy hash so that timing
side-channels can't reveal whether an email exists.
"""
from __future__ import annotations

from typing import Optional

from ..core.password import hash_password, verify_password
from .base import IdentityProvider, ProviderCredentials, ProviderIdentity


# Pre-computed Argon2id hash used for constant-time login responses when
# the user doesn't exist. The plaintext doesn't matter — we just need a
# valid hash so verify_password runs in the same time as a real check.
_DUMMY_HASH = hash_password("__timing_dummy_do_not_use__")


class LocalIdentityProvider:
    name = "local"

    async def authenticate(
        self,
        credentials: ProviderCredentials,
        *,
        get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        if not credentials.email or not credentials.password:
            verify_password(credentials.password or "", _DUMMY_HASH)
            return None

        user = await get_user_by_email(credentials.email)

        if user is None:
            verify_password(credentials.password, _DUMMY_HASH)
            return None

        if not verify_password(credentials.password, user.password_hash):
            return None

        if user.status != "active":
            return None

        return ProviderIdentity(
            provider="local",
            external_id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            raw_claims={},
        )
