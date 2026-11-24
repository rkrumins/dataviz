#!/usr/bin/env python3
"""Time People analytics at the scale it is built for — thousands of people, a year of events.

Seeds a MIGRATED Postgres database (``alembic upgrade head`` first) with a synthetic tenancy:
``--users`` accounts of whom ``--active`` do something, ``--workspaces`` workspaces (the first
one large), views, role bindings, and ``--days`` of activity across all three stores — view
opens, traces, searches and section moves in ``product_events``, edits in
``view_activity_log``, sign-ins and data operations in the ledger. Seeding is SQL
``generate_series``, so tens of millions of rows take minutes, not hours.

Then it runs the people indexer exactly as production does (one ``step`` per transaction until
caught up) and times every read the pages make, cold (cache cleared) and, for the roster page,
warm. Peak Python memory per build is measured in a separate ``tracemalloc`` run so it does not
slow the timed ones. Prints a Markdown report.

Run::

    MANAGEMENT_DB_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/pplbench \\
        python -m alembic upgrade head            # from backend/
    python -m backend.scripts.bench_people_analytics \\
        --dsn postgresql+asyncpg://postgres:postgres@localhost:5432/pplbench \\
        --users 10000 --active 5000 --days 365

``--skip-seed`` and ``--skip-index`` re-time reads against an already-built database.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
import tracemalloc
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.db.models import (
    PersonActivityDailyORM,
    RoleBindingORM,
    UserORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import people_activity_repo as repo
from backend.app.db.repositories import people_index_repo as index
from backend.app.services import analytics_cache

_SEEDED = ("product_events", "view_activity_log", "auth_audit_log", "role_bindings", "views",
           "workspaces", "users", "person_activity_daily", "people_daily_facets",
           "people_index_days", "people_index_cursors", "person_workspace_activity",
           "group_members", "groups")


async def _seed(session: AsyncSession, a: argparse.Namespace, now: datetime) -> dict[str, int]:
    """The tenancy. Accounts, workspaces, views and bindings through the ORM's tables (so every
    column default applies); events through ``INSERT … SELECT generate_series``."""
    await session.execute(text("TRUNCATE " + ", ".join(_SEEDED) + " CASCADE"))
    created = (now - timedelta(days=a.days + 30)).isoformat()
    await session.execute(insert(WorkspaceORM), [
        {"id": f"ws_b{i}", "name": f"Workspace {i}", "created_at": created} for i in range(a.workspaces)])
    for start in range(0, a.users, 2_000):
        await session.execute(insert(UserORM), [
            {"id": f"usr_b{u}", "email": f"person{u}@bench.example", "password_hash": "x",
             "first_name": "Person", "last_name": str(u), "status": "active", "created_at": created}
            for u in range(start, min(a.users, start + 2_000))])
    # A fifth of all views live in the first workspace, which is the big one.
    await session.execute(insert(ViewORM), [
        {"id": f"view_b{i}", "name": f"View {i}", "created_at": created,
         "workspace_id": "ws_b0" if i % 5 == 0 else f"ws_b{i % a.workspaces}"}
        for i in range(a.views)])
    bindings = [{"id": f"bnd_b{u}", "subject_type": "user", "subject_id": f"usr_b{u}",
                 "role_name": "workspace_member", "scope_type": "workspace",
                 "scope_id": f"ws_b{u % a.workspaces}", "granted_at": created}
                for u in range(a.users)]
    bindings += [{"id": f"bnd_big{u}", "subject_type": "user", "subject_id": f"usr_b{u}",
                  "role_name": "workspace_member", "scope_type": "workspace", "scope_id": "ws_b0",
                  "granted_at": created} for u in range(min(a.users, a.big_members)) if u % a.workspaces]
    for start in range(0, len(bindings), 2_000):
        await session.execute(insert(RoleBindingORM), bindings[start:start + 2_000])
    await session.commit()

    start_day = (now - timedelta(days=a.days - 1)).date()
    params = {"active": a.active, "days": a.days, "start": start_day, "avg": a.events,
              "views": a.views, "ws": a.workspaces}
    # Who was active on which day: heavier people more often, weekends a fifth as often.
    await session.execute(text("DROP TABLE IF EXISTS bench_days"))
    await session.execute(text("""
        CREATE TABLE bench_days AS
        SELECT u, d FROM generate_series(0, :active - 1) u
        CROSS JOIN generate_series(0, :days - 1) d
        WHERE random() < (0.15 + 0.6 * (1 - u::float / :active))
              * CASE WHEN extract(isodow FROM CAST(:start AS date) + d) >= 6 THEN 0.2 ELSE 1 END
    """), params)
    ts = ("to_char(CAST(:start AS date) + d + make_interval(hours => z.h, mins => (k * 7 + u) % 60, "
          "secs => (k * 13) % 60), 'YYYY-MM-DD\"T\"HH24:MI:SS') || '+00:00'")
    await session.execute(text(f"""
        INSERT INTO product_events (id, event_type, actor_id, subject_id, created_at)
        SELECT 'pev_b' || u || '_' || d || '_' || k, z.t, 'usr_b' || u,
               CASE WHEN z.t = 'view.opened' THEN 'view_b' || ((u * 7 + k * 13 + d) % :views)
                    WHEN z.t = 'app.section' THEN (ARRAY['explore','workspaces','dashboard',
                         'analytics','schema','ingestion'])[1 + (k % 6)] END,
               {ts}
        FROM bench_days
        CROSS JOIN LATERAL generate_series(1, 1 + (random() * 2 * :avg + u * 0)::int) k
        CROSS JOIN LATERAL (
            SELECT (8 + floor(random() * 10 + k * 0))::int AS h,
                   CASE WHEN r < 0.45 THEN 'view.opened' WHEN r < 0.60 THEN 'lineage.trace'
                        WHEN r < 0.63 THEN 'lineage.trace_empty' WHEN r < 0.75 THEN 'graph.search'
                        WHEN r < 0.78 THEN 'graph.search_miss' WHEN r < 0.95 THEN 'app.section'
                        WHEN r < 0.98 THEN 'graph.export' ELSE 'docs.feedback' END AS t
            FROM (SELECT random() + k * 0 AS r) q
        ) z
    """), params)
    await session.execute(text("""
        INSERT INTO auth_audit_log (id, source_event_id, event_type, payload, occurred_at, recorded_at,
            category, audience, outcome, actor_id, actor_kind, subject_id, projection_version)
        SELECT 'aud_bs' || u || '_' || d, 'src_bs' || u || '_' || d, 'user.logged_in',
               '{"provider": "local"}', s, s, 'identity', 'platform', 'success',
               'usr_b' || u, 'user', 'usr_b' || u, 1
        FROM (SELECT u, d, to_char(CAST(:start AS date) + d + make_interval(hours => 7, mins => u % 60),
                     'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00' AS s FROM bench_days) x
    """), params)
    await session.execute(text("""
        INSERT INTO auth_audit_log (id, source_event_id, event_type, payload, occurred_at, recorded_at,
            category, audience, outcome, actor_id, actor_kind, workspace_id, projection_version)
        SELECT 'aud_bo' || u || '_' || d, 'src_bo' || u || '_' || d, 'aggregation.job.started', '{}',
               s, s, 'operations', 'workspace', 'success', 'usr_b' || u, 'user', 'ws_b' || (u % :ws), 1
        FROM (SELECT u, d, to_char(CAST(:start AS date) + d + make_interval(hours => 15),
                     'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00' AS s
              FROM bench_days WHERE (u + d) % 20 = 0) x
    """), params)
    await session.execute(text("""
        INSERT INTO view_activity_log (id, view_id, workspace_id, action, actor, created_at)
        SELECT 'val_b' || u || '_' || d, 'view_b' || v,
               CASE WHEN v % 5 = 0 THEN 'ws_b0' ELSE 'ws_b' || (v % :ws) END, 'updated', 'usr_b' || u,
               to_char(CAST(:start AS date) + d + make_interval(hours => 11, mins => u % 60),
                       'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00'
        FROM (SELECT u, d, (u * 31 + d) % :views AS v FROM bench_days WHERE (u + d) % 10 = 0) x
    """), params)
    await session.execute(text("DROP TABLE bench_days"))
    await session.commit()
    await session.execute(text("ANALYZE"))
    counts = {}
    for table in ("product_events", "view_activity_log", "auth_audit_log", "users"):
        counts[table] = int((await session.execute(text(f"SELECT count(*) FROM {table}"))).scalar())
    return counts


async def _index(factory, now: datetime) -> dict[str, Any]:
    """The indexer as production runs it: one step per transaction until caught up."""
    days: list[float] = []
    started = time.perf_counter()
    while True:
        t = time.perf_counter()
        async with factory() as session:
            done = await index.step(session, now=now)
            await session.commit()
        if not done:
            break
        days.append(time.perf_counter() - t)
    async with factory() as session:
        await session.execute(text("ANALYZE person_activity_daily"))
        await session.execute(text("ANALYZE people_daily_facets"))
        await session.commit()
        rollup = int((await session.execute(
            select(func.count()).select_from(PersonActivityDailyORM))).scalar())
    return {"steps": len(days), "total": time.perf_counter() - started, "days": days,
            "rollup_rows": rollup}


async def _measure(factory, fn: Callable[[AsyncSession], Awaitable[Any]], runs: int) -> dict:
    times = []
    result = None
    for _ in range(runs):
        analytics_cache.clear()
        async with factory() as session:
            t = time.perf_counter()
            result = await fn(session)
            times.append(time.perf_counter() - t)
    analytics_cache.clear()
    tracemalloc.start()
    async with factory() as session:
        await fn(session)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    times.sort()
    return {"p50": statistics.median(times), "p95": times[-1], "peak_mb": peak / 2**20,
            "result": result}


def _fmt(s: float) -> str:
    return f"{s * 1000:.0f} ms" if s < 10 else f"{s:.1f} s"


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--dsn", required=True)
    p.add_argument("--users", type=int, default=10_000)
    p.add_argument("--active", type=int, default=5_000)
    p.add_argument("--days", type=int, default=365)
    p.add_argument("--workspaces", type=int, default=100)
    p.add_argument("--views", type=int, default=5_000)
    p.add_argument("--big-members", type=int, default=2_000)
    p.add_argument("--events", type=int, default=12, help="Mean events per active person-day.")
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--skip-seed", action="store_true")
    p.add_argument("--skip-index", action="store_true")
    a = p.parse_args()

    engine = create_async_engine(a.dsn, pool_size=4)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    report: list[str] = ["# People analytics benchmark", ""]

    if not a.skip_seed:
        t = time.perf_counter()
        async with factory() as session:
            counts = await _seed(session, a, now)
        report += [f"Seeded in {_fmt(time.perf_counter() - t)}: "
                   + ", ".join(f"{k} {v:,}" for k, v in counts.items()), ""]
    if not a.skip_index:
        ix = await _index(factory, now)
        d = sorted(ix["days"])
        report += [
            "## Indexer backfill (one step per transaction, as production runs it)", "",
            f"- {ix['steps']} steps in {_fmt(ix['total'])}; rollup {ix['rollup_rows']:,} person-day rows",
            f"- per step: p50 {_fmt(statistics.median(d))}, p95 {_fmt(d[int(len(d) * .95) - 1])}, "
            f"max {_fmt(d[-1])}", "",
        ]

    async with factory() as session:
        heavy = (await session.execute(
            select(PersonActivityDailyORM.user_id, func.sum(PersonActivityDailyORM.n))
            .group_by(PersonActivityDailyORM.user_id)
            .order_by(func.sum(PersonActivityDailyORM.n).desc()).limit(1))).first()[0]
    yesterday = (now - timedelta(days=1)).date().isoformat()

    cases: list[tuple[str, Callable]] = []
    for days in (7, 30, 90, 365):
        cases.append((f"Roster, platform, {days}d (cold)",
                      lambda s, d=days: repo.people_doc(s, days=d, now=now)))
    for days in (30, 365):
        cases.append((f"Roster, big workspace, {days}d (cold)",
                      lambda s, d=days: repo.people_doc(s, days=d, now=now, workspace_id="ws_b0")))
        cases.append((f"Roster, big workspace, workspace lens, {days}d (cold)",
                      lambda s, d=days: repo.people_doc(s, days=d, now=now, workspace_id="ws_b0",
                                                        lens=repo.WORKSPACE)))

    async def cached_page(s, days=30):
        key = f"bench:{days}"
        doc = await analytics_cache.cached(key, lambda: repo.people_doc(s, days=days, now=now))
        # What the endpoint does per request: project for the reader, sort, slice, enrich.
        out = repo.redact_people(doc, type("V", (), {"privileged": True})())
        page = sorted(out["people"], key=lambda r: -r["actions"])[:24]
        return await repo.enrich_page(s, page, days=days, now=now, emails=True)

    cases += [
        ("Lines, 24 people, 30d", lambda s: repo.lines(s, [f"usr_b{i}" for i in range(24)], days=30, now=now)),
        ("Lines, 24 people, 365d", lambda s: repo.lines(s, [f"usr_b{i}" for i in range(24)], days=365, now=now)),
        ("Day panel, platform", lambda s: repo.scope_day(s, yesterday)),
        ("Day panel, big workspace", lambda s: repo.scope_day(s, yesterday, workspace_id="ws_b0")),
        ("Person page, heaviest person, 30d", lambda s: repo.person_doc(s, heavy, days=30, now=now)),
        ("Person page, heaviest person, 365d", lambda s: repo.person_doc(s, heavy, days=365, now=now)),
        ("Person calendar (365 days)", lambda s: repo.person_calendar(s, heavy, now=now)),
        ("Person feed, one page of 50", lambda s: repo.person_events(s, heavy, limit=50)),
    ]

    report += ["## Reads", "", "| Read | p50 | slowest | Python peak | Size |", "|---|---:|---:|---:|---|"]
    for label, fn in cases:
        m = await _measure(factory, fn, a.runs)
        res = m["result"]
        size = ""
        if isinstance(res, dict) and "people" in res:
            size = f"{len(res['people']):,} people, {len(json.dumps(res)) / 2**20:.1f} MB doc"
        elif isinstance(res, dict) and "lines" in res:
            size = f"{len(res['lines'])} lines × {len(res['buckets'])} periods"
        report.append(f"| {label} | {_fmt(m['p50'])} | {_fmt(m['p95'])} | {m['peak_mb']:.0f} MB | {size} |")

    # The warm path: a reader opening the People tab on a cached window.
    times = []
    for _ in range(max(3, a.runs)):
        async with factory() as session:
            await cached_page(session)
            t = time.perf_counter()
            await cached_page(session)
            times.append(time.perf_counter() - t)
    times.sort()
    report.append(f"| Roster page, 30d, cached (redact + sort + slice + enrich 24) | "
                  f"{_fmt(statistics.median(times))} | {_fmt(times[-1])} | — | |")
    print("\n".join(report))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
