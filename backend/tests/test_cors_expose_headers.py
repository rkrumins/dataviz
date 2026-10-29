"""A page on another origin can read the headers the API documents for it.

A browser shows a cross-origin page only a few safelisted response headers, unless the answer
names the others in ``Access-Control-Expose-Headers``. A list's full size (``X-Total-Count``), the
id to quote about a request (``X-Request-ID``), when the calling key expires
(``X-API-Key-Expires-At``) and the next page of the versioning branch list (``X-Next-Cursor``) are
named there.
"""
from backend.app.main import _cors_origins


async def test_a_page_on_another_origin_may_read_the_documented_headers(test_client):
    origin = _cors_origins[0]
    r = await test_client.get("/api/v1/health/live", headers={"Origin": origin})
    assert r.headers["access-control-allow-origin"] == origin
    exposed = {h.strip().lower() for h in r.headers["access-control-expose-headers"].split(",")}
    assert {"x-total-count", "x-request-id", "x-api-key-expires-at", "x-next-cursor"} <= exposed
    assert r.headers["x-request-id"]
