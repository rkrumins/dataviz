"""How a person's name is rendered, in one place.

The display name used to be computed as ``f"{first} {last}"`` in four
independent expressions — two in the users endpoints, one in the auth
endpoints, one on the cross-service ``User`` DTO. That was survivable
while it was pure derivation. It stops being survivable the moment a
stored override exists, because four expressions that must agree and are
not shared are four expressions that eventually don't.

Lives in ``backend.common`` because both ``backend.app`` and
``backend.auth_service`` need it, and ``auth_service`` may not import
from ``backend.app`` (it is kept extractable — see the note in
``backend/app/api/v1/endpoints/auth.py``).
"""
from __future__ import annotations

from typing import Optional


def resolve_display_name(
    display_name: Optional[str],
    first_name: Optional[str],
    last_name: Optional[str],
) -> str:
    """The name to show for a user.

    A non-blank stored ``display_name`` wins. Otherwise fall back to
    ``first last``, which is what every row did before the column
    existed — so an account that has never set one is unaffected.

    Whitespace-only is treated as unset rather than as a name, so
    clearing the field in the UI restores the derived name instead of
    blanking the account out of every list it appears in.
    """
    if display_name and display_name.strip():
        return display_name.strip()
    return f"{(first_name or '').strip()} {(last_name or '').strip()}".strip()
