"""The provider-supplied avatar, end to end.

The CSP forbids hotlinking a remote image — deliberately, so member
lists cannot beacon every viewer's IP to the IdP's CDN — which means an
avatar asserted as a URL in the claims only works if the SERVER fetches
the bytes at sign-in and re-serves them from our own origin. This file
pins that pipeline:

* the claim maps (``picture`` et al.) only while the connection's
  ``map_avatar`` toggle is on;
* the fetch runs through the outbound guard — raster image types only,
  size capped, redirects followed at most three hops with the address
  re-checked on every hop, private destinations allowlisted;
* a fetch failure is a log line, never a failed login;
* the bytes are fetched once per URL — an unchanged claim skips the
  round trip, a changed one refreshes the image;
* a rehearsal fetches nothing;
* the stored image is served, cacheably, from ``/users/{id}/avatar``.
"""
from __future__ import annotations

import base64
import json

import httpx
import pytest
from sqlalchemy import select

from backend.app.db.models import UserORM
from backend.app.db.repositories import user_repo
from backend.auth_service.providers import outbound
from backend.auth_service.providers.claim_mapper import apply_claim_mapping
from backend.tests.test_sso_backchannel_browser_exchange import (
    _REAL_ASYNC_CLIENT,
    _assertion,
    _jwk,
    _make_row,
)

AVATAR_URL = "https://sso.corporate.com/avatars/ada.png"
AVATAR_URL_2 = "https://sso.corporate.com/avatars/ada-2026.png"
PNG = b"\x89PNG\r\n\x1a\n" + b"fake-image-bytes" * 4


def _routes(monkeypatch, *, avatar_status=200, content_type="image/png"):
    """Serve the JWKS and the avatar path from one mock transport."""
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.startswith("/avatars/"):
            return httpx.Response(
                avatar_status, content=PNG,
                headers={"Content-Type": content_type},
            )
        return httpx.Response(200, json={"keys": [_jwk()]})

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    return seen


def _wire_fetcher(monkeypatch):
    """The conftest service is built without the app's avatar fetcher;
    wire the real outbound one, with a call log."""
    from backend.app.main import app

    calls: list[str] = []

    async def _fetch(url: str) -> tuple[bytes, str]:
        calls.append(url)
        return await outbound.fetch_image(url, timeout=5.0)

    monkeypatch.setattr(
        app.state.identity_service, "_avatar_fetcher", _fetch,
    )
    return calls


async def _login(test_client, *, jti: str, **extra):
    return await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion(jti=jti, **extra)},
    )


async def _ada(db_session) -> UserORM:
    db_session.expire_all()
    return (await db_session.execute(
        select(UserORM).where(UserORM.email == "ada.lovelace@corporate.com"),
    )).scalar_one()


# ── the claim ────────────────────────────────────────────────────────

def test_the_backchannel_defaults_map_the_usual_picture_claims():
    for name in ("picture", "avatarUrl", "avatar_url", "photoUrl", "photo"):
        identity = apply_claim_mapping(
            {"sub": "e1", "email": "a@corp.example", name: AVATAR_URL},
            kind="backchannel", provider_slug="corp",
        )
        assert identity.avatar_url == AVATAR_URL, name


def test_the_other_kinds_map_no_avatar_by_default():
    """Participation is per-connection; a kind with no toggle opts in
    through an explicit override, never by surprise."""
    for kind in ("oidc", "custom", "custom_profile"):
        identity = apply_claim_mapping(
            {"sub": "e1", "email": "a@corp.example",
             "external_id": "e1", "picture": AVATAR_URL},
            kind=kind, provider_slug="corp",
        )
        assert identity.avatar_url is None, kind
    overridden = apply_claim_mapping(
        {"sub": "e1", "email": "a@corp.example", "photo": AVATAR_URL},
        kind="oidc", provider_slug="corp",
        override={"avatar_url": ["photo"]},
    )
    assert overridden.avatar_url == AVATAR_URL


# ── the login-time fetch ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_mapped_avatar_is_fetched_stored_and_owned(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    calls = _wire_fetcher(monkeypatch)
    await _make_row(db_session, map_avatar=True)

    resp = await _login(test_client, jti="av-1", picture=AVATAR_URL)
    assert resp.status_code == 200, resp.text
    assert calls == [AVATAR_URL]

    user = await _ada(db_session)
    assert base64.b64decode(user.avatar_image) == PNG
    assert user.avatar_image_type == "image/png"
    assert user.avatar_source_url == AVATAR_URL
    managed = json.loads(user.metadata_)["idp_managed"]["fields"]
    assert "avatar" in managed


@pytest.mark.asyncio
async def test_the_toggle_off_fetches_and_owns_nothing(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """Off is the default, and off means the asserted URL is inert —
    no request leaves, nothing is stored, nothing is locked."""
    seen = _routes(monkeypatch)
    calls = _wire_fetcher(monkeypatch)
    await _make_row(db_session)

    resp = await _login(test_client, jti="av-2", picture=AVATAR_URL)
    assert resp.status_code == 200, resp.text
    assert calls == []
    assert not [r for r in seen if r.url.path.startswith("/avatars/")]

    user = await _ada(db_session)
    assert user.avatar_image is None
    managed = json.loads(user.metadata_)["idp_managed"]["fields"]
    assert "avatar" not in managed


@pytest.mark.asyncio
async def test_a_failed_fetch_never_blocks_the_login_or_locks_the_field(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """A URL nothing could download must not cost the sign-in, and must
    not lock the person out of picking their own picture."""
    _routes(monkeypatch, avatar_status=500)
    _wire_fetcher(monkeypatch)
    await _make_row(db_session, map_avatar=True)

    resp = await _login(test_client, jti="av-3", picture=AVATAR_URL)
    assert resp.status_code == 200, resp.text

    user = await _ada(db_session)
    assert user.avatar_image is None
    managed = json.loads(user.metadata_)["idp_managed"]["fields"]
    assert "avatar" not in managed


@pytest.mark.asyncio
async def test_an_unchanged_url_skips_the_refetch_and_a_changed_one_refreshes(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    calls = _wire_fetcher(monkeypatch)
    await _make_row(db_session, map_avatar=True)

    assert (await _login(
        test_client, jti="av-4a", picture=AVATAR_URL,
    )).status_code == 200
    assert (await _login(
        test_client, jti="av-4b", picture=AVATAR_URL,
    )).status_code == 200
    assert calls == [AVATAR_URL]

    assert (await _login(
        test_client, jti="av-4c", picture=AVATAR_URL_2,
    )).status_code == 200
    assert calls == [AVATAR_URL, AVATAR_URL_2]
    user = await _ada(db_session)
    assert user.avatar_source_url == AVATAR_URL_2


@pytest.mark.asyncio
async def test_a_rehearsal_fetches_but_stores_nothing(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The dry-run still promises to WRITE nothing — but it now makes
    the same avatar GET a real sign-in would, so the verdict can say
    whether the picture would arrive instead of leaving a refused fetch
    as one server log line. Fetch yes, store no."""
    from sqlalchemy import select

    from backend.auth_service.core.tokens import create_dryrun_token

    seen = _routes(monkeypatch)
    calls = _wire_fetcher(monkeypatch)
    row = await _make_row(db_session, lifecycle="draft", map_avatar=True)

    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion(jti="av-5", picture=AVATAR_URL)},
        cookies={"nx_dryrun": create_dryrun_token(
            admin_id="u-admin", provider_id=row.id,
        )},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("dryRun") is True
    assert calls == [AVATAR_URL]
    assert len([r for r in seen if r.url.path.startswith("/avatars/")]) == 1
    assert body["outcome"]["avatar"] == {
        "url": AVATAR_URL, "fetched": True,
        "content_type": "image/png", "size": len(PNG),
    }
    # Stores nothing: the rehearsal provisioned no account, so there is
    # nowhere the image could have landed.
    db_session.expire_all()
    assert (await db_session.execute(
        select(UserORM).where(UserORM.email == "ada.lovelace@corporate.com"),
    )).scalar_one_or_none() is None


# ── the outbound guard ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_fetch_refuses_everything_but_an_image(monkeypatch):
    _routes(monkeypatch, content_type="text/html")
    with pytest.raises(outbound.BlockedOutboundRequest, match="image"):
        await outbound.fetch_image(AVATAR_URL, timeout=5.0)


@pytest.mark.asyncio
async def test_the_fetch_caps_the_size_while_streaming(monkeypatch):
    _routes(monkeypatch)
    with pytest.raises(outbound.BlockedOutboundRequest, match="cap"):
        await outbound.fetch_image(AVATAR_URL, timeout=5.0, max_bytes=8)


def _redirecting(monkeypatch, dispatch):
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return dispatch(request)

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    return seen


@pytest.mark.asyncio
async def test_a_redirect_chain_is_followed_and_rechecked(monkeypatch):
    # Photo hosts 302 to their CDN as a matter of course; refusing every
    # redirect meant "silently never stores" for most external avatars.
    # A relative Location exercises the resolve-against-current-URL path.
    def _dispatch(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cdn/ada-real.png":
            return httpx.Response(
                200, content=PNG, headers={"Content-Type": "image/png"},
            )
        return httpx.Response(302, headers={"Location": "/cdn/ada-real.png"})

    seen = _redirecting(monkeypatch, _dispatch)
    body, content_type = await outbound.fetch_image(AVATAR_URL, timeout=5.0)
    assert (body, content_type) == (PNG, "image/png")
    assert [r.url.path for r in seen] == [
        "/avatars/ada.png", "/cdn/ada-real.png",
    ]


@pytest.mark.asyncio
async def test_a_redirect_to_a_private_address_is_refused(monkeypatch):
    # The SSRF property the old refuse-all-redirects rule protected,
    # asserted directly: the hop is address-checked BEFORE it is
    # requested, so a 302 cannot route past the pre-flight check.
    seen = _redirecting(
        monkeypatch,
        lambda request: httpx.Response(
            302, headers={"Location": "http://10.0.0.1/x"},
        ),
    )
    with pytest.raises(outbound.BlockedOutboundRequest) as exc:
        await outbound.fetch_image(AVATAR_URL, timeout=5.0)
    assert exc.value.reason == "private_address_not_allowlisted"
    assert [r.url.path for r in seen] == ["/avatars/ada.png"]


@pytest.mark.asyncio
async def test_more_than_three_hops_is_refused(monkeypatch):
    seen = _redirecting(
        monkeypatch,
        lambda request: httpx.Response(
            302, headers={"Location": "/avatars/again.png"},
        ),
    )
    with pytest.raises(outbound.BlockedOutboundRequest) as exc:
        await outbound.fetch_image(AVATAR_URL, timeout=5.0)
    assert exc.value.reason == "too_many_redirects"
    # The original request plus exactly three followed hops.
    assert len(seen) == 4


@pytest.mark.parametrize("content_type", ["image/avif", "image/jpg"])
@pytest.mark.asyncio
async def test_avif_and_the_jpg_alias_are_accepted(monkeypatch, content_type):
    _routes(monkeypatch, content_type=content_type)
    body, served_as = await outbound.fetch_image(AVATAR_URL, timeout=5.0)
    assert (body, served_as) == (PNG, content_type)


@pytest.mark.asyncio
async def test_svg_is_refused_and_the_reason_names_it(monkeypatch):
    # Rasters only, by owner decision: SVG can script, and no sandbox on
    # the serving side makes accepting it worth the class of bug.
    _routes(monkeypatch, content_type="image/svg+xml")
    with pytest.raises(outbound.BlockedOutboundRequest, match="svg") as exc:
        await outbound.fetch_image(AVATAR_URL, timeout=5.0)
    assert exc.value.reason == "not_an_image"


@pytest.mark.asyncio
async def test_the_fetch_refuses_unroutable_destinations():
    with pytest.raises(outbound.BlockedOutboundRequest):
        await outbound.fetch_image("http://127.0.0.1/avatar.png", timeout=5.0)


# ── the avatar host allowlist (require_hosts) ────────────────────────
#
# The owner-chosen posture: external avatar hosts are OFF until listed.
# ``require_hosts`` inverts the usual allowlist meaning — every hop must
# be on it, public hosts included — and an empty set refuses everything.

@pytest.mark.asyncio
async def test_an_unlisted_external_host_is_refused_by_name(monkeypatch):
    seen = _routes(monkeypatch)
    with pytest.raises(outbound.BlockedOutboundRequest) as exc:
        await outbound.fetch_image(
            AVATAR_URL, timeout=5.0, require_hosts=frozenset(),
        )
    assert exc.value.reason == "host_not_allowlisted"
    # The message is the operator's breadcrumb: it names what to add.
    assert "sso.corporate.com" in str(exc.value)
    # Refused before any request is made.
    assert seen == []


@pytest.mark.asyncio
async def test_a_listed_host_fetches(monkeypatch):
    _routes(monkeypatch)
    body, content_type = await outbound.fetch_image(
        AVATAR_URL, timeout=5.0,
        require_hosts=frozenset({"sso.corporate.com:443"}),
    )
    assert (body, content_type) == (PNG, "image/png")


@pytest.mark.asyncio
async def test_a_redirect_off_the_list_is_refused(monkeypatch):
    # Listing one host must not let its redirect walk to a second one:
    # the requirement holds for every hop in the chain.
    seen = _redirecting(
        monkeypatch,
        lambda request: httpx.Response(
            302, headers={"Location": "https://cdn.elsewhere.example/x"},
        ),
    )
    with pytest.raises(outbound.BlockedOutboundRequest) as exc:
        await outbound.fetch_image(
            AVATAR_URL, timeout=5.0,
            require_hosts=frozenset({"sso.corporate.com:443"}),
        )
    assert exc.value.reason == "host_not_allowlisted"
    assert "cdn.elsewhere.example" in str(exc.value)
    assert [r.url.path for r in seen] == ["/avatars/ada.png"]


# ── serving ──────────────────────────────────────────────────────────

_ME = "usr_test000000"


@pytest.mark.asyncio
async def test_a_user_with_no_image_serves_a_cacheable_404(test_client):
    resp = await test_client.get(f"/api/v1/users/{_ME}/avatar")
    assert resp.status_code == 404
    assert "max-age" in resp.headers.get("cache-control", "")
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("content-security-policy") == "sandbox"


@pytest.mark.asyncio
async def test_the_stored_image_is_served_with_an_etag(
    test_client, db_session,
):
    await user_repo.set_user_avatar_image(
        db_session, _ME,
        image_b64=base64.b64encode(PNG).decode("ascii"),
        content_type="image/png",
        source_url=AVATAR_URL,
    )
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/users/{_ME}/avatar")
    assert resp.status_code == 200
    assert resp.content == PNG
    assert resp.headers["content-type"].startswith("image/png")
    etag = resp.headers["etag"]
    assert "max-age" in resp.headers["cache-control"]
    # Third-party bytes on our origin: no sniffing, sandboxed as a page.
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"] == "sandbox"

    # The alias the signed-in person can always use for themselves.
    me = await test_client.get("/api/v1/users/me/avatar")
    assert me.status_code == 200

    again = await test_client.get(
        f"/api/v1/users/{_ME}/avatar", headers={"If-None-Match": etag},
    )
    assert again.status_code == 304
    assert again.headers.get("content-security-policy") == "sandbox"
