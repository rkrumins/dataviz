"""The built-in layout templates: upserted by key, never resurrected or un-hidden.

The old seeder inserted four templates only when NO template rows existed — so
deleting them all brought every one back on the next boot, and a change to a
seed never reached a database that already had them.
"""
import json

from sqlalchemy import select

from backend.app.db.models import ContextModelORM
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


async def test_builtin_logical_nodes_carry_the_type_the_canvas_needs():
    for tmpl in BUILTIN_TEMPLATES:
        for layer in tmpl["layers"]:
            for node in layer.get("logicalNodes", []):
                assert node.get("type") in ("container", "system", "group"), (tmpl["system_key"], node)
