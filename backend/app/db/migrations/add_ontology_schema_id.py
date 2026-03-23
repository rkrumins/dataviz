"""
Add schema_id, revision, created_by, updated_by to ontologies table.
Run on startup or manually.
"""
import sqlite3
import logging

logger = logging.getLogger(__name__)


def migrate(db_path: str):
    """Add new columns to ontologies table if they don't exist."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Check existing columns
    cursor.execute("PRAGMA table_info(ontologies)")
    existing_cols = {row[1] for row in cursor.fetchall()}

    if "schema_id" not in existing_cols:
        logger.info("Adding schema_id column to ontologies")
        cursor.execute("ALTER TABLE ontologies ADD COLUMN schema_id TEXT NOT NULL DEFAULT ''")
        # Backfill: group by name, assign same schema_id per group
        cursor.execute("SELECT id, name FROM ontologies ORDER BY name, version")
        rows = cursor.fetchall()
        name_to_schema = {}
        for row_id, name in rows:
            if name not in name_to_schema:
                name_to_schema[name] = row_id  # first version's id becomes schema_id
            cursor.execute("UPDATE ontologies SET schema_id = ? WHERE id = ?", (name_to_schema[name], row_id))
        logger.info(f"Backfilled schema_id for {len(rows)} ontologies")

    if "revision" not in existing_cols:
        logger.info("Adding revision column to ontologies")
        cursor.execute("ALTER TABLE ontologies ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")

    if "created_by" not in existing_cols:
        logger.info("Adding created_by column to ontologies")
        cursor.execute("ALTER TABLE ontologies ADD COLUMN created_by TEXT DEFAULT NULL")

    if "updated_by" not in existing_cols:
        logger.info("Adding updated_by column to ontologies")
        cursor.execute("ALTER TABLE ontologies ADD COLUMN updated_by TEXT DEFAULT NULL")

    conn.commit()
    conn.close()
