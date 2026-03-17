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
                sort_order INTEGER NOT NULL DEFAULT 0,
                preview INTEGER NOT NULL DEFAULT 1,
                preview_label TEXT,
                preview_footer TEXT
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
                deprecated INTEGER NOT NULL DEFAULT 0,
                implemented INTEGER NOT NULL DEFAULT 0
            )
        """)
        created.append("feature_definitions")

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_flags'")
    if not cur.fetchone():
        cur.execute("""
            CREATE TABLE feature_flags (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                config TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0
            )
        """)
        created.append("feature_flags")

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_registry_meta'")
    if not cur.fetchone():
        cur.execute("""
            CREATE TABLE feature_registry_meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                experimental_notice_enabled INTEGER NOT NULL DEFAULT 1,
                experimental_notice_title TEXT,
                experimental_notice_message TEXT,
                updated_at TEXT NOT NULL DEFAULT ''
            )
        """)
        created.append("feature_registry_meta")
        # Insert default row (same defaults as backend/app/config/features.py)
        cur.execute(
            """
            INSERT INTO feature_registry_meta (id, experimental_notice_enabled, experimental_notice_title, experimental_notice_message, updated_at)
            VALUES (1, 1, 'Early access', ?, datetime('now'))
            """,
            (
                "This area is in early access. Your choices are saved, but we're still wiring these options "
                "into the rest of the product. You may not see behaviour changes until a future update.",
            ),
        )

    conn.commit()
    if created:
        print("[migrate_feature_registry] Created tables:", ", ".join(created))
    else:
        print("[migrate_feature_registry] All feature registry tables already exist. Nothing to do.")
    conn.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
