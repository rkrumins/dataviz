#!/usr/bin/env python3
"""Generate the configuration reference, ``docs/CONFIGURATION.md``, from the backend source.

The page lists every environment variable the backend reads: its default, what it
is for, and which files read it. It is generated so it cannot drift from the code:
CI runs this script with ``--check`` and fails when the committed page differs from
what the code says now.

Pure ``ast`` and ``re``: nothing under ``backend/`` is imported, so this runs on a
bare Python with no dependencies installed and writes the same page on every Python
version.

What counts as a setting
    ``*.getenv(name, ...)`` (``__import__("os").getenv`` included),
    ``*.environ.get / .setdefault / .pop(name, ...)`` and ``*.environ[name]`` in
    ``backend/**/*.py``, except ``backend/tests``, ``test_*.py`` and ``conftest.py``.
    An assignment ``os.environ[name] = value`` counts too: the processes that make
    one use it to give ``name`` a default of their own.

Names that are not string literals
    Resolved where the code allows: a module constant, a local, a loop over a
    literal tuple or dict and, when the name is a parameter of the enclosing
    function, every call to that "env helper" (same module, or imported with
    ``from ... import``), e.g. ``_env_int("X", 5, 1, 10)``. Whatever stays dynamic
    inside an f-string becomes a placeholder, and the name goes in the "Name
    patterns" table (``REDIS_<ROLE>_TLS_ENABLED``). Anything left is reported on
    stderr as unresolved.

Defaults
    Literal defaults are shown, including ``str(<literal>)`` and resolved constants;
    anything else is "computed". A read with no default whose empty result the next
    statement replaces (``raw = os.getenv(X)`` then ``if not raw: return Y``) takes
    ``Y``. When call sites disagree, every default is listed. A secret's default is
    never shown, and credentials inside a URL default are masked.

Descriptions, in order of precedence
    1. ``NOTES`` below, hand-written for the settings an operator must get right.
    2. The inline comment on the variable's line in ``.env.example`` or
       ``.env.prod.example`` (with its indented continuation lines), first sentence.
    3. The first sentence of the comment block directly above the variable there.
    A variable with none of these is listed under its section's "Internal tuning".
    Python comments and line numbers are never used: editing either would fail the
    check without changing any setting.

Usage, from the repository root::

    python3 backend/scripts/export_config_reference.py           # write docs/CONFIGURATION.md
    python3 backend/scripts/export_config_reference.py --check   # CI: exit 1 with a diff on drift
    python3 backend/scripts/export_config_reference.py --stdout  # print the page instead

Every run also reports on stderr: the reads it could not resolve, and keys in the
``.env`` templates that nothing reads.
"""
from __future__ import annotations

import argparse
import ast
import difflib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
OUTPUT = REPO_ROOT / "docs" / "CONFIGURATION.md"
ENV_TEMPLATES = (".env.example", ".env.prod.example")
SCRIPT = "backend/scripts/export_config_reference.py"
REGENERATE = f"python3 {SCRIPT}"
TAG = "[export_config_reference]"

# --------------------------------------------------------------------------- #
# Hand-written content                                                         #
# --------------------------------------------------------------------------- #

#: Descriptions for the settings an operator must get right, each written from the
#: code that reads it. They take precedence over the ``.env`` template comments. The
#: second item, when present, is the setting's row in "Must set in production"
#: (rows appear in this order, so ``ENV`` leads).
NOTES: dict[str, tuple[str, str | None]] = {
    "ENV": (
        "Deployment type. `production` (or `prod`) turns on the safeguards listed under "
        "[Must set in production](#must-set-in-production); any other value relaxes them for "
        "local work.",
        "`production`. Without it, none of the safeguards above apply.",
    ),
    "JWT_SECRET_KEY": (
        "Key that signs session tokens. Required in every environment: at least 32 characters, "
        "and not one of the example values published in this repository, or the API will not "
        "start.",
        "A random value of at least 32 characters, unique to this environment, for example from "
        "`python -c 'import secrets; print(secrets.token_urlsafe(48))'`.",
    ),
    "MANAGEMENT_DB_URL": (
        "Address of the management database: a Postgres URL starting with "
        "`postgresql+asyncpg://`. Unset, processes fall back to the local development database.",
        "The URL of your production Postgres database.",
    ),
    "REDIS_URL": (
        "The coordination Redis as one URL (`redis://`, or `rediss://` for TLS). The job bus, "
        "session revocation and shared rate limits use it; `REDIS_STREAMS_*` settings override "
        "its parts. With the default `AGGREGATION_DISPATCH_MODE`, setting it also makes the API "
        "hand aggregation jobs to the worker fleet.",
        "Your coordination Redis, as this URL or the `REDIS_STREAMS_*` settings. The job bus, "
        "session revocation and shared rate limits use it.",
    ),
    "CREDENTIAL_ENCRYPTION_KEY": (
        "Fernet key that encrypts the credentials stored for data sources and identity "
        "providers. Unset, credentials are stored unencrypted, except with `ENV=production`, "
        "where saving one fails instead.",
        "A Fernet key, for example from `python -c \"from cryptography.fernet import Fernet; "
        "print(Fernet.generate_key().decode())\"`. Keep it safe: stored credentials cannot be "
        "read without it.",
    ),
    "AGGREGATION_INTERNAL_TOKEN": (
        "Shared secret for calls to the aggregation control plane (port 8091). When set, the "
        "control plane accepts only calls that present it. With `ENV=production` the control "
        "plane will not start without it.",
        "A random shared secret, the same value for every service.",
    ),
    "ADMIN_PASSWORD": (
        "Password for the first administrator account. If it is one of the example passwords "
        "published in this repository, the account must change it at first sign-in.",
        "Your own password for the first administrator account, which is created only when the "
        "database has no users.",
    ),
    "AUTH_ENVIRONMENT_ID": (
        "Short name for this deployment, such as `uat`: 1 to 32 letters, digits, `_` or `-`, "
        "starting with a letter or digit. It is added to the session cookie names and the token "
        "issuer, so two environments open in one browser don't sign each other out. Changing it "
        "signs everyone out once.",
        "A name unique to each environment, for example `production`, if people may have two "
        "environments open in the same browser.",
    ),
    "CORS_ALLOWED_ORIGINS": (
        "Browser origins allowed to call the API with credentials, comma-separated, for example "
        "`https://lineage.example.com`. The CSRF check trusts the same list. Unset, only "
        "`http://localhost:3000` and `http://localhost:5173` are allowed.",
        "The address users open the UI at, for example `https://lineage.example.com`.",
    ),
    "ALLOWED_HOSTS": (
        "Host names this deployment answers to, comma-separated. When set, the API refuses "
        "requests for any other host (health checks excepted), and single sign-on never trusts "
        "a host outside the list. Unset accepts any host.",
        "The host names users reach this deployment at.",
    ),
    "FORWARDED_ALLOW_IPS": (
        "Addresses of the proxies whose `X-Forwarded-For` header the API server believes. Read "
        "by the server's start command, not by the app.",
        "The address range of your ingress or reverse proxy, so rate limits and logs see real "
        "client addresses. Read by the API server's start command, not by the app.",
    ),
    "SYNODIC_ROLE": (
        "What this process runs: `web` (the API), `worker` (aggregation jobs), `controlplane` "
        "(scheduling and recovery) or `dev` (everything in one process, the default). Any role "
        "other than `dev` also makes the API write JSON logs.",
        "`web`, `worker` or `controlplane`, per process. The default, `dev`, runs everything in "
        "one process.",
    ),
    "METRICS_TOKEN": (
        "Bearer token a scraper must present to read the metrics.",
        "A random bearer token, if you turn on `METRICS_ENABLED`.",
    ),
    "JWT_SECRET_KEY_PREVIOUS": (
        "Retired signing keys, comma-separated, newest first. They still verify existing "
        "sessions but never sign new ones, so you can rotate `JWT_SECRET_KEY` without signing "
        "everyone out. Remove a key once `JWT_REFRESH_EXPIRY_DAYS` have passed.",
        None,
    ),
    "JWT_ALGORITHM": (
        "Token signing algorithm: `HS256`, `HS384` or `HS512`. Any other value stops the API at "
        "startup.",
        None,
    ),
    "JWT_EXPIRY_MINUTES": (
        "Access-token lifetime in minutes. Permissions travel inside the token, so this is also "
        "how long a role change or a forced sign-out can take to reach an open session. Keep it "
        "at or below `MAX_ACCESS_TTL_MINUTES`.",
        None,
    ),
    "MAX_ACCESS_TTL_MINUTES": (
        "Upper limit for `JWT_EXPIRY_MINUTES`. Above it, the API will not start when "
        "`ENV=production`, and logs a warning otherwise.",
        None,
    ),
    "JWT_REFRESH_EXPIRY_DAYS": (
        "How long a refresh token stays valid, in days. Signed-in browsers renew it as they go; "
        "`SESSION_ABSOLUTE_MAX_HOURS` and `SESSION_IDLE_MAX_HOURS` set the overall session limits.",
        None,
    ),
    "SESSION_ABSOLUTE_MAX_HOURS": (
        "Longest a sign-in can last, in hours, counted from the original sign-in however active "
        "the session stays. `0` turns the limit off.",
        None,
    ),
    "SESSION_IDLE_MAX_HOURS": (
        "Longest a session can go unused, in hours, before it ends. `0` turns the limit off.",
        None,
    ),
    "AUTH_COOKIE_SECURE": (
        "Send session cookies over HTTPS only. Leave it `true`; set `false` only for local "
        "development over plain HTTP, where browsers would otherwise drop the cookies.",
        None,
    ),
    "AUTH_COOKIE_SAMESITE": (
        "SameSite attribute of the session cookies: `lax`, `strict` or `none`.",
        None,
    ),
    "AUTH_COOKIE_DOMAIN": (
        "Domain attribute of the session cookies. Set it only when the API and the UI are on "
        "different subdomains; unset gives host-only cookies.",
        None,
    ),
    "RBAC_ENFORCE_VIEWS": (
        "Emergency rollback switch for the permission checks on views. Leave it on: with "
        "`ENV=production` the API will not start while it is off.",
        None,
    ),
    "RBAC_ENFORCE_WORKSPACES": (
        "Emergency rollback switch for the permission checks on workspaces. Leave it on: with "
        "`ENV=production` the API will not start while it is off.",
        None,
    ),
    "AUTH_CUSTOM_PROVIDER_ENABLED": (
        "Turns on a mock identity provider for development and demos. With `ENV=production` the "
        "backend will not start while it is on.",
        None,
    ),
    "RATELIMIT_STORAGE_URI": (
        "Where rate-limit counters are kept, as a storage URI such as `redis://redis:6379/1`. "
        "Unset, they use the coordination Redis (`REDIS_STREAMS_*` or `REDIS_URL`); with no Redis "
        "configured, each worker process counts on its own.",
        None,
    ),
    "RATELIMIT_LOGIN_PER_IP": (
        "Requests per client address on the sign-in routes, password and single sign-on. A "
        "coarse flood guard: many users can share one address behind a proxy.",
        None,
    ),
    "RATELIMIT_SENSITIVE_PER_IP": (
        "Requests per client address on sign-up, forgot-password, reset-password and invite "
        "redemption.",
        None,
    ),
    "RATELIMIT_REFRESH_PER_SESSION": (
        "Token refreshes allowed per browser session.",
        None,
    ),
    "RATELIMIT_LOGIN_PER_ACCOUNT": (
        "Failed sign-ins allowed per account. A successful sign-in clears the count, so people "
        "who sign in correctly are never throttled.",
        None,
    ),
    "RATELIMIT_PASSWORD_RESET_PER_ACCOUNT": (
        "Forgot-password requests allowed per account.",
        None,
    ),
    "ADMIN_EMAIL": (
        "Email address of the first administrator account. The account is created at startup "
        "only when the database has no users.",
        None,
    ),
    "API_DOCS_ENABLED": (
        "Serve the interactive API docs and schema (`/docs`, `/redoc`, `/openapi.json`) even "
        "with `ENV=production`: `true`, `1` or `yes`. Outside production they are always served.",
        None,
    ),
    "METRICS_ENABLED": (
        "Serve Prometheus metrics: `true`, `1`, `yes` or `on`. The API serves them at "
        "`/api/v1/metrics`, the control plane at `/metrics` on its port 8091, and the aggregation "
        "worker at `/metrics` on `METRICS_PORT`. Also needs `METRICS_TOKEN`: without one the "
        "endpoint answers 404.",
        None,
    ),
    "DATABASE_URL": (
        "Postgres URL for two maintenance scripts. The services read `MANAGEMENT_DB_URL` instead.",
        None,
    ),
    "CACHE_REDIS_URL": (
        "The cache Redis as one URL: the graph response cache and the graph store provider's "
        "cache use it. `REDIS_CACHE_*` settings override its parts.",
        None,
    ),
    "FALKORDB_HOST": (
        "Host of the default FalkorDB graph store. Data sources registered in the app keep their "
        "own host; `LOCAL_DEV_FALKORDB_OVERRIDE` makes this one win during local development.",
        None,
    ),
    "FALKORDB_PORT": (
        "Port of the default FalkorDB graph store.",
        None,
    ),
    "FALKORDB_PASSWORD": (
        "Password for the default FalkorDB graph store. `FALKORDB_PASSWORD_FILE` takes "
        "precedence.",
        None,
    ),
    "FALKORDB_PASSWORD_FILE": (
        "Path to a mounted file holding the default graph store's password; wins over "
        "`FALKORDB_PASSWORD`. A missing or empty file is an error, never a silent connection "
        "without a password.",
        None,
    ),
    "GRAPHVER_PROJECTION_INPROCESS": (
        "Run the versioning projection worker inside the API process (`1`, `true` or `yes`), for "
        "development and single-node installs. Off by default: the separate versioning worker "
        "does it.",
        None,
    ),
    "GRAPHVER_TRANSFER_INPROCESS": (
        "Run import and export jobs inside the API process that received them (on by default). "
        "Set `0` to have the versioning worker run them, so large transfers don't compete with "
        "interactive requests.",
        None,
    ),
    "LOCAL_DEV_FALKORDB_OVERRIDE": (
        "Local development only: set `true` when the backend runs on your machine and FalkorDB in "
        "Docker, so `FALKORDB_HOST` and `FALKORDB_PORT` replace the host and port stored on graph "
        "data sources.",
        None,
    ),
    "FALKORDB_DOCKER_LOCALHOST_REWRITE": (
        "For a backend running in Docker: a graph data source stored with host `localhost` or "
        "`127.0.0.1` connects to this host instead, for example `host.docker.internal`. Unset, "
        "nothing is rewritten.",
        None,
    ),
    "ANALYTICS_WARM_INTERVAL_SECONDS": (
        "How often, in seconds, the analytics documents are recomputed. API processes also align "
        "their analytics time windows to it, so give every process the same value. Values below "
        "30 count as 30.",
        None,
    ),
    "PRODUCT_EVENT_RETENTION_DAYS": (
        "Days of product events (view opens, lineage traces and graph searches) kept for "
        "analytics. Values below 365 count as 365, so a year-long chart always has its data.",
        None,
    ),
    "WORKER_CONCURRENCY": (
        "Aggregation jobs one worker runs at the same time. Also sizes the worker's graph store "
        "connection pools.",
        None,
    ),
    "AGGREGATION_DRIFT_AUTO_REBUILD": (
        "Fleet-wide switch for automatic rebuilds. `false` stops them all; drift is still "
        "detected and shown, and a person can still start a rebuild.",
        None,
    ),
    "LOG_LEVEL": (
        "Log level for every backend service: `DEBUG`, `INFO`, `WARNING` or `ERROR`.",
        None,
    ),
    "APP_BRAND_DESCRIPTION": (
        "Default product description, shown on the sign-in page.",
        None,
    ),
    "APP_BRAND_LOGIN_TAGLINE": (
        "Default tagline, shown on the sign-in page.",
        None,
    ),
}

#: What ``ENV=production`` turns on, from ``backend/app/main.py`` and the other places
#: that read ``ENV``.
PRODUCTION_CHECKS = (
    "The API will not start if `JWT_EXPIRY_MINUTES` is above `MAX_ACCESS_TTL_MINUTES`, or if "
    "`SESSION_ABSOLUTE_MAX_HOURS` is longer than the refresh-token lifetime. Elsewhere these "
    "only log a warning.",
    "The backend will not start with a permission switch (`RBAC_ENFORCE_VIEWS`, "
    "`RBAC_ENFORCE_WORKSPACES`) turned off, or with `AUTH_CUSTOM_PROVIDER_ENABLED` on.",
    "The aggregation control plane will not start without `AGGREGATION_INTERNAL_TOKEN`.",
    "Saving a data-source or identity-provider credential fails without "
    "`CREDENTIAL_ENCRYPTION_KEY`, instead of storing it unencrypted.",
    "Session revocation has no in-memory fallback: if its Redis cannot be set up, privileged "
    "routes answer 503 and `/api/v1/health/ready` reports the pod as not ready. Sign-in "
    "providers that need replay protection (SAML, browser-mode back-channel, signed custom "
    "profiles) are not served either.",
    "The interactive API docs (`/docs`, `/redoc`, `/openapi.json`) are off unless "
    "`API_DOCS_ENABLED` is set.",
    "Identity-provider metadata is never fetched over plain HTTP.",
    "`.env.dev` and `.env` files in the working directory are not loaded.",
)

#: Settings several subsystems read, listed where an operator looks for them rather
#: than where the path rules below would put them.
PINNED = {
    "ENV": "http",
    "CORS_ALLOWED_ORIGINS": "http",
    "SYNODIC_ROLE": "http",
    "ADMIN_EMAIL": "auth",
    "ADMIN_PASSWORD": "auth",
    "MAX_ACCESS_TTL_MINUTES": "auth",
    "AGGREGATION_DISPATCH_MODE": "aggregation",
    "LOG_LEVEL": "observability",
    "METRICS_PORT": "observability",
}

#: The same, by name prefix, for families defined in the central ``config/resilience.py``.
PINNED_PREFIXES = (("PROFILING_", "insights"), ("INSIGHTS_", "insights"), ("STATS_", "insights"))

#: Names that match the secret pattern but are not secrets, so their defaults print.
NOT_SECRET = frozenset({
    "AGGREGATION_RECONCILE_KEYS_ONLY_WIDTH",
    "DEEP_SEARCH_DISCOVER_KEY_CAP",
    "JOB_REDIS_KEY_PREFIX",
    "RATELIMIT_PASSWORD_RESET_PER_ACCOUNT",
})

SECRET_NAME = re.compile(r"PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE")
URL_CREDENTIALS = re.compile(r"\b([a-z][a-z0-9+.-]*://[^:/@\s]*):[^@/\s]+@")

#: Page sections in page order: key -> (heading, one-line introduction).
SECTIONS = {
    "auth": ("Authentication and single sign-on",
             "Sign-in, session tokens and cookies, single sign-on and the sign-in rate limits."),
    "http": ("HTTP and security",
             "The API server: what it accepts and serves, and which part of the backend each "
             "process runs."),
    "db": ("Management database",
           "The Postgres database that holds users, workspaces, views and settings. Per-role "
           "connection pools are under [Name patterns](#name-patterns)."),
    "redis": ("Redis",
              "The two Redis endpoints: coordination (job bus, session revocation, rate limits) "
              "and cache. Each can also be set field by field with the `REDIS_STREAMS_*` and "
              "`REDIS_CACHE_*` settings under [Name patterns](#name-patterns)."),
    "graph": ("Graph store and providers",
              "The FalkorDB graph store, the other graph providers, and the reads built on them: "
              "trace, search and the response cache."),
    "aggregation": ("Aggregation and freshness",
                    "Rollup rebuilds, the job bus, and automatic reconciliation of stale rollups."),
    "insights": ("Insights and statistics",
                 "The statistics service, analytics and the counts history."),
    "versioning": ("Versioning",
                   "Drafts and commits, projection into the graph store, and import and export."),
    "resilience": ("Resilience and limits",
                   "Timeouts, circuit breakers, per-workspace fair share and other safety limits."),
    "branding": ("Branding and UI",
                 "The defaults for the product name, logo and colors. An administrator can "
                 "override each one in the app."),
    "observability": ("Observability and logging",
                      "Logs, metrics, health probes and the system status checks."),
    "scripts": ("Scripts",
                "Read only by the maintenance and seed scripts in `backend/scripts`."),
    "other": ("Other", "Settings outside the subsystems above."),
}

#: A file belongs to the section of the longest prefix that matches it ("other" if none).
RULES = (
    ("backend/auth_service/", "auth"),
    ("backend/app/auth/", "auth"),
    ("backend/app/services/revocation_service.py", "auth"),
    ("backend/app/main.py", "http"),
    ("backend/app/middleware/", "http"),
    ("backend/app/api/", "http"),
    ("backend/app/runtime/", "http"),
    ("backend/app/db/", "db"),
    ("backend/alembic/", "db"),
    ("backend/common/adapters/", "redis"),
    ("backend/app/providers/", "graph"),
    ("backend/app/registry/", "graph"),
    ("backend/graph/", "graph"),
    ("backend/common/providers/", "graph"),
    ("backend/app/services/graph_cache.py", "graph"),
    ("backend/app/services/graph_store/", "graph"),
    ("backend/app/services/top_level_cache.py", "graph"),
    ("backend/app/services/context_engine.py", "graph"),
    ("backend/app/services/deep_search/", "graph"),
    ("backend/app/api/v1/endpoints/graph.py", "graph"),
    ("backend/app/api/v1/endpoints/redis_config.py", "graph"),
    ("backend/app/services/aggregation/", "aggregation"),
    ("backend/app/providers/falkordb_materialize.py", "aggregation"),
    ("backend/app/providers/shard_capacity.py", "aggregation"),
    ("backend/app/jobs/", "aggregation"),
    ("backend/app/api/v1/endpoints/aggregation.py", "aggregation"),
    ("backend/insights_service/", "insights"),
    ("backend/app/services/analytics_cache.py", "insights"),
    ("backend/app/services/product_event_gc.py", "insights"),
    ("backend/app/services/versioning/", "versioning"),
    ("backend/app/services/projection_target.py", "versioning"),
    ("backend/app/config/resilience.py", "resilience"),
    ("backend/app/services/fair_share.py", "resilience"),
    ("backend/app/config/branding.py", "branding"),
    ("backend/app/observability/", "observability"),
    ("backend/app/services/system_status/", "observability"),
    ("backend/app/api/v1/endpoints/metrics.py", "observability"),
    ("backend/app/jobs/metrics_prometheus.py", "observability"),
    ("backend/app/middleware/db_metrics.py", "observability"),
    ("backend/app/middleware/logging.py", "observability"),
    ("backend/scripts/", "scripts"),
)

#: A variable read in several sections is listed under the first of them here. The
#: API entry point (``http``) reads a little of everything, so it comes late: a
#: variable it shares with a subsystem belongs to that subsystem.
PRIORITY = ("auth", "db", "redis", "graph", "aggregation", "insights", "versioning",
            "resilience", "branding", "observability", "http", "scripts", "other")

# --------------------------------------------------------------------------- #
# Finding the reads                                                            #
# --------------------------------------------------------------------------- #

MAX_DEPTH = 12          # name/constant resolution recursion guard
MAX_HELPER_DEPTH = 4    # helper -> helper-of-helper chains

COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)

# Defaults: ("lit", value) | COMPUTED | REQUIRED | ("param", function key, name).
COMPUTED = ("computed",)
REQUIRED = ("required",)
UNSET = ("lit", None)

ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def scanned_files() -> list[Path]:
    """``backend/**/*.py`` minus the test suite, ``test_*.py`` and ``conftest.py``."""
    files = []
    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if rel.parts[0] == "tests" or path.name.startswith("test_") or path.name == "conftest.py":
            continue
        files.append(path)
    return files


def _is_environ(expr: ast.AST) -> bool:
    return (isinstance(expr, ast.Attribute) and expr.attr == "environ") or (
        isinstance(expr, ast.Name) and expr.id == "environ"
    )


def _arg(call: ast.Call, index: int, keyword: str):
    if len(call.args) > index and not isinstance(call.args[index], ast.Starred):
        return call.args[index]
    for kw in call.keywords:
        if kw.arg == keyword:
            return kw.value
    return None


def env_read(node: ast.AST):
    """``(name_expr, default_expr | None | REQUIRED)`` when ``node`` reads the environment."""
    if isinstance(node, ast.Call):
        func = node.func
        tail = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if tail == "getenv":
            name = _arg(node, 0, "key")
            return (name, _arg(node, 1, "default")) if name is not None else None
        if isinstance(func, ast.Attribute) and func.attr in ("get", "setdefault", "pop") \
                and _is_environ(func.value):
            name = _arg(node, 0, "key")
            if name is None:
                return None
            default = _arg(node, 1, "default")
            if default is None and func.attr == "pop":
                return name, REQUIRED       # KeyError when unset
            return name, default
    if isinstance(node, ast.Subscript) and _is_environ(node.value) and isinstance(node.ctx, ast.Load):
        return node.slice, REQUIRED
    if isinstance(node, ast.Assign):
        # ``os.environ["X"] = value``: a process giving X a default of its own. A value
        # that is itself an env read only writes that read back, so it adds nothing.
        for target in node.targets:
            if (isinstance(target, ast.Subscript) and _is_environ(target.value)
                    and not any(env_read(n) for n in ast.walk(node.value))):
                return target.slice, node.value
    return None


def _target_names(target: ast.AST) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for elt in target.elts for n in _target_names(elt)]
    return []


def _param_kind(fn: ast.AST, name: str):
    if not isinstance(fn, FUNCTIONS):
        return None
    a = fn.args
    if any(p.arg == name for p in [*a.posonlyargs, *a.args, *a.kwonlyargs]):
        return "param"
    if a.vararg is not None and a.vararg.arg == name:
        return "vararg"
    if a.kwarg is not None and a.kwarg.arg == name:
        return "kwarg"
    return None


def _tests_empty(test: ast.AST, name: str) -> bool:
    """``not name``, ``name is None``, ``name == ""``, or several of them joined with ``or``."""
    if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.Or):
        return all(_tests_empty(value, name) for value in test.values)
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        return isinstance(test.operand, ast.Name) and test.operand.id == name
    if (isinstance(test, ast.Compare) and isinstance(test.left, ast.Name) and test.left.id == name
            and len(test.ops) == 1 and isinstance(test.comparators[0], ast.Constant)):
        op, right = test.ops[0], test.comparators[0].value
        return (isinstance(op, ast.Is) and right is None) or (isinstance(op, ast.Eq) and right == "")
    return False


def _label(expr: ast.AST) -> str:
    """Placeholder text for a dynamic part of a name: its root variable, upper-cased."""
    while True:
        if isinstance(expr, ast.Name):
            return expr.id.strip("_").upper() or "VALUE"
        if isinstance(expr, ast.Attribute):
            expr = expr.value
        elif isinstance(expr, ast.Call):
            expr = expr.func
        elif isinstance(expr, ast.Subscript):
            expr = expr.value
        else:
            return "VALUE"


def _merge(parts: tuple) -> tuple:
    """Join adjacent literal parts of a template."""
    out: list = []
    for part in parts:
        if isinstance(part, str):
            if not part:
                continue
            if out and isinstance(out[-1], str):
                out[-1] += part
                continue
        out.append(part)
    return tuple(out)


def _case(template: tuple, method: str) -> tuple:
    """``template.upper()`` / ``.lower()``: literal text now, helper parameters once substituted."""
    out = []
    for part in template:
        if isinstance(part, str):
            out.append(getattr(part, method)())
        elif part[0] in ("param", "vararg"):
            out.append(part[:3] + (method,))
        else:
            out.append(part)
    return tuple(out)


def _dedupe(items: list) -> list:
    return list(dict.fromkeys(items))


def _fold(op: ast.operator, a, b):
    """Constant-fold ``a <op> b`` for numbers (and ``+`` for strings); None if not foldable."""
    if isinstance(a, bool) or isinstance(b, bool):
        return None
    if isinstance(a, str) and isinstance(b, str) and isinstance(op, ast.Add):
        return a + b
    if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return None
    if isinstance(op, ast.Add):
        return a + b
    if isinstance(op, ast.Sub):
        return a - b
    if isinstance(op, ast.Mult):
        return a * b
    if isinstance(op, ast.Div) and b:
        return a / b
    if isinstance(op, ast.FloorDiv) and b:
        return a // b
    if isinstance(op, ast.Pow) and isinstance(b, int) and 0 <= b <= 64 and abs(a) < 2 ** 32:
        return a ** b
    return None


class Module:
    """One parsed file: its bindings, function scopes, imports, env reads and calls."""

    def __init__(self, path: Path):
        self.rel = path.relative_to(REPO_ROOT).as_posix()
        parts = list(path.relative_to(REPO_ROOT).with_suffix("").parts)
        self.is_package = parts[-1] == "__init__"
        if self.is_package:
            parts.pop()
        self.name = ".".join(parts)
        self.tree = ast.parse(path.read_text(encoding="utf-8"), filename=self.rel)
        self.bindings: dict = {}    # scope node -> {name: [("value", expr) | ("loop", iter, target)]}
        self.defs: dict = {}        # scope node -> {name: [def nodes]}
        self.def_scope: dict = {}   # def node -> the scope node it is defined in
        self.def_frames: dict = {}  # def node -> the frames enclosing it
        self.imports: dict = {}     # alias -> (module, attribute)
        self.reads: list = []       # (node, name_expr, default_expr, frames)
        self.calls: dict = {}       # "f" / ".f" (self./cls.) / "Owner.f" -> [(call, frames)]
        self.fallbacks: dict = {}   # env-read call -> what the code returns when it comes back empty
        self._index(self.tree, self.tree)
        self._walk(self.tree, ())
        for node in ast.walk(self.tree):
            for field in ("body", "orelse", "finalbody"):
                stmts = getattr(node, field, None)
                if isinstance(stmts, list):
                    for stmt, following in zip(stmts, stmts[1:]):
                        self._note_fallback(stmt, following)

    def _note_fallback(self, stmt: ast.AST, following: ast.AST) -> None:
        """``raw = os.getenv(X)`` then ``if not raw: return Y``: Y is X's default."""
        if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1
                and isinstance(stmt.targets[0], ast.Name) and isinstance(stmt.value, ast.Call)):
            return
        read = env_read(stmt.value)
        if (read is not None and read[1] is None and isinstance(following, ast.If)
                and len(following.body) == 1 and isinstance(following.body[0], ast.Return)
                and following.body[0].value is not None
                and _tests_empty(following.test, stmt.targets[0].id)):
            self.fallbacks[stmt.value] = following.body[0].value

    def _index(self, node: ast.AST, scope: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defs.setdefault(scope, {}).setdefault(child.name, []).append(child)
                self.def_scope[child] = scope
                self._index(child, child)
                continue
            if isinstance(child, ast.ImportFrom):
                base = self._import_base(child)
                for alias in child.names:
                    self.imports[alias.asname or alias.name] = (base, alias.name)
            elif isinstance(child, ast.Assign):
                for target in child.targets:
                    self._bind(scope, target, child.value)
            elif isinstance(child, ast.AnnAssign) and child.value is not None:
                self._bind(scope, child.target, child.value)
            elif isinstance(child, (ast.For, ast.AsyncFor)):
                for name in _target_names(child.target):
                    self.bindings.setdefault(scope, {}).setdefault(name, []).append(
                        ("loop", child.iter, child.target))
            self._index(child, scope)

    def _bind(self, scope: ast.AST, target: ast.AST, value: ast.AST) -> None:
        if isinstance(target, ast.Name):
            self.bindings.setdefault(scope, {}).setdefault(target.id, []).append(("value", value))
        elif (isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List))
              and len(target.elts) == len(value.elts)):
            for sub_target, sub_value in zip(target.elts, value.elts):
                self._bind(scope, sub_target, sub_value)

    def _import_base(self, node: ast.ImportFrom) -> str:
        if not node.level:
            return node.module or ""
        parts = self.name.split(".")
        if not self.is_package:
            parts = parts[:-1]
        if node.level > 1:
            parts = parts[: len(parts) - (node.level - 1)]
        return ".".join(parts + ([node.module] if node.module else []))

    def _walk(self, node: ast.AST, frames: tuple) -> None:
        if isinstance(node, FUNCTIONS):
            for expr in [*getattr(node, "decorator_list", []), *node.args.defaults,
                         *[d for d in node.args.kw_defaults if d is not None]]:
                self._walk(expr, frames)
            self.def_frames[node] = frames
            inner = frames + (node,)
            for stmt in node.body if isinstance(node.body, list) else [node.body]:
                self._walk(stmt, inner)
            return
        if isinstance(node, COMPREHENSIONS):
            frames = frames + (node,)
        read = env_read(node)
        if read is not None:
            self.reads.append((node, read[0], read[1], frames))
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                self.calls.setdefault(func.id, []).append((node, frames))
            elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                owner = "" if func.value.id in ("self", "cls") else func.value.id
                self.calls.setdefault(f"{owner}.{func.attr}", []).append((node, frames))
        for child in ast.iter_child_nodes(node):
            self._walk(child, frames)


class Resolver:
    """Turns env-read argument expressions into names, patterns and defaults.

    A name is a list of templates: tuples of literal text, ``("hole", LABEL, values)``
    for a part that stays dynamic, and ``("param", function key, name[, case])`` /
    ``("vararg", ...)`` for a parameter of an env helper, substituted at its call sites.
    """

    def __init__(self, modules: list[Module]):
        self.modules = {m.name: m for m in modules}
        self.ordered = modules
        self.fns: dict = {}   # function key -> (module, def node)

    def key(self, mod: Module, fn: ast.AST) -> tuple:
        k = (mod.rel, fn.lineno, fn.col_offset)
        self.fns[k] = (mod, fn)
        return k

    def lookup(self, mod: Module, name: str, frames: tuple, depth: int):
        """Where ``name`` is bound, seen from ``frames``."""
        for i in range(len(frames) - 1, -1, -1):
            frame = frames[i]
            if isinstance(frame, COMPREHENSIONS):
                for gen in frame.generators:
                    if name in _target_names(gen.target):
                        return ("comp", mod, gen, frames[:i])
                continue
            kind = _param_kind(frame, name)
            if kind:
                return ("param", kind, mod, frame)
            binds = mod.bindings.get(frame, {}).get(name)
            if binds:
                return ("binds", mod, binds, frames[: i + 1])
        binds = mod.bindings.get(mod.tree, {}).get(name)
        if binds:
            return ("binds", mod, binds, ())
        if name in mod.imports and depth < MAX_DEPTH:
            source, attr = mod.imports[name]
            other = self.modules.get(source)
            if other is not None:
                return self.lookup(other, attr, (), depth + 1)
        return None

    def class_def(self, mod: Module, name: str, depth: int):
        for node in mod.defs.get(mod.tree, {}).get(name, []):
            if isinstance(node, ast.ClassDef):
                return node
        if name in mod.imports and depth < MAX_DEPTH:
            source, attr = mod.imports[name]
            other = self.modules.get(source)
            if other is not None:
                return self.class_def(other, attr, depth + 1)
        return None

    def hole(self, mod: Module, expr: ast.AST, frames: tuple, depth: int) -> tuple:
        """The placeholder for a dynamic part of a name. Its values are known when it is
        ``<parameter annotated with an Enum class>.value``, optionally ``.upper()``/``.lower()``."""
        values: tuple = ()
        method, node = None, expr
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("upper", "lower") and not node.args):
            method, node = node.func.attr, node.func.value
        if isinstance(node, ast.Attribute) and node.attr == "value" and isinstance(node.value, ast.Name):
            found = self.lookup(mod, node.value.id, frames, depth)
            if found and found[0] == "param":
                fn = found[3]
                annotation = next((a.annotation for a in [*fn.args.posonlyargs, *fn.args.args,
                                                          *fn.args.kwonlyargs]
                                   if a.arg == node.value.id), None)
                cls = self.class_def(found[2], annotation.id, depth) \
                    if isinstance(annotation, ast.Name) else None
                if cls is not None:
                    values = tuple(
                        stmt.value.value for stmt in cls.body
                        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1
                        and isinstance(stmt.targets[0], ast.Name)
                        and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str)
                    )
                    if method:
                        values = tuple(getattr(v, method)() for v in values)
        return ("hole", _label(expr), values)

    def eval_str(self, mod: Module, expr: ast.AST, frames: tuple, depth: int = 0):
        """The templates ``expr`` can produce, or None when it cannot be resolved."""
        if depth > MAX_DEPTH or expr is None:
            return None
        if isinstance(expr, ast.Constant):
            return [(expr.value,)] if isinstance(expr.value, str) else None
        if isinstance(expr, ast.JoinedStr):
            acc = [()]
            for part in expr.values:
                if isinstance(part, ast.Constant):
                    options = [(part.value,)]
                else:
                    options = None
                    if part.conversion == -1 and part.format_spec is None:
                        options = self.eval_str(mod, part.value, frames, depth + 1)
                    options = options or [(self.hole(mod, part.value, frames, depth),)]
                acc = [a + o for a in acc for o in options]
            return _dedupe([_merge(t) for t in acc])
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            left = self.eval_str(mod, expr.left, frames, depth + 1)
            right = self.eval_str(mod, expr.right, frames, depth + 1)
            if left is None and right is None:
                return None
            left = left or [(self.hole(mod, expr.left, frames, depth),)]
            right = right or [(self.hole(mod, expr.right, frames, depth),)]
            return _dedupe([_merge(a + b) for a in left for b in right])
        if isinstance(expr, ast.Name):
            return self.eval_name(mod, expr.id, frames, depth + 1)
        if isinstance(expr, ast.Subscript):
            container = self.container(mod, expr.value, frames, depth + 1)
            if container is None:
                return None
            cmod, node, cframes = container
            if isinstance(node, ast.Dict) and isinstance(expr.slice, ast.Constant):
                for k, v in zip(node.keys, node.values):
                    if isinstance(k, ast.Constant) and k.value == expr.slice.value:
                        return self.eval_str(cmod, v, cframes, depth + 1)
                return None
            values = node.values if isinstance(node, ast.Dict) else node.elts
            return self._eval_all(cmod, values, cframes, depth)
        if (isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name) and expr.func.id == "str"
                and len(expr.args) == 1 and not expr.keywords):
            return self.eval_str(mod, expr.args[0], frames, depth + 1)
        if (isinstance(expr, ast.Call) and isinstance(expr.func, ast.Attribute)
                and expr.func.attr in ("upper", "lower") and not expr.args and not expr.keywords):
            inner = self.eval_str(mod, expr.func.value, frames, depth + 1)
            return None if inner is None else [_case(t, expr.func.attr) for t in inner]
        return None

    def _eval_all(self, mod: Module, exprs: list, frames: tuple, depth: int):
        out: list = []
        for e in exprs:
            r = self.eval_str(mod, e, frames, depth + 1) if e is not None else None
            if r is None:
                return None
            out.extend(r)
        return _dedupe(out)

    def eval_name(self, mod: Module, name: str, frames: tuple, depth: int):
        found = self.lookup(mod, name, frames, depth)
        if found is None:
            return None
        if found[0] == "param":
            _, kind, fmod, fn = found
            return None if kind == "kwarg" else [((kind, self.key(fmod, fn), name),)]
        if found[0] == "comp":
            _, cmod, gen, outer = found
            return self.eval_iter(cmod, gen.iter, gen.target, name, outer, depth + 1)
        _, bmod, binds, bframes = found
        out: list = []
        for bind in binds:
            if bind[0] == "value":
                r = self.eval_str(bmod, bind[1], bframes, depth + 1)
            else:
                r = self.eval_iter(bmod, bind[1], bind[2], name, bframes, depth + 1)
            if r is None:
                return None
            out.extend(r)
        return _dedupe(out)

    def eval_iter(self, mod: Module, iter_expr: ast.AST, target: ast.AST, name: str,
                  frames: tuple, depth: int):
        """The values ``name`` takes in ``for <target> in <iter_expr>``."""
        if isinstance(target, ast.Name):
            slot = None
        elif isinstance(target, (ast.Tuple, ast.List)) and all(isinstance(e, ast.Name) for e in target.elts):
            slot = [e.id for e in target.elts].index(name)
        else:
            return None
        method = None
        if (isinstance(iter_expr, ast.Call) and isinstance(iter_expr.func, ast.Attribute)
                and iter_expr.func.attr in ("items", "keys", "values") and not iter_expr.args):
            method = iter_expr.func.attr
            iter_expr = iter_expr.func.value
        container = self.container(mod, iter_expr, frames, depth + 1)
        if container is None:
            # ``for v in names`` where ``names`` is the helper's ``*names``.
            if slot is None and method is None and isinstance(iter_expr, ast.Name):
                r = self.eval_name(mod, iter_expr.id, frames, depth + 1)
                if r and all(len(t) == 1 and isinstance(t[0], tuple) and t[0][0] == "vararg" for t in r):
                    return r
            return None
        cmod, node, cframes = container
        if isinstance(node, ast.Dict):
            if method == "items" and slot in (0, 1) and len(target.elts) == 2:
                exprs = node.keys if slot == 0 else node.values
            elif slot is None and method in (None, "keys"):
                exprs = node.keys
            elif slot is None and method == "values":
                exprs = node.values
            else:
                return None
        else:
            if method is not None:
                return None
            if slot is None:
                exprs = node.elts
            else:
                exprs = []
                for elt in node.elts:
                    if not isinstance(elt, (ast.Tuple, ast.List)) or len(elt.elts) <= slot:
                        return None
                    exprs.append(elt.elts[slot])
        return self._eval_all(cmod, exprs, cframes, depth)

    def container(self, mod: Module, expr: ast.AST, frames: tuple, depth: int):
        """``(module, literal tuple/list/set/dict node, frames)`` that ``expr`` names, or None."""
        if depth > MAX_DEPTH:
            return None
        if isinstance(expr, (ast.Tuple, ast.List, ast.Set, ast.Dict)):
            return mod, expr, frames
        if (isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name)
                and expr.func.id in ("tuple", "list", "set", "frozenset")
                and len(expr.args) == 1 and not expr.keywords):
            return self.container(mod, expr.args[0], frames, depth + 1)
        if isinstance(expr, ast.Name):
            found = self.lookup(mod, expr.id, frames, depth)
            if found and found[0] == "binds" and len(found[2]) == 1 and found[2][0][0] == "value":
                return self.container(found[1], found[2][0][1], found[3], depth + 1)
        return None

    def eval_default(self, mod: Module, expr, frames: tuple, depth: int = 0) -> tuple:
        if expr is REQUIRED:
            return REQUIRED
        if expr is None:
            return UNSET
        if depth > MAX_DEPTH:
            return COMPUTED
        if isinstance(expr, ast.Constant):
            value = expr.value
            return ("lit", value) if value is None or isinstance(value, (str, int, float)) else COMPUTED
        if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, (ast.USub, ast.UAdd)):
            inner = self.eval_default(mod, expr.operand, frames, depth + 1)
            if inner[0] == "lit" and isinstance(inner[1], (int, float)) and not isinstance(inner[1], bool):
                return ("lit", -inner[1] if isinstance(expr.op, ast.USub) else inner[1])
            return COMPUTED
        if isinstance(expr, ast.BinOp):
            left = self.eval_default(mod, expr.left, frames, depth + 1)
            right = self.eval_default(mod, expr.right, frames, depth + 1)
            if left[0] == "lit" and right[0] == "lit":
                folded = _fold(expr.op, left[1], right[1])
                if folded is not None:
                    return ("lit", folded)
            return COMPUTED
        if isinstance(expr, ast.Name):
            found = self.lookup(mod, expr.id, frames, depth)
            if found and found[0] == "param" and found[1] == "param":
                return ("param", self.key(found[2], found[3]), expr.id)
            if found and found[0] == "binds" and len(found[2]) == 1 and found[2][0][0] == "value":
                return self.eval_default(found[1], found[2][0][1], found[3], depth + 1)
            return COMPUTED
        if (isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name)
                and expr.func.id in ("str", "int", "float") and len(expr.args) == 1 and not expr.keywords):
            inner = self.eval_default(mod, expr.args[0], frames, depth + 1)
            if inner[0] == "lit" and inner[1] is not None:
                try:
                    return ("lit", {"str": str, "int": int, "float": float}[expr.func.id](inner[1]))
                except (TypeError, ValueError):
                    return COMPUTED
            return inner if inner[0] == "param" else COMPUTED
        if isinstance(expr, ast.IfExp) and isinstance(expr.test, ast.Name):
            # ``os.getenv(name, "1" if default else "0")``: the caller's ``default`` is the default.
            found = self.lookup(mod, expr.test.id, frames, depth)
            if found and found[0] == "param" and found[1] == "param":
                return ("param", self.key(found[2], found[3]), expr.test.id)
        return COMPUTED

    def call_sites(self, key: tuple) -> list:
        """``(module, call, frames, offset)`` for every call to the helper ``key``."""
        mod, fn = self.fns[key]
        scope = mod.def_scope.get(fn)
        sites = []
        if isinstance(scope, ast.ClassDef):
            decorators = {getattr(d, "id", None) for d in fn.decorator_list}
            bound_offset = 0 if "staticmethod" in decorators else 1     # self.f() / cls.f()
            class_offset = 1 if "classmethod" in decorators else 0      # Owner.f()
            for call, frames in mod.calls.get("." + fn.name, []):
                sites.append((mod, call, frames, bound_offset))
            for call, frames in mod.calls.get(f"{scope.name}.{fn.name}", []):
                sites.append((mod, call, frames, class_offset))
            for other in self.ordered:
                for alias, (source, attr) in other.imports.items():
                    if other is not mod and source == mod.name and attr == scope.name:
                        for call, frames in other.calls.get(f"{alias}.{fn.name}", []):
                            sites.append((other, call, frames, class_offset))
        elif scope is mod.tree:
            for call, frames in mod.calls.get(fn.name, []):
                if not any(fn.name in mod.defs.get(f, {}) for f in frames if isinstance(f, FUNCTIONS)):
                    sites.append((mod, call, frames, 0))
            for other in self.ordered:
                for alias, (source, attr) in other.imports.items():
                    if other is not mod and source == mod.name and attr == fn.name:
                        for call, frames in other.calls.get(alias, []):
                            sites.append((other, call, frames, 0))
        elif scope is not None:
            for call, frames in mod.calls.get(fn.name, []):
                if scope in frames:
                    sites.append((mod, call, frames, 0))
        return sites

    @staticmethod
    def bind(fn: ast.AST, call: ast.Call, offset: int):
        """Parameter name -> argument expression (a list for ``*args``, ("default", expr) when
        the call leaves it to the parameter's own default). None if the call can't be bound."""
        a = fn.args
        positional = [p.arg for p in [*a.posonlyargs, *a.args]]
        defaults = {}
        if a.defaults:
            defaults.update(zip(positional[-len(a.defaults):], a.defaults))
        for p, d in zip(a.kwonlyargs, a.kw_defaults):
            if d is not None:
                defaults[p.arg] = d
        positional = positional[offset:]
        bound: dict = {}
        extra = []
        for i, arg in enumerate(call.args):
            if isinstance(arg, ast.Starred):
                return None
            if i < len(positional):
                bound[positional[i]] = arg
            else:
                extra.append(arg)
        if a.vararg is not None:
            bound[a.vararg.arg] = extra
        for kw in call.keywords:
            if kw.arg is None:
                return None
            bound[kw.arg] = kw.value
        for name, expr in defaults.items():
            bound.setdefault(name, ("default", expr))
        return bound

    def expand(self, template: tuple, default: tuple, depth: int = 0) -> list:
        """Substitute helper parameters with what each call site passes."""
        refs = [p for p in template if isinstance(p, tuple) and p[0] in ("param", "vararg")]
        if default[0] == "param":
            refs.append(default)
        if not refs:
            return [(template, default)]
        # Innermost function first: its call sites are inside the outer one.
        key = max((r[1] for r in refs), key=lambda k: len(self.fns[k][0].def_frames.get(self.fns[k][1], ())))
        mod, fn = self.fns[key]
        sites = self.call_sites(key) if depth < MAX_HELPER_DEPTH else []
        out = []
        for cmod, call, cframes, offset in sites:
            bound = self.bind(fn, call, offset)
            options = [()]
            for part in template:
                if isinstance(part, tuple) and part[0] in ("param", "vararg") and part[1] == key:
                    values = self._arg_templates(cmod, cframes, mod, fn, bound, part)
                    options = [o + v for o in options for v in values]
                else:
                    options = [o + (part,) for o in options]
            new_default = default
            if default[0] == "param" and default[1] == key:
                new_default = self._arg_default(cmod, cframes, mod, fn, bound, default[2])
            for option in options:
                out.extend(self.expand(_merge(option), new_default, depth + 1))
        if not sites:
            holed = tuple(("hole", p[2].strip("_").upper(), ()) if isinstance(p, tuple)
                          and p[0] in ("param", "vararg") and p[1] == key else p for p in template)
            new_default = COMPUTED if default[0] == "param" and default[1] == key else default
            out.extend(self.expand(_merge(holed), new_default, depth + 1))
        return out

    def _arg_templates(self, cmod, cframes, mod, fn, bound, part) -> list:
        hole = [(("hole", part[2].strip("_").upper(), ()),)]
        if bound is None or part[2] not in bound:
            values = hole
        elif part[0] == "vararg":
            values = []
            for expr in bound[part[2]]:
                values.extend(self.eval_str(cmod, expr, cframes) or hole)
        elif isinstance(bound[part[2]], tuple):   # the parameter's own default
            values = self.eval_str(mod, bound[part[2]][1], mod.def_frames.get(fn, ())) or hole
        else:
            values = self.eval_str(cmod, bound[part[2]], cframes) or hole
        return [_case(v, part[3]) for v in values] if len(part) > 3 else values

    def _arg_default(self, cmod, cframes, mod, fn, bound, name) -> tuple:
        if bound is None or name not in bound:
            return COMPUTED
        arg = bound[name]
        if isinstance(arg, tuple):
            return self.eval_default(mod, arg[1], mod.def_frames.get(fn, ()))
        return self.eval_default(cmod, arg, cframes)


def scan():
    """Every env read in the backend, resolved.

    Returns ``(variables, patterns, unresolved, reads)``: name -> {"defaults", "paths"};
    pattern -> {"defaults", "paths", "holes"}; the sites that could not be resolved;
    and how many read sites there are.
    """
    modules = [Module(p) for p in scanned_files()]
    resolver = Resolver(modules)
    variables: dict = {}
    patterns: dict = {}
    unresolved = []
    reads = 0
    for mod in modules:
        for node, name_expr, default_expr, frames in mod.reads:
            reads += 1
            templates = resolver.eval_str(mod, name_expr, frames)
            default = resolver.eval_default(mod, default_expr, frames)
            if default == UNSET and node in mod.fallbacks:
                default = resolver.eval_default(mod, mod.fallbacks[node], frames)
            found_any = False
            inner = next((f for f in reversed(frames) if isinstance(f, FUNCTIONS)), None)
            for template in templates or []:
                if (default == UNSET and inner is not None and _param_kind(inner, "default") == "param"
                        and any(isinstance(p, tuple) and p[0] in ("param", "vararg")
                                and p[1] == resolver.key(mod, inner) for p in template)):
                    # ``def _env_int(name, default, ...): raw = os.getenv(name) ... return default``
                    default = ("param", resolver.key(mod, inner), "default")
                for final, final_default in resolver.expand(template, default):
                    text = "".join(p for p in final if isinstance(p, str))
                    if all(isinstance(p, str) for p in final):
                        if not ENV_NAME.match(text):
                            continue
                        entry = variables.setdefault(text, {"defaults": [], "paths": []})
                    elif any(c.isalpha() for c in text):
                        pattern = "".join(p if isinstance(p, str) else f"<{p[1]}>" for p in final)
                        entry = patterns.setdefault(pattern, {"defaults": [], "paths": [], "holes": {}})
                        for part in final:
                            if isinstance(part, tuple) and part[0] == "hole":
                                known = entry["holes"].setdefault(part[1], [])
                                known.extend(v for v in part[2] if v not in known)
                    else:
                        continue
                    entry["defaults"].append(final_default)
                    if mod.rel not in entry["paths"]:
                        entry["paths"].append(mod.rel)
                    found_any = True
            if not found_any:
                unresolved.append(f"{mod.rel}:{node.lineno}")
    return variables, patterns, unresolved, reads


# --------------------------------------------------------------------------- #
# The .env templates                                                           #
# --------------------------------------------------------------------------- #

ENV_LINE = re.compile(r"^(?:#\s?)?([A-Z][A-Z0-9_]*)=(.*)$")   # KEY=value, or "# KEY=value"
INDENTED = re.compile(r"^#\s{2,}(#\s*)?(\S.*)$")              # a line indented under the one above
HEADER = re.compile(r"^#\s*[─═]")                              # "# ── Section ──"
SENTENCE_END = re.compile(r"(?<!e\.g)(?<!i\.e)[.!?](?=\s+[A-Z0-9`(\"'])")


def _first_sentence(text: str) -> str:
    text = " ".join(text.split())
    end = SENTENCE_END.search(text)
    return text[: end.end()] if end else text


def _inline_comment(rest: str):
    rest = rest.strip()
    if rest[:1] in ("'", '"'):
        close = rest.find(rest[0], 1)
        found = re.match(r"\s*#\s?(.*)$", rest[close + 1:] if close > 0 else "")
    else:
        found = re.search(r"(?:^|\s)#\s?(.*)$", rest)
    return found.group(1).strip() if found and found.group(1).strip() else None


def template_descriptions() -> tuple[dict, list]:
    """Descriptions from the ``.env`` templates, and every ``(template, key)`` they set.

    A variable's inline comment wins (with the lines indented under it that continue
    its sentence); otherwise the comment block directly above it, or above the run of
    variable lines it belongs to. Either way, only the first sentence is kept.
    """
    inline: dict = {}
    block: dict = {}
    keys = []
    for filename in ENV_TEMPLATES:
        lines = (REPO_ROOT / filename).read_text(encoding="utf-8").splitlines()
        owned: set = set()  # lines indented under a variable belong to it, not to a block
        for i, line in enumerate(lines):
            match = ENV_LINE.match(line)
            if not match:
                continue
            name, rest = match.groups()
            keys.append((filename, name))
            continuation, open_sentence = [], True
            j = i + 1
            while j < len(lines) and INDENTED.match(lines[j]) and not ENV_LINE.match(lines[j]):
                owned.add(j)
                aligned, text = INDENTED.match(lines[j]).groups()
                # "#   # more text" continues the comment; "#   text" continues it only
                # when it carries on the sentence rather than starting a new paragraph.
                if open_sentence and (aligned or text[0].islower() or text[0] in "(["):
                    continuation.append(text)
                else:
                    open_sentence = False
                j += 1
            comment = _inline_comment(rest)
            if comment and name not in inline:
                inline[name] = _first_sentence(" ".join([comment, *continuation]))
            k = i - 1
            while k >= 0 and ENV_LINE.match(lines[k]):
                k -= 1
            above = []
            while (k >= 0 and k not in owned and lines[k].startswith("#")
                   and not HEADER.match(lines[k]) and not ENV_LINE.match(lines[k])):
                above.insert(0, lines[k].lstrip("#").strip())
                k -= 1
            if " ".join(above).strip() and name not in block:
                block[name] = _first_sentence(" ".join(above))
    return {**block, **inline}, keys


def unread_template_keys(keys: list, variables: dict, patterns: dict) -> list:
    """``(key, templates)`` for keys nothing reads: no backend read (Python, a Dockerfile or
    a shell script under ``backend/``) and no use in a ``docker-compose*.yml``.

    A compose line that only passes the key through under its own name
    (``KEY: ${KEY:-x}``) is not a use: it hands the value to a container whose code is
    exactly what was scanned. ``VITE_*`` keys are frontend build settings and skipped.
    """
    shell = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                      for p in sorted(BACKEND.rglob("*"))
                      if p.is_file() and (p.name.startswith("Dockerfile") or p.suffix == ".sh"))
    compose_lines = [line for p in sorted(REPO_ROOT.glob("docker-compose*.yml"))
                     for line in p.read_text(encoding="utf-8").splitlines()
                     if not line.lstrip().startswith("#")]
    pattern_res = [re.compile("^" + re.sub(r"<[A-Z0-9_]+>", "[A-Z0-9_]+", re.escape(p)) + "$")
                   for p in patterns]
    templates: dict = {}
    for filename, key in keys:
        templates.setdefault(key, [])
        if filename not in templates[key]:
            templates[key].append(filename)
    unread = []
    for key, files in templates.items():
        if key in variables or key.startswith("VITE_"):
            continue
        if any(r.match(key) for r in pattern_res) or re.search(rf"\$\{{?{key}\b", shell):
            continue
        use = re.compile(rf"\$\{{?{key}\b")
        forward = re.compile(rf"^\s*-?\s*[\"']?{key}[\"']?\s*[:=]\s*[\"']?\$\{{{key}\b[^}}]*\}}[\"']?\s*$")
        if any(use.search(line) and not forward.match(line) for line in compose_lines):
            continue
        unread.append((key, files))
    return unread


# --------------------------------------------------------------------------- #
# Rendering                                                                    #
# --------------------------------------------------------------------------- #

def _cell(text: str) -> str:
    """Make prose safe in a table cell: the reader is GFM and shows raw HTML as text."""
    out = []
    for i, part in enumerate(re.split(r"(`+[^`]*`+)", text)):
        if i % 2:
            out.append(part.replace("|", r"\|"))
        else:
            part = re.sub(r"([|<*~])", r"\\\1", part)
            out.append(re.sub(r"(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])", r"\\_", part))
    return "".join(out)


def _code(value: str) -> str:
    value = value.replace("|", r"\|")
    return f"`` {value} ``" if "`" in value else f"`{value}`"


def show_default(name: str, defaults: list, brand: list) -> str:
    if SECRET_NAME.search(name) and name not in NOT_SECRET:
        return "— (secret, set your own)"
    shown = sorted({_one_default(d, brand) for d in defaults})
    return shown[0] if len(shown) == 1 else " / ".join(shown) + " *(differs by call site)*"


def _one_default(default: tuple, brand: list) -> str:
    if default == REQUIRED:
        return "required"
    if default[0] != "lit":
        return "computed"
    value = default[1]
    if value is None:
        return "—"
    if isinstance(value, bool):
        return _code(str(value).lower())
    if isinstance(value, (int, float)):
        return _code(repr(value))
    if value == "":
        return "(empty)"
    if any(re.search(rf"\b{re.escape(term)}\b", value) for term in brand):
        return "built-in brand text"   # the docs never print a product name
    return _code(URL_CREDENTIALS.sub(r"\1:***@", value))


def _read_in(paths: list) -> str:
    paths = sorted(paths)
    shown = ", ".join(f"`{p}`" for p in paths[:3])
    return shown + (f" +{len(paths) - 3} more" if len(paths) > 3 else "")


def _section(name: str, paths: list) -> str:
    if name in PINNED:
        return PINNED[name]
    for prefix, section in PINNED_PREFIXES:
        if name.startswith(prefix):
            return section
    found = set()
    for path in paths:
        prefixes = [(len(prefix), section) for prefix, section in RULES if path.startswith(prefix)]
        found.add(max(prefixes)[1] if prefixes else "other")
    return next(s for s in PRIORITY if s in found)


def _table(header: list, rows: list) -> list:
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header),
            *("| " + " | ".join(row) + " |" for row in rows)]


def render(variables: dict, patterns: dict, descriptions: dict) -> str:
    brand = [d[1] for name in ("APP_BRAND_NAME", "APP_BRAND_SHORT_NAME")
             for d in variables.get(name, {}).get("defaults", []) if d[0] == "lit" and d[1]]
    known = {*variables, *patterns}
    file_backed = sorted(name[: -len("_FILE")] for name in known
                         if name.endswith("_FILE") and name[: -len("_FILE")] in known)
    out = [
        f'[//]: # "GENERATED by {SCRIPT} — do not edit by hand"',
        "",
        "# Configuration Reference",
        "",
        "*For platform operators and developers.*",
        "",
        "This page lists every environment variable the backend reads, with its default, what it "
        "does and where it is read, so you can configure a deployment without reading the code. "
        "Start with [Must set in production](#must-set-in-production); the sections after it follow "
        "the backend's subsystems.",
        "",
        f"> **Note:** This page is generated from the code by `{SCRIPT}`. Don't edit it by hand: "
        "change the comment beside the variable in `.env.example` (or the script's `NOTES`), then "
        f"run `{REGENERATE}` and commit the result. CI runs the same script with `--check` and fails "
        "when this page is out of date.",
        "",
        "## How configuration works",
        "",
        "Every setting is an environment variable. A process reads its environment when it starts, "
        "so after you change a value, restart or redeploy the processes that read it.",
        "",
        "Where you set the variables depends on how you run the platform:",
        "",
        *_table(["You run", "Set variables in", "Good to know"], [
            ["Local development (`./dev.sh`)", "`.env.dev`",
             "`./dev.sh` creates it from `.env.example` on the first run, with a fresh "
             "`JWT_SECRET_KEY`. Outside production the backend also reads `.env.dev` (or `.env`) "
             "from its working directory, without overriding variables that are already set."],
            ["Docker Compose (`./deploy.sh`)", "`.env`",
             "Copy `.env.prod.example` to `.env` and replace every `REPLACE_ME` value; "
             "`./deploy.sh` refuses to start while one is left. A container receives only the "
             "variables its service lists under `environment:` in `docker-compose.yml`; to set "
             "any other, add it there."],
            ["Kubernetes", "ConfigMaps and a Secret",
             "Settings live in `deploy/k8s/base/configmaps/`, secrets in "
             "`deploy/k8s/base/secrets/`. See [Kubernetes](/docs/kubernetes)."],
        ]),
        "",
        "**Secrets from files.** "
        + (("These settings can also be read from a mounted file: "
            + ", ".join(f"`{n}`" for n in file_backed) + ". Set the same name with `_FILE` "
            "added, for example `FALKORDB_PASSWORD_FILE`, to the file's path. For passwords the "
            "file takes precedence and a missing or empty file is an error; for the SAML "
            "certificate and key, a value set directly takes precedence. ") if file_backed else "")
        + "Other secrets, `JWT_SECRET_KEY` included, have no `_FILE` form: set them directly, for "
        "example from a Kubernetes Secret.",
        "",
        "How to read the tables:",
        "",
        "- **Default** is the value used when the variable is unset. `—` means the code has no "
        "fallback value: the feature stays off, or the value is worked out at run time. *computed* "
        "means the default is calculated in code; *required* means a process that reads it fails "
        "without it. When the code reads a variable in several places with different defaults, "
        "each one is listed and marked *differs by call site*.",
        "- **Read in** names up to three source files that read the variable.",
        "- Settings without a description are listed, with their defaults, under "
        "**Internal tuning** in each section.",
        "",
        "## Must set in production",
        "",
        "Set `ENV=production` first. It turns on these safeguards:",
        "",
        *(f"- {check}" for check in PRODUCTION_CHECKS),
        "",
        "Then set these:",
        "",
        *_table(["Variable", "What to set"],
                [[f"`{name}`", _cell(prod)] for name, (_, prod) in NOTES.items() if prod]),
        "",
        "> **Docker Compose:** a container receives only the variables its service lists under "
        "`environment:` in `docker-compose.yml`. If a variable above is not listed for a service "
        "that reads it, add it there: setting it in `.env` alone has no effect. See "
        "[Deployment](/docs/deployment#production-hardening-checklist).",
        "",
    ]
    by_section: dict = {key: [] for key in SECTIONS}
    for name in sorted(variables):
        by_section[_section(name, variables[name]["paths"])].append(name)
    for key, (heading, intro) in SECTIONS.items():
        names = by_section[key]
        if not names:
            continue
        described = [n for n in names if n in descriptions]
        tuning = [n for n in names if n not in descriptions]
        out += [f"## {heading}", "", _cell(intro), ""]
        if described:
            out += [*_table(["Variable", "Default", "Description", "Read in"], [
                [f"`{n}`", show_default(n, variables[n]["defaults"], brand),
                 _cell(URL_CREDENTIALS.sub(r"\1:***@", descriptions[n])),
                 _read_in(variables[n]["paths"])] for n in described]), ""]
        if tuning:
            out += ["### Internal tuning", "", *_table(["Variable", "Default", "Read in"], [
                [f"`{n}`", show_default(n, variables[n]["defaults"], brand),
                 _read_in(variables[n]["paths"])] for n in tuning]), ""]
    out += [
        "## Name patterns",
        "",
        "These names are built in code from a fixed part and a variable part. Replace the part in "
        "angle brackets with one of its values, for example `REDIS_<ROLE>_HOST` becomes "
        "`REDIS_CACHE_HOST`.",
        "",
        *_table(["Pattern", "Values", "Default", "Read in"], [
            [_code(p),
             "; ".join(f"`<{label}>`: " + (", ".join(_code(v) for v in values) or "set in code")
                       for label, values in patterns[p]["holes"].items()),
             show_default(p, patterns[p]["defaults"], brand),
             _read_in(patterns[p]["paths"])] for p in sorted(patterns)]),
        "",
        "## Where to next",
        "",
        "- [Deployment](/docs/deployment) — when you want to install or upgrade with Docker Compose.",
        "- [Kubernetes](/docs/kubernetes) — when you deploy to a cluster and need the ConfigMaps "
        "and Secrets these settings go in.",
        "- [Setup](/docs/setup) — when you want a local development environment.",
        "- [Security overview](/docs/security-overview) — when you want the security controls "
        "behind these settings.",
        "- [Observability](/docs/observability) — when you want to turn on metrics and read the logs.",
    ]
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# Command line                                                                 #
# --------------------------------------------------------------------------- #

def build() -> str:
    """Render the page, reporting what a reviewer should know on stderr."""
    variables, patterns, unresolved, reads = scan()
    descriptions, keys = template_descriptions()
    descriptions = {name: text for name, text in descriptions.items() if name in variables}
    descriptions.update({name: note for name, (note, _) in NOTES.items() if name in variables})
    print(f"{TAG} {reads} env reads: {len(variables)} variables "
          f"({len(descriptions)} described, {len(variables) - len(descriptions)} internal tuning), "
          f"{len(patterns)} name patterns, {len(unresolved)} unresolved.", file=sys.stderr)
    for site in unresolved:
        print(f"{TAG} unresolved env read at {site}", file=sys.stderr)
    for name, (_, prod) in NOTES.items():
        if name not in variables and not prod:
            print(f"{TAG} warning: NOTES describes {name}, which nothing reads.", file=sys.stderr)
    for key, files in unread_template_keys(keys, variables, patterns):
        print(f"{TAG} warning: {key} is set in {' and '.join(files)}, but nothing in backend/ "
              "reads it and no docker-compose*.yml uses it.", file=sys.stderr)
    return render(variables, patterns, descriptions)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate docs/CONFIGURATION.md from the environment variables the backend reads.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="Compare with the committed page; print a diff and exit 1 if it is out of date.")
    mode.add_argument("--stdout", action="store_true", help="Print the page instead of writing it.")
    args = parser.parse_args()

    page = build()
    rel = OUTPUT.relative_to(REPO_ROOT).as_posix()
    if args.stdout:
        sys.stdout.write(page)
        return 0
    if args.check:
        committed = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if committed == page:
            print(f"{TAG} {rel} is up to date.", file=sys.stderr)
            return 0
        sys.stdout.writelines(difflib.unified_diff(
            committed.splitlines(keepends=True), page.splitlines(keepends=True),
            f"{rel} (committed)", f"{rel} (from the code)",
        ))
        state = "is out of date" if committed else "is missing"
        print(f"{TAG} {rel} {state} — run `{REGENERATE}` and commit the result.", file=sys.stderr)
        return 1
    OUTPUT.write_text(page, encoding="utf-8", newline="\n")
    print(f"{TAG} wrote {rel}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
