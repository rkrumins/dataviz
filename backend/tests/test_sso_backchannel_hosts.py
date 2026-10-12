"""The back-channel host allowlist, and what it deliberately cannot do.

Letting operators edit this from the admin UI is a real trade. An entry
lets this service make a request to an address on the internal network,
which is the exact capability ``providers/outbound.py`` exists to
withhold — so the list is the only thing standing between an SSO
configuration form and a request-forgery tool.

The trade is accepted, and these tests pin the things that make it
survivable:

* entries are exact ``host:port``, never wildcards, CIDR ranges, or a
  host that quietly covers every port on the box;
* spellings normalise, so the list an operator reads is the list that
  is enforced;
* no entry, however it was created, reaches loopback or the cloud
  metadata service;
* the route is behind its own fail-closed permission rather than plain
  ``system:admin``;
* removal takes effect on the next login, not on a cache TTL.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import backchannel_host_repo as repo
from backend.app.db.repositories.backchannel_host_repo import (
    BackchannelHostError,
)

_BASE = "/api/v1/admin/idp-providers/backchannel-hosts"


# ── normalisation ────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("gw.corp.internal", "gw.corp.internal"),
    ("  GW.Corp.Internal  ", "gw.corp.internal"),
    ("gw.corp.internal.", "gw.corp.internal"),
    ("10.0.0.5", "10.0.0.5"),
    ("fd00::1", "fd00::1"),
    # A v6 gateway pasted straight out of a URL. Stored unbracketed
    # because that is what ``urlsplit(...).hostname`` yields, and the
    # two spellings have to be one entry.
    ("[fd00::1]", "fd00::1"),
])
def test_one_destination_is_one_entry(raw, expected):
    """An allowlist where a destination can be spelled three ways is one
    an operator cannot audit by reading it."""
    assert repo.normalise_host(raw) == expected


@pytest.mark.parametrize("raw", [
    "*.corp.internal",      # a wildcard is how this becomes "allow everything"
    "10.0.0.0/8",           # ditto a range
    "https://gw.corp/x",    # a pasted URL
    "gw.corp:443",          # the port belongs in its own field
    "",
    "   ",
    "a..b",
    "-leading.hyphen",
])
def test_anything_that_would_never_match_is_refused_not_stored(raw):
    """An entry that looks present but matches nothing is worse than an
    error, because the operator stops looking for the problem."""
    with pytest.raises(BackchannelHostError):
        repo.normalise_host(raw)


@pytest.mark.parametrize("raw", ["0", "65536", "-1", "https", "", None])
def test_a_port_that_is_not_a_port_is_refused(raw):
    with pytest.raises(BackchannelHostError):
        repo.normalise_port(raw)


# ── the repository ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_entry_becomes_a_key_the_guard_can_match(db_session):
    await repo.add_host(db_session, host="GW.Corp.Internal", port=443)
    assert await repo.allowed_host_keys(db_session) == {"gw.corp.internal:443"}


@pytest.mark.asyncio
async def test_the_same_host_on_two_ports_is_two_entries(db_session):
    """Allowing the gateway on 443 must not also allow whatever answers
    on 6379 on the same box."""
    await repo.add_host(db_session, host="gw.corp.internal", port=443)
    await repo.add_host(db_session, host="gw.corp.internal", port=8443)
    assert await repo.allowed_host_keys(db_session) == {
        "gw.corp.internal:443", "gw.corp.internal:8443",
    }


@pytest.mark.asyncio
async def test_adding_the_same_entry_twice_is_not_an_error(db_session):
    """Two operators allowing the same gateway is not a conflict anyone
    needs to resolve."""
    first = await repo.add_host(db_session, host="gw.corp.internal")
    second = await repo.add_host(db_session, host="gw.corp.internal.")
    assert first.id == second.id
    assert len(await repo.list_hosts(db_session)) == 1


@pytest.mark.asyncio
async def test_removal_is_immediate(db_session):
    row = await repo.add_host(db_session, host="gw.corp.internal")
    assert await repo.delete_host(db_session, row.id) is True
    assert await repo.allowed_host_keys(db_session) == frozenset()
    assert await repo.delete_host(db_session, row.id) is False


# ── two lists, one table ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_two_lists_do_not_bleed_into_each_other(db_session):
    """A gateway entry must not quietly admit an avatar host, nor the
    other way round — the reads are purpose-filtered."""
    await repo.add_host(db_session, host="gw.corp.internal", port=443)
    await repo.add_host(
        db_session, host="avatars.example.com", port=443, purpose="avatar",
    )
    assert await repo.allowed_host_keys(db_session) == {
        "gw.corp.internal:443",
    }
    assert await repo.allowed_host_keys(db_session, purpose="avatar") == {
        "avatars.example.com:443",
    }


@pytest.mark.asyncio
async def test_the_same_host_may_sit_on_both_lists(db_session):
    gw = await repo.add_host(db_session, host="pics.corp.internal")
    av = await repo.add_host(
        db_session, host="pics.corp.internal", purpose="avatar",
    )
    assert gw.id != av.id
    assert len(await repo.list_hosts(db_session)) == 1
    assert len(await repo.list_hosts(db_session, purpose="avatar")) == 1


@pytest.mark.asyncio
async def test_an_unknown_purpose_is_refused(db_session):
    with pytest.raises(BackchannelHostError):
        await repo.add_host(db_session, host="x.example", purpose="both")
    with pytest.raises(BackchannelHostError):
        await repo.list_hosts(db_session, purpose="")


# ── the floor no entry can lower ─────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("host", [
    "169.254.169.254",   # cloud metadata — instance credentials
    "127.0.0.1",         # our own Redis, debug ports, internal endpoints
    "::1",
    "0.0.0.0",
])
async def test_storing_a_forbidden_address_still_does_not_reach_it(
    db_session, host,
):
    """The list can HOLD these — normalisation is about spelling, not
    policy — and they are still refused at request time. Enforcing the
    floor in the guard rather than in the form is deliberate: it must
    hold for a row created by any route, a migration, or a DBA.
    """
    from backend.auth_service.providers.outbound import (
        BlockedOutboundRequest, assert_fetchable,
    )

    await repo.add_host(db_session, host=host, port=443)
    allowed = await repo.allowed_host_keys(db_session)

    bracket = f"[{host}]" if ":" in host else host
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable(f"https://{bracket}/redeem", allow_hosts=allowed)


@pytest.mark.asyncio
async def test_an_ordinary_internal_host_is_reachable_once_allowed(db_session):
    """The control. Without it the test above could pass because the
    allowlist never works at all."""
    from backend.auth_service.providers.outbound import assert_fetchable

    await repo.add_host(db_session, host="10.0.0.5", port=443)
    allowed = await repo.allowed_host_keys(db_session)
    assert_fetchable("https://10.0.0.5/redeem", allow_hosts=allowed)  # no raise


# ── the routes ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_full_round_trip_through_the_api(test_client):
    created = await test_client.post(
        _BASE, json={"host": "GW.Corp.Internal", "port": 443,
                     "note": "primary gateway"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["host"] == "gw.corp.internal"
    assert body["note"] == "primary gateway"

    listed = await test_client.get(_BASE)
    assert [e["host"] for e in listed.json()] == ["gw.corp.internal"]

    removed = await test_client.delete(f"{_BASE}/{body['id']}")
    assert removed.status_code == 204
    assert (await test_client.get(_BASE)).json() == []


@pytest.mark.asyncio
async def test_the_avatar_list_round_trips_through_the_api(test_client):
    created = await test_client.post(
        f"{_BASE}?purpose=avatar",
        json={"host": "Avatars.Example.Com", "note": "public CDN"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["purpose"] == "avatar"
    assert body["host"] == "avatars.example.com"

    listed = await test_client.get(f"{_BASE}?purpose=avatar")
    assert [e["host"] for e in listed.json()] == ["avatars.example.com"]
    # The default read is the gateway list; the avatar entry stays off it.
    assert (await test_client.get(_BASE)).json() == []

    assert (
        await test_client.delete(f"{_BASE}/{body['id']}")
    ).status_code == 204
    assert (await test_client.get(f"{_BASE}?purpose=avatar")).json() == []


@pytest.mark.asyncio
async def test_a_made_up_purpose_is_a_validation_error(test_client):
    resp = await test_client.get(f"{_BASE}?purpose=everything")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_a_bad_entry_is_a_400_not_a_500(test_client):
    resp = await test_client.post(_BASE, json={"host": "*.corp.internal"})
    assert resp.status_code == 400
    assert "wildcard" in resp.text.lower()


@pytest.mark.asyncio
async def test_removing_something_that_is_not_there_is_a_404(test_client):
    assert (await test_client.delete(f"{_BASE}/bch_nope")).status_code == 404


@pytest.mark.asyncio
async def test_editing_the_list_is_audited(test_client, db_session):
    """The security argument for a UI-editable allowlist rests on each
    entry being attributable. An unaudited add is an anonymous grant of
    internal network reach."""
    from sqlalchemy import select
    from backend.app.db import models as _models

    created = await test_client.post(_BASE, json={"host": "gw.corp.internal"})
    await test_client.delete(f"{_BASE}/{created.json()['id']}")

    events = (await db_session.execute(
        select(_models.OutboxEventORM.event_type)
    )).scalars().all()
    assert "sso.backchannel_host_allowed" in events
    assert "sso.backchannel_host_withdrawn" in events


# ── who may edit it ──────────────────────────────────────────────────

def test_the_permission_is_fail_closed():
    """An unreachable revocation backend must refuse these routes rather
    than assume the session behind them is still good. Adding an
    internal destination is not a read."""
    from backend.app.auth import dependencies as deps

    assert "system:sso:hosts:manage" in deps._FAIL_CLOSED_PERMISSIONS


def test_the_permission_is_seeded_for_fresh_and_existing_installs():
    """``seed_reference_data`` runs on the virgin-database path only, so
    a permission added to ``rbac_seed`` alone reaches fresh installs and
    nothing else — ungrantable, and invisible in the role matrix."""
    import importlib.util
    from pathlib import Path
    from backend.app.config import rbac_seed

    perm = "system:sso:hosts:manage"
    assert perm in {p["id"] for p in rbac_seed.PERMISSIONS}

    path = (
        Path(__file__).resolve().parent.parent
        / "alembic" / "versions" / "20260824_1500_sso_backchannel.py"
    )
    spec = importlib.util.spec_from_file_location("_bc_migration", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod._PERMISSION == perm
    assert set(mod._ROLE_GRANTS) == {
        (r, p) for r, p in rbac_seed.ROLE_GRANTS if p == perm
    }


def test_it_is_not_handed_to_every_platform_administrator():
    """org_admin runs the platform; this decides where the platform may
    send requests. Separating them is the point of the permission."""
    from backend.app.config import rbac_seed

    holders = {
        r for r, p in rbac_seed.ROLE_GRANTS if p == "system:sso:hosts:manage"
    }
    assert holders == {"super_admin"}
