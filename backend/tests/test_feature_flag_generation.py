"""The feature switches' generation (``features:gen``): a switch flipped in one process is seen by
every other within about two seconds, not after the flag cache's 30.

Pins:
- A cache still fresh by its TTL asks Redis at most every two seconds; when a save moved the
  generation, it reads the flags again.
- With Redis out of reach, the TTL bounds it as before, and a save doesn't fail over it.
- A cache filled without a generation (as tests prime it) is aged by its TTL alone.
- PATCH and deprecate move the generation once their change has committed.

Two services stand for two processes, over one fake Redis and one fake clock, each reading the
flags from the same fake database.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

from httpx import AsyncClient

from backend.app.api.v1.endpoints import features as features_api
from backend.app.services.feature_flags import GEN_KEY, FeatureFlagService

SWITCH = "residencyEnabled"


class _Redis:
    def __init__(self):
        self.values, self.down, self.gets = {}, False, 0

    async def get(self, key):
        self.gets += 1
        if self.down:
            raise ConnectionError("Redis is out of reach")
        return self.values.get(key)

    async def incr(self, key):
        if self.down:
            raise ConnectionError("Redis is out of reach")
        self.values[key] = int(self.values.get(key, 0)) + 1
        return self.values[key]


class _Database:
    """The flags as the database holds them: one switch, off until a save turns it on."""

    def __init__(self):
        self.on, self.reads = False, 0

    async def execute(self, statement):
        if "feature_definitions" in str(statement):
            self.reads += 1
            return [(SWITCH, "false")]
        row = SimpleNamespace(config=json.dumps({SWITCH: self.on}), version=1, updated_at="now")
        return SimpleNamespace(scalar_one_or_none=lambda: row)


class _World:
    def __init__(self):
        self.now, self.redis, self.db = 1000.0, _Redis(), _Database()

    def process(self) -> FeatureFlagService:
        return FeatureFlagService(redis=lambda: self.redis, clock=lambda: self.now)


async def test_a_switch_flipped_elsewhere_is_seen_within_two_seconds():
    w = _World()
    saver, reader = w.process(), w.process()
    assert await reader.is_enabled(SWITCH, w.db) is False
    w.db.on = True                                   # an administrator turns it on, in `saver`
    saver.invalidate()
    assert await saver.announce() is True and w.redis.values[GEN_KEY] == 1
    w.now += 1.0
    gets = w.redis.gets
    assert await reader.is_enabled(SWITCH, w.db) is False, "checked less than 2 s ago"
    assert w.redis.gets == gets and w.db.reads == 1
    w.now += 1.0
    assert await reader.is_enabled(SWITCH, w.db) is True
    assert w.db.reads == 2
    w.now += 5.0                                    # nothing moved since: no read
    assert await reader.is_enabled(SWITCH, w.db) is True and w.db.reads == 2


async def test_without_redis_the_ttl_bounds_it_and_a_save_still_goes_through():
    w = _World()
    w.redis.down = True
    saver, reader = w.process(), w.process()
    assert await reader.is_enabled(SWITCH, w.db) is False
    w.db.on = True
    assert await saver.announce() is False           # best effort: the save is not failed
    w.now += 29.0
    assert await reader.is_enabled(SWITCH, w.db) is False and w.db.reads == 1
    w.now += 1.0
    assert await reader.is_enabled(SWITCH, w.db) is True and w.db.reads == 2


async def test_a_cache_filled_without_a_generation_is_aged_by_its_ttl_alone():
    """As the test harness primes it: no Redis is asked, whatever the generation says."""
    w = _World()
    reader = w.process()
    reader._cache, reader._cache_ts = {SWITCH: False}, w.now
    w.redis.values[GEN_KEY] = 7
    w.now += 10.0
    assert await reader.is_enabled(SWITCH, w.db) is False
    assert w.redis.gets == 0 and w.db.reads == 0


async def _seeded(db_session) -> None:
    from backend.app.db.seed_feature_registry import seed_feature_flags, seed_feature_registry

    await seed_feature_registry(db_session)
    await seed_feature_flags(db_session)
    await db_session.commit()


def _watch(monkeypatch, db_session) -> list:
    """What the request did, in order: its commits, and the generation moving."""
    done = []
    commit = db_session.commit

    async def committed():
        done.append("commit")
        await commit()

    async def announce():
        done.append("announce")
        return True

    monkeypatch.setattr(db_session, "commit", committed)
    monkeypatch.setattr(features_api._flag_service, "announce", announce)
    return done


async def test_a_patch_moves_the_generation_once_it_has_committed(test_client: AsyncClient,
                                                                 db_session, monkeypatch):
    await _seeded(db_session)
    version = (await test_client.get("/api/v1/admin/features")).json()["version"]
    done = _watch(monkeypatch, db_session)
    resp = await test_client.patch("/api/v1/admin/features",
                                   json={"version": version, SWITCH: True})
    assert resp.status_code == 200, resp.text
    assert done[-2:] == ["commit", "announce"] and done.count("announce") == 1


async def test_a_deprecation_moves_the_generation_once_it_has_committed(test_client: AsyncClient,
                                                                       db_session, monkeypatch):
    await _seeded(db_session)
    done = _watch(monkeypatch, db_session)
    resp = await test_client.post(f"/api/v1/admin/features/definitions/{SWITCH}/deprecate")
    assert resp.status_code == 200, resp.text
    assert done[-2:] == ["commit", "announce"] and done.count("announce") == 1
