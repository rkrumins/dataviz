"""The entityScope backfill migration must agree with the rule it replaces.

The migration carries a FROZEN copy of `layout_config.derive_entity_scope`
rather than importing it, because a migration that imports app code breaks
every not-yet-upgraded environment the day that module moves.

The cost of freezing is drift: change the live rule and the copy silently keeps
answering the old way, so an environment upgrading later gets different values
from one that upgraded today. This pins the two together. If it fails, that is
not automatically a bug — it means the rule changed, and someone has to decide
whether the already-shipped migration should have behaved differently.
"""
import importlib.util
from pathlib import Path

import pytest

from backend.app.services.layout_config import derive_entity_scope

_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic" / "versions" / "20260920_1200_view_entity_scope.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("_scope_backfill", _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mig = _load_migration()


def _frozen(config: dict) -> str:
    """What the migration would write for this config."""
    content = config.get("content") if isinstance(config, dict) else None
    explicit = content.get("entityScope") if isinstance(content, dict) else None
    if explicit in ("all", "curated"):
        return explicit
    return "curated" if mig._has_any_assignment(config) else "all"


def _reference(layout: dict) -> dict:
    return {"layout": {"type": "reference", "referenceLayout": layout}}


CASES = {
    "empty layout": _reference({"layers": [], "assignments": {}}),
    "top-level assignments": _reference(
        {"layers": [], "assignments": {"urn:a": {"layerId": "l1"}}}),
    "assignment value is not a dict": _reference(
        {"layers": [], "assignments": {"urn:a": "nope"}}),
    # The three legacy shapes `_normalize` up-converts from — the branches a
    # hand-written copy is most likely to get wrong.
    "legacy per-layer entityAssignments": _reference(
        {"layers": [{"id": "l1", "entityAssignments": [{"urn": "urn:a"}]}], "assignments": {}}),
    "legacy entityAssignments, entityId fallback": _reference(
        {"layers": [{"id": "l1", "entityAssignments": [{"entityId": "urn:a"}]}], "assignments": {}}),
    "exact-urn layer rule": _reference(
        {"layers": [{"id": "l1", "rules": [{"urnPattern": "urn:a"}]}], "assignments": {}}),
    "glob rule is not an assignment": _reference(
        {"layers": [{"id": "l1", "rules": [{"urnPattern": "urn:*"}]}], "assignments": {}}),
    "single-char glob is not an assignment": _reference(
        {"layers": [{"id": "l1", "rules": [{"urnPattern": "urn:?"}]}], "assignments": {}}),
    "type rule carries no urnPattern": _reference(
        {"layers": [{"id": "l1", "entityTypes": ["domain"],
                     "rules": [{"entityTypes": ["domain"]}]}], "assignments": {}}),
    "logicalNode exact rule": _reference(
        {"layers": [{"id": "l1", "logicalNodes": [
            {"id": "n1", "rules": [{"urnPattern": "urn:a"}]}]}], "assignments": {}}),
    "deeply nested logicalNode rule": _reference(
        {"layers": [{"id": "l1", "logicalNodes": [
            {"id": "n1", "children": [
                {"id": "n2", "children": [
                    {"id": "n3", "rules": [{"urnPattern": "urn:a"}]}]}]}]}], "assignments": {}}),
    "referenceLayout at the legacy top level": {
        "referenceLayout": {"layers": [], "assignments": {"urn:a": {"layerId": "l1"}}}},
    "explicit all beats existing assignments": {
        "content": {"entityScope": "all"},
        **_reference({"layers": [], "assignments": {"urn:a": {"layerId": "l1"}}})},
    "explicit curated with no assignments": {
        "content": {"entityScope": "curated"},
        **_reference({"layers": [], "assignments": {}})},
    "a nonsense explicit value is ignored": {
        "content": {"entityScope": "public"},
        **_reference({"layers": [], "assignments": {}})},
    "no layout at all": {"content": {}},
    "layers is not a list": _reference({"layers": "nope", "assignments": {}}),
    "layer is not a dict": _reference({"layers": ["nope"], "assignments": {}}),
    "graph layout": {"layout": {"type": "graph"}},
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_frozen_copy_matches_the_live_rule(name):
    config = CASES[name]
    assert _frozen(config) == derive_entity_scope(config), (
        f"the migration's frozen rule and derive_entity_scope disagree on {name!r}"
    )


def test_a_scope_already_set_is_left_untouched():
    """Idempotency at the row level: a re-run must not rewrite real settings."""
    for scope in ("all", "curated"):
        config = {"content": {"entityScope": scope},
                  **_reference({"layers": [], "assignments": {"urn:a": {"layerId": "l1"}}})}
        assert _frozen(config) == scope


def test_the_migration_declares_the_expected_parent():
    """A backfill on the wrong parent silently never runs for someone."""
    assert mig.revision == "20260920_1200_view_entity_scope"
    assert mig.down_revision == "20260916_1100_property_key_count"
    # Revision ids longer than 32 chars make a brand-new environment
    # unbuildable while migrated ones keep working, so it hides.
    assert len(mig.revision) <= 32
