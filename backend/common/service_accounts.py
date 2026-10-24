"""Service accounts: principals that never sign in.

A service account is a ``users`` row whose id starts ``svc_``, so every
foreign key, role binding, claims resolution and the API key machinery work on
it unchanged. Its own facts live in ``service_accounts``, and the people or
teams who answer for it in ``service_account_managers``. The prefix is what
lets code that reads no database tell one apart: the activity projection, the
session backstop, the routes that are about people. Only
``service_account_repo.create`` writes an id with it.

Pure, and importable by ``auth_service``, which may not import ``backend.app``.
"""
from __future__ import annotations

import uuid

ID_PREFIX = "svc_"
#: RFC 2606 reserves ``.invalid``: never routable, so nothing is ever mailed to
#: a service account, and no identity provider can assert the address.
EMAIL_DOMAIN = "service-account.invalid"


#: How long a service account's keys outlive its last manager when the
#: ``serviceAccountUnmanagedGrace`` switch holds no number of days.
DEFAULT_GRACE_DAYS = 14


def grace_days(value: object) -> int:
    """The grace switch as days: 0 or more, or the default for anything that
    is not a number."""
    try:
        days = int(str(value))
    except (TypeError, ValueError):
        return DEFAULT_GRACE_DAYS
    return days if days >= 0 else DEFAULT_GRACE_DAYS


def is_service_account(user_id: object) -> bool:
    return isinstance(user_id, str) and user_id.startswith(ID_PREFIX)


def new_id() -> str:
    return f"{ID_PREFIX}{uuid.uuid4().hex[:12]}"


def email_for(account_id: str) -> str:
    return f"{account_id}@{EMAIL_DOMAIN}"


def is_person(user_id_column):
    """SQL: the row is a person's, not a service account's — for every list
    that means people."""
    return ~user_id_column.startswith(ID_PREFIX, autoescape=True)


__all__ = [
    "ID_PREFIX", "EMAIL_DOMAIN", "DEFAULT_GRACE_DAYS", "grace_days", "is_service_account",
    "new_id", "email_for", "is_person",
]
