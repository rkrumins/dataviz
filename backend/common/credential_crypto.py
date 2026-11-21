"""Credentials at rest: Fernet under ``CREDENTIAL_ENCRYPTION_KEY`` (ADR-008).

One implementation for every store that keeps a secret in the management
database — graph connections, providers, identity providers
(``backend/app/db/repositories/connection_repo.py`` re-exports these under
their old private names) and the AI service's model connections and knowledge
sources. Kept free of the ORM so a separate process can use it without
importing the web tier's models.

Without a key, secrets fall back to plaintext JSON — in development only:
with ``ENV`` set to production a write refuses instead
(:func:`require_encryption_or_plaintext_ok`). A blob that cannot be decrypted
reads as no credentials at all, never as an error that takes a page down.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

_PROD_ENV_VALUES = {"prod", "production"}

#: What an API shows in place of a stored secret.
REDACTION_MARKER = "********"


class CredentialEncryptionError(RuntimeError):
    """Raised when secrets would be persisted as plaintext in production."""


def require_encryption_or_plaintext_ok() -> None:
    """Fail closed in production: never write a secret in the clear there."""
    if os.getenv("ENV", "dev").strip().lower() in _PROD_ENV_VALUES:
        raise CredentialEncryptionError(
            "CREDENTIAL_ENCRYPTION_KEY is unset but ENV is production — "
            "refusing to store credentials as plaintext. Configure a "
            "Fernet key (CREDENTIAL_ENCRYPTION_KEY) before persisting "
            "secrets."
        )


def get_fernet():
    """A Fernet instance, or None when no key is configured."""
    key = os.getenv("CREDENTIAL_ENCRYPTION_KEY")
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception as e:  # noqa: BLE001
        logger.warning("Credential encryption unavailable: %s", e)
        return None


def encrypt(data: dict) -> str:
    fernet = get_fernet()
    raw = json.dumps(data)
    if fernet:
        return fernet.encrypt(raw.encode()).decode()
    require_encryption_or_plaintext_ok()  # fail closed in prod
    return raw  # plaintext fallback (dev only)


def decrypt(blob: Optional[str]) -> dict:
    if not blob:
        return {}
    fernet = get_fernet()
    try:
        if fernet:
            return json.loads(fernet.decrypt(blob.encode()))
        return json.loads(blob)
    except Exception:  # noqa: BLE001
        return {}
