"""Download links for search exports (and member sets).

A browser saves a download from a plain GET, and an export's scope — a
canvas's URNs, say — can be too long to repeat in its URL. So the request
that finished the export, having resolved and checked the scope, issues a
token for one export, one scope and one person, signed with the platform's
signing key and good for an hour; the download checks it against the key
ring, as a CSRF token is.

``purpose`` names what the token opens (a search export by default, a member
set's download): it is signed into the tag, so a token issued for one is never
accepted by the other.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Iterable, Optional, Tuple

#: How long a download link works once issued.
DOWNLOAD_TOKEN_SECONDS = 3600
#: What a token opens. A search export's is the tag every token had before there were two.
SEARCH_EXPORT = "search-export"
MEMBER_SET = "member-set"
#: A layer of a view made from a query (``graph_view_members_export``).
VIEW_MEMBERS = "view-members"


def mint_download_token(sid: str, scope_hash: str, principal: str, key: str, *,
                        ttl_s: int = DOWNLOAD_TOKEN_SECONDS, now: Optional[float] = None,
                        purpose: str = SEARCH_EXPORT) -> str:
    """A link's token for one export, one scope and one person, for an hour."""
    exp = int((now if now is not None else time.time()) + ttl_s)
    payload = base64.urlsafe_b64encode(json.dumps(
        {"s": sid, "h": scope_hash, "u": principal, "e": exp},
        separators=(",", ":")).encode()).decode().rstrip("=")
    return f"{payload}.{_tag(payload, key, purpose)}"


def read_download_token(token: str, principal: str, keys: Iterable[str], *,
                        now: Optional[float] = None,
                        purpose: str = SEARCH_EXPORT) -> Optional[Tuple[str, str]]:
    """``(session id, scope hash)`` the token vouches for — or None when it
    was not signed by any of ``keys`` for ``purpose``, is someone else's, or has
    expired."""
    payload, sep, tag = (token or "").partition(".")
    if not sep or not any(hmac.compare_digest(tag, _tag(payload, key, purpose)) for key in keys):
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except ValueError:
        return None
    if d.get("u") != principal or int(d.get("e", 0)) < (now if now is not None else time.time()):
        return None
    return str(d.get("s") or ""), str(d.get("h") or "")


def _tag(payload: str, key: str, purpose: str = SEARCH_EXPORT) -> str:
    return hmac.new(key.encode(), f"{purpose}.{payload}".encode(),
                    hashlib.sha256).hexdigest()[:32]
