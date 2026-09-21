"""APIRoute that keeps an encoded '/' inside a path parameter.

URNs carry paths — `urn:li:dataset:(urn:li:dataPlatform:s3,bucket/key,PROD)`,
file systems, `db/schema` names — and clients send them correctly encoded
(`%2F`). But an ASGI server hands the router a DECODED path, so the '/' splits
the parameter: `/nodes/{urn}` stops matching (404 — nothing under that entity
can ever load), and `/nodes/{urn}/children` becomes ambiguous with a node whose
URN happens to end in "/children".

This route matches against the RAW path, every escape decoded EXCEPT %2F, so the
slash stays inside its segment while matching; the parameter gets its '/' back
afterwards. A request with no encoded slash takes the ordinary path untouched.

Proxies must forward the path as sent. nginx `proxy_pass http://upstream;` (no
URI part) and the Vite dev proxy do; a proxy that normalises paths decodes %2F
before the request arrives, and no route can recover it.
"""
from urllib.parse import unquote

from fastapi.routing import APIRoute
from starlette.routing import Match

# Private-use stand-in for an encoded '/' while matching — cannot come from the
# URL's own escapes except as %EE%80%80, which no URN scheme here produces.
_SLASH = ""


def _decode_keeping_slashes(raw_path: bytes) -> str:
    text = raw_path.decode("latin-1")  # the request target is ASCII by spec
    return "/".join(
        unquote(segment.replace("%2F", _SLASH).replace("%2f", _SLASH))
        for segment in text.split("/")
    )


class RawPathSegmentRoute(APIRoute):
    def matches(self, scope):
        raw = scope.get("raw_path")
        if scope.get("type") != "http" or not raw or b"%2f" not in raw.lower():
            return super().matches(scope)
        match, child_scope = super().matches({**scope, "path": _decode_keeping_slashes(raw)})
        if match != Match.NONE:
            params = child_scope.get("path_params", {})
            child_scope["path_params"] = {
                key: value.replace(_SLASH, "/") if isinstance(value, str) else value
                for key, value in params.items()
            }
        return match, child_scope
