"""
Stateless JWT access-token helpers.

Payload layout:
    sub   – user id  (e.g. "usr_a1b2c3d4e5f6")
    email – user email
    role  – highest role name
    exp   – expiry (UTC epoch)
    iat   – issued-at (UTC epoch)
"""
from datetime import datetime, timezone, timedelta

import jwt

from .config import JWT_SECRET_KEY, JWT_ALGORITHM, JWT_EXPIRY_MINUTES


def create_access_token(
    user_id: str,
    email: str,
    role: str,
    extra: dict | None = None,
) -> str:
    """Create a signed JWT containing the given claims."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRY_MINUTES),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    """
    Decode and verify a JWT.

    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure.
    """
    return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
