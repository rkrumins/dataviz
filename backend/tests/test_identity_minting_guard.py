"""Every graph entity id the platform mints comes from one place: ``versioning/ids.py``.

New nodes and edges are named ``urn:uuid:<uuid>`` by ``new_entity_id`` (UUIDv7) or, for a request
that must name the same entities when sent again, ``derived_entity_id`` (UUIDv5). Ids minted any
other way drifted into a dozen shapes (``urn:synodic:<source>:<type>:<hex>``, ``ent_<ulid>``,
``ent_<sha256>``, a 48-bit ``edge-<hex>``, ``contains-<parent>-<child>``); this test fails the
build the moment a write path mints one again.

Ids a path DERIVES FROM ITS SOURCE are not minted and stay as they are — a provider's urn, a
sync's ``sync:<urn>``, a bootstrap's ``<src>|<TYPE>|<tgt>``, a package seed's stable id for a
line with none — because that is how a re-sync or a resumed seed finds what it made. They are
listed below, each with why.
"""
import pathlib
import re

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# How an entity id was minted before the minter.
_MINTS = {
    "make_urn(": re.compile(r"\bmake_urn\("),
    'prefixed_id("ent")': re.compile(r"""\bprefixed_id\(\s*["']ent["']"""),
    'stable_prefixed_id("ent", …)': re.compile(r"""\bstable_prefixed_id\(\s*["']ent["']"""),
    'f"edge-…"': re.compile(r"""\bf["']edge-\{"""),
    'f"contains-…"': re.compile(r"""\bf["']contains-\{"""),
    'f"ent_…"': re.compile(r"""\bf["']ent_\{"""),
}

# (path relative to app/, mint) → why it is allowed.
_ALLOWED = {
    ("ontology/urn.py", "make_urn("): "its definition: no write path calls it",
    ("services/versioning/package_seed.py", 'stable_prefixed_id("ent", …)'):
        "a package line with no entity id, keyed by its place in the upload: a resumed seed "
        "derives the same id again",
}


def test_no_write_path_mints_an_entity_id_outside_the_minter():
    found = []
    for path in sorted(_APP.rglob("*.py")):
        rel = path.relative_to(_APP).as_posix()
        if rel == "services/versioning/ids.py":
            continue
        text = path.read_text(encoding="utf-8")
        for name, pattern in _MINTS.items():
            if any(m for m in pattern.finditer(text)) and (rel, name) not in _ALLOWED:
                lines = [i + 1 for i, line in enumerate(text.splitlines()) if pattern.search(line)]
                found.append(f"app/{rel}:{lines} mints with {name}")
    assert not found, ("mint entity ids with new_entity_id() / derived_entity_id() "
                       "(backend/app/services/versioning/ids.py):\n" + "\n".join(found))


def test_the_allow_list_has_nothing_stale():
    """An allowed mint that is gone from its file is dropped from the list too."""
    for (rel, name), _why in _ALLOWED.items():
        text = (_APP / rel).read_text(encoding="utf-8")
        assert _MINTS[name].search(text), f"app/{rel} no longer mints with {name}: drop it"
