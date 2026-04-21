-- ══════════════════════════════════════════════════════════════════════
-- Synodic — Postgres Role Bootstrap
-- ══════════════════════════════════════════════════════════════════════
-- Runs once when the Postgres data directory is empty (docker-entrypoint).
-- Idempotent: safe to re-run against an existing cluster (e.g. after a
-- volume restore or `./dev.sh repair`).
--
-- Note: POSTGRES_USER/POSTGRES_DB already provisions the role + db via
-- the docker-entrypoint. This script is the defensive safety net for
-- backup-restore scenarios or partial-init failures.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synodic') THEN
        CREATE ROLE synodic LOGIN PASSWORD 'synodic';
    END IF;
END
$$;

SELECT 'CREATE DATABASE synodic OWNER synodic'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'synodic')\gexec

GRANT ALL PRIVILEGES ON DATABASE synodic TO synodic;
