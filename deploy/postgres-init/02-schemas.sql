-- ══════════════════════════════════════════════════════════════════════
-- Synodic — Schema Bootstrap
-- ══════════════════════════════════════════════════════════════════════
-- Schemas inside the synodic database. Connect as synodic so ownership
-- lands on the app role. Idempotent (IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════════

\connect synodic synodic

CREATE SCHEMA IF NOT EXISTS aggregation AUTHORIZATION synodic;

GRANT ALL ON SCHEMA public TO synodic;
GRANT ALL ON SCHEMA aggregation TO synodic;
