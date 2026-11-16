"""Each process's snapshot of the setting rows (``services.settings.snapshot``): when it asks Redis,
when it reads the database, and what it serves when either is out of reach. The clock, the
generation and the loader are fakes."""
from __future__ import annotations

import asyncio
import logging
from typing import List, Optional

import pytest

from backend.app.services.settings.resolver import EnvReading, Row
from backend.app.services.settings.snapshot import GEN_CHECK_S, RELOAD_S, Snapshot


class _World:
    """The database's rows, Redis's generation, and a clock, as the snapshot sees them."""

    def __init__(self):
        self.now = 1000.0
        self.gen: Optional[str] = "1"            # None: Redis out of reach
        self.rows: List[Row] = []
        self.db_down = False
        self.loads: List[Optional[int]] = []
        self.checks = 0

    def clock(self) -> float:
        return self.now

    async def generation(self, domain: str) -> Optional[str]:
        assert domain == "versioned-graphs"
        self.checks += 1
        return self.gen

    async def loader(self, domain: str, after: Optional[int]) -> List[Row]:
        self.loads.append(after)
        if self.db_down:
            raise ConnectionError("the database is out of reach")
        return [r for r in self.rows if after is None or r.rev > after]

    def save(self, key: str, value, rev: int, scope: str = "platform", scope_id: str = "") -> None:
        """A save elsewhere: its row, and the generation it moved."""
        self.rows = [r for r in self.rows if (r.key, r.scope, r.scope_id) != (key, scope, scope_id)]
        self.rows.append(Row(key, scope, scope_id, value, rev=rev))
        if self.gen is not None:
            self.gen = str(int(self.gen) + 1)


@pytest.fixture
def world():
    w = _World()
    w.save("reads.mode", "in_place", rev=1)
    w.save("builds.perWorker", 2, rev=2)
    w.gen = "1"
    return w


def _snap(w: _World) -> Snapshot:
    return Snapshot("versioned-graphs", loader=w.loader, generation=w.generation, clock=w.clock)


def _values(rows) -> dict:
    return {key: r.value for (key, _scope, _sid), r in rows.items()}


async def test_the_first_read_loads_every_row_and_the_next_within_two_seconds_asks_nothing(world):
    snap = _snap(world)
    assert snap.current() == {}                       # before any read: the defaults apply
    assert _values(await snap.rows()) == {"reads.mode": "in_place", "builds.perWorker": 2}
    assert (world.loads, world.checks, snap.rev) == ([None], 1, 2)
    world.now += GEN_CHECK_S - 0.1
    world.save("reads.mode", "latest", rev=3)         # not seen yet: no check is due
    assert _values(await snap.rows())["reads.mode"] == "in_place"
    assert (world.loads, world.checks) == ([None], 1)
    assert _values(snap.current())["reads.mode"] == "in_place"


async def test_a_moved_generation_reloads_only_what_was_written_since(world):
    snap = _snap(world)
    await snap.rows()
    world.now += GEN_CHECK_S
    assert _values(await snap.rows())["reads.mode"] == "in_place"
    assert (world.loads, world.checks) == ([None], 2)           # asked; nothing moved
    world.save("reads.mode", "latest", rev=7)
    world.save("drafts.levels", "public_only", rev=8, scope="workspace", scope_id="ws_1")
    world.now += GEN_CHECK_S
    rows = await snap.rows()
    assert world.loads == [None, 2]                             # rev > 2, not every row again
    assert _values(rows) == {"reads.mode": "latest", "builds.perWorker": 2,
                             "drafts.levels": "public_only"}
    assert snap.rev == 8


async def test_a_strict_read_asks_at_once(world):
    snap = _snap(world)
    await snap.rows()
    world.save("drafts.levels", "private_only", rev=3)
    assert "drafts.levels" not in _values(await snap.rows())                 # not due yet
    assert _values(await snap.rows(strict=True))["drafts.levels"] == "private_only"
    assert (world.checks, world.loads) == (2, [None, 2])
    await snap.rows(strict=True)                                              # asks again
    assert (world.checks, world.loads) == (3, [None, 2])                     # nothing moved


async def test_without_redis_the_rows_are_read_every_thirty_seconds(world):
    snap = _snap(world)
    await snap.rows()
    world.gen = None
    world.save("reads.mode", "latest", rev=3)
    world.now += RELOAD_S - 1
    assert _values(await snap.rows())["reads.mode"] == "in_place"
    assert world.loads == [None]
    world.now += GEN_CHECK_S                          # the next check, past 30 s
    assert _values(await snap.rows())["reads.mode"] == "latest"
    assert world.loads == [None, 2]
    world.save("reads.mode", "in_place", rev=4)                # a strict read reads at once
    assert _values(await snap.rows(strict=True))["reads.mode"] == "in_place"
    assert world.loads == [None, 2, 3]


async def test_every_thirty_seconds_anyway_when_a_save_could_not_move_the_generation(world):
    snap = _snap(world)
    await snap.rows()
    world.rows.append(Row("reads.mode", "workspace", "ws_1", "latest", rev=5))   # gen unmoved
    world.now += RELOAD_S - 1
    assert len(await snap.rows()) == 2
    world.now += GEN_CHECK_S
    assert len(await snap.rows()) == 3 and world.loads == [None, 2]


async def test_with_the_database_down_the_last_rows_keep_serving(world, caplog):
    snap = _snap(world)
    await snap.rows()
    world.db_down = True
    world.save("reads.mode", "latest", rev=3)
    world.now += GEN_CHECK_S
    with caplog.at_level(logging.WARNING, logger="backend.app.services.settings.snapshot"):
        assert _values(await snap.rows())["reads.mode"] == "in_place"
    assert "could not be read" in caplog.text and "keeping the last rows read" in caplog.text
    assert world.loads == [None, 2]
    for _ in range(5):                                # no read of the database for 30 s
        world.now += GEN_CHECK_S
        await snap.rows(strict=True)
    assert world.loads == [None, 2]
    world.db_down = False
    world.now += RELOAD_S
    assert _values(await snap.rows())["reads.mode"] == "latest"
    assert world.loads == [None, 2, 2]


async def test_with_the_database_down_from_the_start_the_defaults_apply(world):
    world.db_down = True
    snap = _snap(world)
    assert await snap.rows() == {} and snap.current() == {}
    world.now += GEN_CHECK_S
    await snap.rows()
    assert world.loads == [None]                      # retried only after 30 s
    world.db_down = False
    world.now += RELOAD_S
    assert len(await snap.rows()) == 2 and world.loads == [None, None]


async def test_readable_says_whether_the_rows_are_the_databases_as_last_asked(world):
    """For a setting the registry marks ``unreadable="skip"``: a pass acts on it only then."""
    snap = _snap(world)
    assert snap.readable is False                     # nothing read yet: the defaults serve
    await snap.rows()
    assert snap.readable is True
    world.db_down = True
    world.now += RELOAD_S
    await snap.rows()
    assert snap.readable is False and snap.current()  # the last rows serve, and it says so
    world.now += GEN_CHECK_S
    await snap.rows(strict=True)
    assert snap.readable is False                     # not read again for 30 s
    world.db_down = False
    world.now += RELOAD_S
    await snap.rows()
    assert snap.readable is True
    down = _snap(world)
    world.db_down = True
    await down.rows()
    assert down.readable is False                     # never read: the defaults, unreadable


async def test_callers_at_once_share_one_check(world):
    snap = _snap(world)
    await snap.rows()
    world.now += GEN_CHECK_S
    world.save("reads.mode", "latest", rev=3)
    await asyncio.gather(*(snap.rows() for _ in range(20)))
    assert (world.checks, world.loads) == (2, [None, 2])


def test_the_environment_is_read_as_the_apps_config_parsed_it(monkeypatch):
    """The value config holds (so a change to config shows), whether the variable is set at all,
    and the raw text of one config doesn't read; nothing for a variable the registry doesn't
    name."""
    from backend.app.config.settings_types import DeploymentFact
    from backend.app.services.settings.snapshot import env_reader
    from backend.app.services.versioning import config
    from backend.tests.test_settings_resolver import REGISTRY

    read = env_reader(REGISTRY, [DeploymentFact(env="GRAPHVER_PROJECTION_CONCURRENCY",
                                                label="", category="builds", means="",
                                                attr="PROJECTION_CONCURRENCY"),
                                 DeploymentFact(env="GRAPHVER_SOMETHING_RAW", label="",
                                                category="builds", means="")])
    monkeypatch.delenv("GRAPHVER_READ_MODE", raising=False)
    monkeypatch.setattr(config, "READ_MODE", "in_place")
    assert read("GRAPHVER_READ_MODE") == EnvReading("GRAPHVER_READ_MODE", "in_place", False)
    monkeypatch.setenv("GRAPHVER_PROJECTION_CONCURRENCY", "3")
    monkeypatch.setattr(config, "PROJECTION_CONCURRENCY", 3)
    assert read("GRAPHVER_PROJECTION_CONCURRENCY") == EnvReading(
        "GRAPHVER_PROJECTION_CONCURRENCY", 3, True)
    monkeypatch.setenv("GRAPHVER_SOMETHING_RAW", "7")
    assert read("GRAPHVER_SOMETHING_RAW") == EnvReading("GRAPHVER_SOMETHING_RAW", "7", True)
    assert read("GRAPHVER_NOT_IN_THE_REGISTRY") is None
