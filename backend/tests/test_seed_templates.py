"""The built-in layout templates: upserted by key, never resurrected or un-hidden.

The old seeder inserted four templates only when NO template rows existed — so
deleting them all brought every one back on the next boot, and a change to a
seed never reached a database that already had them.
"""
import json

from sqlalchemy import select

from backend.app.db.models import ContextModelORM, LayoutTemplateVersionORM
from backend.app.db.repositories import layout_template_repo
from backend.app.db.seed_templates import BUILTIN_TEMPLATES, seed_templates


async def _builtins(session):
    rows = (await session.execute(
        select(ContextModelORM).where(ContextModelORM.system_key.isnot(None))
    )).scalars().all()
    return {r.system_key: r for r in rows}


async def test_every_builtin_is_an_organization_template(db_session):
    await seed_templates(db_session)
    rows = await _builtins(db_session)
    assert set(rows) == {t["system_key"] for t in BUILTIN_TEMPLATES}
    for row in rows.values():
        assert row.is_template and row.visibility == "enterprise" and row.workspace_id is None


async def test_seeding_again_changes_nothing(db_session):
    await seed_templates(db_session)
    await seed_templates(db_session)
    count = len((await db_session.execute(
        select(ContextModelORM).where(ContextModelORM.is_template.is_(True))
    )).scalars().all())
    assert count == len(BUILTIN_TEMPLATES)
    # Each its v1, and no second version for layers that did not change.
    versions = (await db_session.execute(select(LayoutTemplateVersionORM))).scalars().all()
    assert sorted(v.version for v in versions) == [1] * len(BUILTIN_TEMPLATES)


async def test_an_upgrade_refreshes_content_but_keeps_an_admins_choices(db_session):
    await seed_templates(db_session)
    rows = await _builtins(db_session)
    medallion, mesh = rows["medallion"], rows["data-mesh"]
    medallion.name = "Something an old version shipped"
    medallion.layers_config = "[]"
    mesh.is_active = False                    # hidden for everyone
    mesh.deleted_at = "2026-10-01T00:00:00Z"  # and an Undo window someone might use
    await db_session.flush()

    await seed_templates(db_session)
    rows = await _builtins(db_session)
    seed = next(t for t in BUILTIN_TEMPLATES if t["system_key"] == "medallion")
    assert rows["medallion"].name == "Medallion"
    assert json.loads(rows["medallion"].layers_config) == seed["layers"]
    assert rows["data-mesh"].is_active is False
    assert rows["data-mesh"].deleted_at == "2026-10-01T00:00:00Z"
    # New layers are a new version — views built from v1 are offered the change.
    assert rows["medallion"].version == 2
    kept = await layout_template_repo.list_versions(db_session, rows["medallion"].id)
    assert [v.version for v in kept] == [2, 1]
    assert kept[0].change_note == "Updated with this release." and kept[0].created_by is None
    assert rows["data-mesh"].version == 1


async def test_builtin_logical_nodes_carry_the_type_the_canvas_needs():
    for tmpl in BUILTIN_TEMPLATES:
        for layer in tmpl["layers"]:
            for node in layer.get("logicalNodes", []):
                assert node.get("type") in ("container", "system", "group"), (tmpl["system_key"], node)
