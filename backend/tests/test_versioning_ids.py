"""Entity ids are one standard: ``urn:uuid:<uuid>``, RFC 9562.

A new entity's id is a UUIDv7 — time-ordered, so inserts keyed by it stay sequential at millions
of rows — and an id a request must mint again identically is a name-based UUIDv5. Nothing about
what an id names is in it.
"""
import re
import time
import uuid

from backend.app.services.versioning import ids
from backend.app.services.versioning.ids import (
    ENTITY_NAMESPACE, derived_entity_id, new_entity_id, uuid7, uuid_urn,
)

_CANONICAL = re.compile(r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def test_a_uuid7_carries_its_version_variant_and_millisecond():
    before = int(time.time() * 1000)
    u = uuid7()
    after = int(time.time() * 1000)
    assert u.version == 7 and u.variant == uuid.RFC_4122
    assert before <= u.int >> 80 <= after + 1          # the 48-bit Unix-millisecond timestamp


def test_uuid7s_sort_in_mint_order_and_never_repeat():
    minted = [uuid7() for _ in range(200_000)]        # many share a millisecond
    assert minted == sorted(minted, key=lambda u: u.int)
    assert len(set(minted)) == len(minted)
    assert all(u.version == 7 for u in minted[::997])


def test_a_clock_that_steps_back_keeps_the_order(monkeypatch):
    # The minter's memory of its last millisecond, restored after: later mints in this process
    # must not carry on from a clock set far ahead here.
    monkeypatch.setattr(ids, "_u7_last_ts", -1)
    monkeypatch.setattr(ids, "_u7_last_rand", 0)
    first = uuid7(10_000_000_000_000)
    later = uuid7(9_000_000_000_000)                  # the clock went back a long way
    assert later.int > first.int
    assert uuid7(20_000_000_000_000).int >> 80 == 20_000_000_000_000


def test_a_new_entity_id_is_a_canonical_urn_uuid():
    eid = new_entity_id()
    assert _CANONICAL.match(eid), eid
    assert uuid.UUID(eid[len("urn:uuid:"):]).version == 7


def test_a_derived_id_is_the_same_for_the_same_kind_and_seed_only():
    a = derived_entity_id("node", "g/br/alice/ref:urn:staged:Table:abc")
    assert a == derived_entity_id("node", "g/br/alice/ref:urn:staged:Table:abc")
    assert a != derived_entity_id("edge", "g/br/alice/ref:urn:staged:Table:abc")
    assert a != derived_entity_id("node", "g/br/bob/ref:urn:staged:Table:abc")
    assert _CANONICAL.match(a)
    parsed = uuid.UUID(a[len("urn:uuid:"):])
    assert parsed.version == 5
    assert parsed == uuid.uuid5(ENTITY_NAMESPACE, "node/g/br/alice/ref:urn:staged:Table:abc")


def test_uuid_urn_takes_any_case_and_gives_the_canonical_form():
    u = uuid7()
    assert uuid_urn(f"URN:UUID:{str(u).upper()}") == f"urn:uuid:{u}"
    assert uuid_urn(f"  urn:uuid:{u}  ") == f"urn:uuid:{u}"
    for not_one in (str(u), f"urn:uuid:{{{u}}}", f"urn:uuid:{u.hex}", f"urn:uuid:{str(u)[:-1]}g",
                    "urn:synodic:manual:table:3f9a", "urn:li:dataset:x", "", None, 7):
        assert uuid_urn(not_one) is None, not_one
