"""The audit relay, the retention sweeps and the analytics warmer run in
every deployment, one process at a time.

``main.py`` started them only in a process holding the scheduler role, and
the control plane — the one process holding it in Docker Compose,
Kubernetes and Helm — runs a different module that never reached that
code. So in every container deployment sign-in events never reached the
append-only audit table, and the retention sweeps never ran.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import textwrap
from contextlib import asynccontextmanager

import pytest

from backend.app.db.advisory import claim_this_pass
from backend.app.db.repositories import user_repo
from backend.app.services import (
    analytics_warmer,
    api_key_housekeeping,
    outbox_relay,
    product_event_gc,
    refresh_token_gc,
)


def _factory(session):
    @asynccontextmanager
    async def _scope():
        yield session
    return _scope


# ── Where they run ───────────────────────────────────────────────────

def test_the_control_plane_starts_every_housekeeping_loop():
    from backend.app.services.aggregation import controlplane

    source = inspect.getsource(controlplane.lifespan)
    for loop in ("run_relay", "run_refresh_token_gc",
                 "run_product_event_gc", "run_warmer", "run_api_key_housekeeping"):
        assert f"{loop})" in source or f"{loop}(" in source, loop


def test_the_identity_provider_check_runs_wherever_the_api_does():
    """Its status page reads this process's own cache, so gating it on the
    scheduler role left every web replica answering with nothing."""
    from backend.app import main

    tree = ast.parse(textwrap.dedent(inspect.getsource(main.lifespan)))
    parents = {child: node for node in ast.walk(tree)
               for child in ast.iter_child_nodes(node)}
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and getattr(n.func, "id", None) == "run_idp_health_loop"]
    assert calls, "the IdP health loop is no longer started here"
    node = calls[0]
    while node in parents:
        node = parents[node]
        if isinstance(node, ast.If):
            assert "runs_scheduler" not in ast.unparse(node.test)


def test_api_key_usage_is_flushed_wherever_the_api_runs_and_before_the_pool_goes():
    """Each process counts its own keys' requests in memory, so every one
    must write them: gated on the scheduler role, the web replicas' counts
    would never reach the table. And the last flush must come before the
    database pool closes, or the last half minute of use is lost."""
    from backend.app import main

    tree = ast.parse(textwrap.dedent(inspect.getsource(main.lifespan)))
    parents = {child: node for node in ast.walk(tree)
               for child in ast.iter_child_nodes(node)}

    def calls(name):
        return [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                and name in (getattr(n.func, "id", None), getattr(n.func, "attr", None))]

    started = calls("run_flusher")
    assert started, "the API key usage flusher is no longer started here"
    node = started[0]
    while node in parents:
        node = parents[node]
        if isinstance(node, ast.If):
            assert "runs_scheduler" not in ast.unparse(node.test)
    final = [n for n in calls("flush") if "_usage_recorder" in ast.unparse(n.func)]
    assert final, "nothing writes what is still counted at shutdown"
    assert final[0].lineno < max(n.lineno for n in calls("close_db"))


# ── One process at a time ────────────────────────────────────────────

async def test_claiming_is_free_off_postgres(db_session):
    """The SQLite test database is one process; only Postgres arbitrates."""
    assert await claim_this_pass(db_session, "anything") is True


@pytest.mark.parametrize("module,loop,work", [
    (outbox_relay, "run_relay", "drain_once"),
    (refresh_token_gc, "run_sweeper", "sweep_once"),
    (product_event_gc, "run_sweeper", "sweep_once"),
    (analytics_warmer, "run_warmer", "warm_once"),
    (api_key_housekeeping, "run_sweeper", "remind_once"),
])
async def test_a_pass_another_process_holds_is_skipped(
    module, loop, work, db_session, monkeypatch,
):
    shutdown = asyncio.Event()
    attempts = []

    async def _held_elsewhere(_session, name):
        attempts.append(name)
        shutdown.set()  # one attempt is the whole test
        return False

    async def _must_not_run(*_a, **_k):
        raise AssertionError(f"{module.__name__} ran a pass another process holds")

    monkeypatch.setattr(module, "claim_this_pass", _held_elsewhere)
    monkeypatch.setattr(module, work, _must_not_run)
    await asyncio.wait_for(
        getattr(module, loop)(_factory(db_session), shutdown, interval=3600),
        timeout=10,
    )
    assert len(attempts) == 1


# ── The relay catches up ─────────────────────────────────────────────

async def test_the_relay_clears_a_backlog_in_one_tick(db_session, monkeypatch):
    """An install whose relay never ran has every event since it was
    installed waiting. One batch per five-second tick would take hours."""
    for i in range(450):
        await user_repo.create_outbox_event(
            db_session, event_type="user.logged_in", payload={"user_id": f"usr_{i}"},
        )

    shutdown = asyncio.Event()
    batches: list[int] = []
    drain = outbox_relay.drain_once

    async def _drain(session):
        recorded = await drain(session)
        batches.append(recorded)
        if recorded < outbox_relay._BATCH:
            shutdown.set()
        return recorded

    monkeypatch.setattr(outbox_relay, "drain_once", _drain)
    await asyncio.wait_for(
        outbox_relay.run_relay(_factory(db_session), shutdown, interval=3600),
        timeout=60,
    )
    assert batches == [200, 200, 50]


# ── What the Audit Log and Recent activity show ──────────────────────

@pytest.mark.parametrize("category", ["security", "sso", "all"])
async def test_back_channel_host_changes_are_on_the_audit_log(
    test_client, db_session, category,
):
    """They decide where the service may send credentialed requests, and
    no view of the log showed them."""
    for event in ("sso.backchannel_host_allowed", "sso.backchannel_host_withdrawn"):
        await user_repo.create_outbox_event(
            db_session, event_type=event,
            payload={"host": "gateway.internal", "port": 8443,
                     "actor_id": "usr_test000000"},
        )
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/admin/audit?category={category}&limit=50")
    assert resp.status_code == 200, resp.text
    summaries = {e["eventType"]: e.get("summary") for e in resp.json()["events"]}
    assert summaries.get("sso.backchannel_host_allowed") == (
        "Back-channel SSO host gateway.internal:8443 allowed")
    assert "sso.backchannel_host_withdrawn" in summaries


async def test_what_an_administrator_did_to_an_account_shows_in_its_activity(
    test_client, db_session,
):
    """Resets, reset links, role changes and suspensions are on the account
    page's list, but were written without the account link it reads."""
    me = "usr_test000000"
    await test_client.post(f"/api/v1/admin/users/{me}/generate-reset-token")
    await test_client.post(
        f"/api/v1/admin/users/{me}/reset-password",
        json={"newPassword": "V3ryStr0ngP@ssw0rd!"},
    )
    # Somebody else suspended and reactivated this account.
    for event, key in (("user.suspended", "suspended_by"),
                       ("user.reactivated", "reactivated_by")):
        await user_repo.create_outbox_event(
            db_session, event_type=event,
            payload={"user_id": me, key: "usr_another_admin"},
            aggregate_type="user", aggregate_id=me,
        )
    await db_session.commit()

    resp = await test_client.get("/api/v1/users/me/activity")
    assert resp.status_code == 200, resp.text
    by_type = {e["eventType"]: e["byAdmin"] for e in resp.json()}
    assert by_type["user.reset_token_generated"] is False   # did it themselves
    assert by_type["user.password_reset_by_admin"] is False
    assert by_type["user.suspended"] is True
    assert by_type["user.reactivated"] is True
