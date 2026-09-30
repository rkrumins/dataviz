"""The SSO activity log: every event a row, every filter a SQL predicate.

What an operator with hundreds of people signing in a day needs from it:
who, through what, what happened, why, the reference, and from where — as
columns — and filters that return full pages rather than a page of fifty
with the rest filtered away in the browser.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend.app.api.v1.endpoints.audit import _EVENT_META, _SSO_PREFIXES
from backend.app.api.v1.endpoints.sso_activity import EVENT_TYPES, OUTCOMES
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories import idp_provider_repo, user_repo

_BACKEND = Path(__file__).resolve().parents[1]
_EMITTED = re.compile(
    r'"((?:user\.sso_|user\.identity\.|idp\.|auth\.config\.|rbac\.sso_mapping\.)'
    r'[a-z_.]+|user\.logged_in|user\.logged_out|user\.login_failed|'
    r'user\.session_refused|user\.session_revoked|user\.sessions_ended_by_admin)"'
)


def test_every_sso_event_the_code_emits_is_in_the_log():
    """The log filters on an explicit list; a new event type missing from
    it would simply never be shown."""
    emitted: set[str] = set()
    for folder in ("app", "auth_service"):
        for path in (_BACKEND / folder).rglob("*.py"):
            emitted |= set(_EMITTED.findall(path.read_text(encoding="utf-8")))
    catalogued = {t for t in _EVENT_META if t.startswith(_SSO_PREFIXES)}
    missing = (emitted | catalogued) - set(EVENT_TYPES)
    assert not missing, f"not in sso_activity.OUTCOMES: {sorted(missing)}"


def test_each_event_type_has_exactly_one_outcome():
    assert len(EVENT_TYPES) == len(set(EVENT_TYPES))


async def _event(db_session, event_type, at, **payload):
    db_session.add(OutboxEventORM(
        event_type=event_type, created_at=at, payload=json.dumps(payload),
    ))


@pytest.fixture()
async def seeded(db_session):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp", display_name="Corporate", kind="oidc",
        settings={},
    )
    ada = await user_repo.create_user(
        db_session, email="ada@corp.io", password_hash="x",
        first_name="Ada", last_name="Lovelace", status="active",
    )
    t = "2099-01-01T10:0{}:00+00:00"
    await _event(db_session, "user.logged_in", t.format(1), user_id=ada.id,
                 email="ada@corp.io", provider_id=provider.id,
                 provider_slug="corp")
    await _event(db_session, "user.sso_login_failed", t.format(2), ref="ab12cd34",
                 provider_slug="corp", provider_id=provider.id,
                 reason="backchannel_unavailable", detail="idp_status:503",
                 client_ip="10.1.2.3", user_agent="Agent/1")
    await _event(db_session, "user.login_failed", t.format(3),
                 email="ada@corp.io", reason="no_local_password")
    await _event(db_session, "user.sso_jit_blocked", t.format(4),
                 email="new@corp.io", provider_id=provider.id,
                 reason="jit_provisioning_disabled")
    await _event(db_session, "user.session_refused", t.format(5),
                 user_id=ada.id, reason="reuse_detected")
    await _event(db_session, "idp.provider.updated", t.format(6),
                 provider_id=provider.id, slug="corp",
                 actor_id="usr_test000000")
    # Not on the SSO surface: never listed.
    await _event(db_session, "rbac.role.created", t.format(7), name="x")
    await db_session.commit()
    return {"ada": ada, "provider": provider}


_SINCE = {"fromTs": "2098-12-31T00:00:00+00:00"}


async def _get(test_client, **params):
    resp = await test_client.get(
        "/api/v1/admin/sso/activity", params={**_SINCE, **params},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_rows_carry_their_fields_as_columns(test_client, seeded):
    body = await _get(test_client)
    by_type = {r["eventType"]: r for r in body["rows"]}
    assert "rbac.role.created" not in by_type

    signed_in = by_type["user.logged_in"]
    assert signed_in["outcome"] == "signed_in"
    assert signed_in["person"]["name"] == "Ada Lovelace"
    assert signed_in["connection"] == {"slug": "corp", "name": "Corporate"}

    failed = by_type["user.sso_login_failed"]
    assert (failed["outcome"], failed["reason"], failed["detail"]) == (
        "failed", "backchannel_unavailable", "idp_status:503",
    )
    assert (failed["ref"], failed["clientIp"], failed["userAgent"]) == (
        "ab12cd34", "10.1.2.3", "Agent/1",
    )

    password = by_type["user.login_failed"]
    # Named by email alone in the record, resolved to the account.
    assert password["person"]["userId"] == seeded["ada"].id
    assert password["connection"] == {"slug": "password", "name": "Password"}

    # A record naming only the provider id still shows the connection.
    assert by_type["user.sso_jit_blocked"]["connection"]["slug"] == "corp"

    config = by_type["idp.provider.updated"]
    assert config["outcome"] == "config"
    assert config["actor"]["userId"] == "usr_test000000"


@pytest.mark.asyncio
async def test_outcome_filters_the_page_but_not_the_counts(test_client, seeded):
    body = await _get(test_client, outcome="failed")
    assert {r["outcome"] for r in body["rows"]} == {"failed"}
    assert len(body["rows"]) == 3
    assert body["counts"] == {
        "signed_in": 1, "failed": 3, "session_ended": 1, "signed_out": 0,
        "account": 0, "trust": 0, "config": 1,
    }


@pytest.mark.asyncio
async def test_connection_filter(test_client, seeded):
    corp = await _get(test_client, connection="corp")
    assert {r["eventType"] for r in corp["rows"]} == {
        "user.logged_in", "user.sso_login_failed", "user.sso_jit_blocked",
        "idp.provider.updated",
    }
    password = await _get(test_client, connection="password")
    assert [r["eventType"] for r in password["rows"]] == ["user.login_failed"]


@pytest.mark.asyncio
async def test_search_finds_a_reference_or_a_person(test_client, seeded):
    by_ref = await _get(test_client, q="ab12cd34")
    assert [r["ref"] for r in by_ref["rows"]] == ["ab12cd34"]

    by_name = await _get(test_client, q="lovelace")
    assert {r["eventType"] for r in by_name["rows"]} == {
        "user.logged_in", "user.session_refused",
    }


@pytest.mark.asyncio
async def test_pages_are_full_and_do_not_overlap(test_client, seeded):
    first = await _get(test_client, limit=2)
    assert len(first["rows"]) == 2 and first["nextCursor"]
    second = await _get(test_client, limit=2, cursor=first["nextCursor"])
    seen = [r["id"] for r in first["rows"] + second["rows"]]
    assert len(seen) == len(set(seen)) == 4
    ats = [r["at"] for r in first["rows"] + second["rows"]]
    assert ats == sorted(ats, reverse=True)


@pytest.mark.asyncio
async def test_an_unknown_outcome_is_refused(test_client, seeded):
    resp = await test_client.get(
        "/api/v1/admin/sso/activity", params={"outcome": "everything"},
    )
    assert resp.status_code == 422


def test_outcome_names_are_the_ones_the_page_offers():
    assert list(OUTCOMES) == [
        "signed_in", "failed", "session_ended", "signed_out", "account",
        "trust", "config",
    ]
