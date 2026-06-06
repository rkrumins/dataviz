"""
Argon2id password hashing and verification.

argon2-cffi uses constant-time comparison internally, so verify_password
is safe against timing attacks.

Phase 3 adds a deterministic ``disabled_password_hash()`` sentinel and
the matching ``is_password_set()`` predicate. SSO-only users get the
sentinel hash in ``UserORM.password_hash`` instead of a randomised
Argon2id of a discarded secret — making "does this user have a
password?" a cheap, grep-stable check rather than a probabilistic one.
"""
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

_hasher = PasswordHasher()


# Magic value stored in ``UserORM.password_hash`` for accounts that
# have no password (SSO-only). Chosen so it can never be a valid
# Argon2id hash (which always starts with ``$argon2``), so
# verify_password() against it returns False in constant time AND
# is_password_set() detects it instantly.
_DISABLED_SENTINEL = "x-disabled-password-x"


def hash_password(plain: str) -> str:
    """Return an Argon2id hash of *plain*."""
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches *hashed*, False otherwise."""
    if hashed == _DISABLED_SENTINEL:
        return False
    try:
        return _hasher.verify(hashed, plain)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def disabled_password_hash() -> str:
    """Sentinel hash for SSO-only accounts. See module docstring."""
    return _DISABLED_SENTINEL


def is_password_set(hashed: str | None) -> bool:
    """True if the hash field looks like a real password (not the
    disabled sentinel and not empty). Used by the unlink-protection
    invariant in ``user_identity_repo.delete_identity``."""
    return bool(hashed) and hashed != _DISABLED_SENTINEL
