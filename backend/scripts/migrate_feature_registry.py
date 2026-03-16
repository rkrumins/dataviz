"""
Migration: create feature_categories, feature_definitions, and feature_flags tables.
Schema and categories are stored in the DB; this script only creates tables.
Seed data is applied at app startup by seed_feature_registry.

Run once against the target database:
    python backend/scripts/migrate_feature_registry.py

Idempotent: skips tables that already exist.
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "nexus_core.db"


def main() -> None:
    if not DB_PATH.exists():
        print(f"[migrate_feature_registry] Database not found at {DB_PATH}. Skipping.")
        return

    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    created = []

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_categories'")
    if not cur.fetchone():
        cur.execute("""
            CREATE TABLE feature_categories (
                id TEXT NOT NULL PRIMARY KEY,
                label TEXT NOT NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            )
        """)
        created.append("feature_categories")

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_definitions'")
    if not cur.fetchone():
        cur.execute("""
            CREATE TABLE feature_definitions (
                key TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                category_id TEXT NOT NULL,
                type TEXT NOT NULL,
                default_value TEXT NOT NULL,
                user_overridable INTEGER NOT NULL DEFAULT 0,
                options TEXT,
                help_url TEXT,
                admin_hint TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                deprecated INTEGER NOT NULL DEFAULT 0
            )
        """)
        created.append("feature_definitions")

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_flags'")
    if not cur.fetchone():
        cur.execute("""
            CREATE TABLE feature_flags (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                config TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            )
        """)
        created.append("feature_flags")

    conn.commit()
    if created:
        print("[migrate_feature_registry] Created tables:", ", ".join(created))
    else:
        print("[migrate_feature_registry] All feature registry tables already exist. Nothing to do.")
    conn.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
