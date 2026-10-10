# Testing & CI

*For New Engineers and anyone opening a pull request.*

What runs when you open a pull request, which of it can stop your merge, and how to run every check on your machine before you push. Use the first table to read a pull request's checks, the middle sections to reproduce one locally, and the last table when something is red.

> **Before you start:** run commands from the repository root unless a step says otherwise. The backend suites need a virtual environment with `backend/requirements.txt` and `backend/requirements-test.txt` installed, and the frontend suites need `npm ci` in `frontend/` — both are step 3 of [running the apps on your machine](/docs/setup#run-the-apps-on-your-machine-instead).

```mermaid
flowchart LR
    A["Push to a pull request"] --> B["Gating jobs"]
    A --> C["Informational jobs"]
    B -->|all green| D["Ready to merge after review"]
    B -->|any red| E["Fix, push, checks run again"]
    C --> F["Read the result; it never blocks"]
```

## What runs on a pull request

Every workflow lives in `.github/workflows/`. **Fails your PR?** says whether a failing job turns your pull request's checks red. Which checks must be green before a merge is set in the repository's branch protection rather than in these files; the workflow files mark the jobs meant to be required.

| Workflow | Runs on | What it runs | Fails your PR? |
|---|---|---|---|
| **backend-tests** (`backend-tests.yml`) | Every pull request; pushes to `main` | **Backend connectivity + provider suite (required)**: the unit tests selected by keyword (FalkorDB, Redis, providers, aggregation, insights and more), then every file named in `backend/tests/ci-required-files.txt`. Python 3.11. | Yes |
| | | **Live FalkorDB pipeline (informational)**: the aggregation rebuild and the search engine against a real FalkorDB v4.18.11 | No — `continue-on-error` |
| | | **Full backend suite (informational)**: every unit test (`-m "not integration"`) | No — `continue-on-error` |
| **frontend-tests** (`frontend-tests.yml`) | Every pull request; pushes to `main` | **Frontend unit suite (required)**: `npx vitest run`, which includes the documentation checks. Node 20. | Yes |
| **Guards** (`alembic-guards.yml`) | Pull requests to `main`; pushes to `main` | **Revision ids fit alembic_version(32)**: migration revision ids are 32 characters or fewer, and every column `init_aggregation_db` adds has a migration. **Every feature flag is really wired**: each switch's declared gates exist. **Configuration reference matches the code**: `docs/CONFIGURATION.md` matches the backend's environment-variable reads. Pure file parsing; seconds. | Yes |
| **Schema** (`schema.yml`) | Pull requests to `main`; pushes to `main` | Against a real Postgres 16: **A fresh database installs at head**, **An existing database moves onto this PR** and **The migration chain still replays from empty**. Each runs `verify-schema`; the fresh install also checks that the role and permission rows were seeded. | Yes |
| **security-scan** (`security-scan.yml`) | Every pull request; pushes to `main`; Mondays 06:00 UTC; manual runs | `npm audit --audit-level=high` for `frontend` and `landing`; `pip-audit` on both backend requirement files; a Trivy filesystem scan for fixable HIGH and CRITICAL vulnerabilities; a Trivy configuration scan | Yes, except the configuration scan, which only reports |
| **CodeQL** (`codeql.yml`) | Pull requests to `main`; pushes to `main`; Mondays 06:00 UTC | Static analysis of the Python and JavaScript/TypeScript code with the `security-and-quality` queries | Findings appear as the repository's code-scanning alerts |
| **Dependency review** (`dependency-review.yml`) | Pull requests to `main` | Fails if the pull request adds a dependency with a known vulnerability of moderate severity or higher, and comments a summary when it does | Yes |
| **Dependabot auto-merge** (`dependabot-auto-merge.yml`) | Pull requests opened by Dependabot | Queues a squash merge for patch and minor updates; it completes only once the required checks pass. Major updates wait for a person. | No — automation |
| **build-images** (`build-images.yml`) | Version tags (`v*`), manual runs, and pushes to one deployment branch | Builds six images (`viz-service`, `aggregation-controlplane`, `aggregation-worker`, `stats-service`, `frontend`, `seed`), scans each with Trivy (fails on fixable HIGH or CRITICAL), and pushes them to Docker Hub | Not a pull-request check |

Two more things to know:

- A new push to the same branch cancels the run in progress for **backend-tests**, **frontend-tests** and **Schema**.
- Dependabot opens weekly update pull requests for Python, npm, Docker base images and GitHub Actions, grouping minor and patch updates (`.github/dependabot.yml`).

## Run the checks on your machine

### Backend unit suites

The required job, exactly as CI runs it:

```bash
cd backend
python -m pytest tests/ -q -m "not integration" \
  -k "falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights"
python -m pytest -q -m "not integration" $(grep -vE '^\s*(#|$)' tests/ci-required-files.txt)
```

The full suite, which CI runs as information only:

```bash
cd backend
python -m pytest tests/ -q -m "not integration"
```

While you work, run one file or one test: `python -m pytest tests/test_branding_endpoint.py -q`, adding `-k <part-of-a-test-name>` to narrow it.

Unit tests need nothing running. `backend/tests/conftest.py` gives every test an in-memory SQLite database (`db_session`), an HTTP client for the API signed in as a test administrator (`test_client`), every feature switch at its default, and a test-only signing secret.

`backend/pytest.ini` declares two markers:

| Marker | Meaning |
|---|---|
| `integration` | Needs live services. `-m "not integration"` leaves these out, which is what CI does. |
| `slow` | Declared; no test uses it today. |

Most suites under `backend/tests/integration/` also skip themselves unless you opt in, usually with `GRAPHVER_E2E=1` (versioned graphs and drafts, against Postgres) or `RUN_FALKOR_LIVE=1` (against a real FalkorDB). [Local Integration Testing](/docs/integration-testing) walks through both.

### Guards

The three guard tests parse files and import only plain configuration modules, so they need nothing but `pytest`. That is how CI runs them, and why it passes `--noconftest`: the shared `conftest.py` imports the whole backend.

```bash
python -m pytest backend/tests/test_alembic_revision_lengths.py \
  backend/tests/test_additive_migrations_mirror.py \
  backend/tests/test_feature_wiring.py -q --noconftest
python3 backend/scripts/export_config_reference.py --check
```

The pytest run ends with a `passed` count and no failures. The configuration check prints `docs/CONFIGURATION.md is up to date.` when the page matches the code; otherwise it prints a diff, says `docs/CONFIGURATION.md is out of date`, names the command that regenerates it, and exits 1.

### Schema checks

These need an empty Postgres. A throwaway container on port 5433 keeps your development database out of it:

```bash
docker run -d --name schema-check -p 5433:5432 \
  -e POSTGRES_USER=synodic -e POSTGRES_PASSWORD=synodic -e POSTGRES_DB=synodic \
  postgres:16.14-alpine
docker exec schema-check pg_isready -U synodic     # repeat until it says "accepting connections"
export MANAGEMENT_DB_URL=postgresql+asyncpg://synodic:synodic@localhost:5433/synodic
python -m backend.scripts.upgrade upgrade
python -m backend.scripts.upgrade check
python -m backend.scripts.upgrade verify-schema
docker rm -f schema-check
```

That is the **fresh install** job: each command exits 0 on success, and `upgrade` ends with `Running stamp_revision 0001_baseline -> <latest-revision>`. For the **chain replay** job, start a new empty container and run `python -m backend.scripts.upgrade upgrade --no-fast-path` instead. For the **forward migration** job, migrate the empty database from a checkout of `main` first (for example `git worktree add --detach ../main-check origin/main`, then run `python -m backend.scripts.upgrade upgrade` from `../main-check`), then run `upgrade`, `check` and `verify-schema` again from your branch. [Database Migrations](/docs/migrations) explains what each job catches.

### Live FalkorDB tests

The informational live job, against the FalkorDB version CI uses:

```bash
docker compose -f docker-compose.test.yml up -d falkordb
cd backend
RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
  python -m pytest tests/integration/test_aggregation_pipeline_live.py -q
```

CI runs `test_search_semantics_live.py`, `test_search_engine_live.py`, `test_raw_properties_live.py` and `test_search_export_live.py` from the same folder the same way.

> **Tip:** If your development stack is running, its FalkorDB already holds port 6379. Start the test one with `FALKORDB_PORT=6390 docker compose -f docker-compose.test.yml up -d falkordb` and pass `FALKORDB_PORT=6390` to the tests.

### Frontend unit suite

```bash
cd frontend
npx vitest run                          # the required job
npx vitest run src/components/docs      # one folder
npx vitest run src/components/docs/docsIntegrity.test.ts   # one file
```

The suite runs in jsdom with `src/test/setup.ts` and a 20-second per-test timeout (`frontend/vite.config.ts`). The full run takes several minutes, so run the files you touched first. CI uses Node 20; the repository and the frontend image use Node 24 (`frontend/.nvmrc`).

### Documentation checks

Three Vitest files guard the in-app readers. They run in the required frontend job; to run just them:

```bash
cd frontend
npx vitest run src/components/docs/docsIntegrity.test.ts \
  src/components/docs/mermaidDiagrams.test.ts \
  src/features/tour/tourAnchors.test.ts
```

| Test | What it checks |
|---|---|
| `docsIntegrity.test.ts` | Every registered page loads and isn't empty; every `/docs/<slug>` and `/guide/<slug>` link resolves; every `#anchor` matches a heading on the page it points at; a relative `.md` link opens the file it names; guide pages link by route only; every doc has a Diátaxis type; images under `/docs-assets` exist; no raw HTML; no GitHub links; repository-only files stay out of the readers; tour buttons name a tour that can start from the docs |
| `mermaidDiagrams.test.ts` | Every `mermaid` block under `docs/` parses with the installed Mermaid |
| `tourAnchors.test.ts` | Every guided-tour step points at a `data-tour` anchor that exists in the source |

[Contributing](/docs/contributing#add-a-documentation-or-guide-page) shows how to add a page that passes them.

### Lint and type checks

Neither is a CI gate yet: both report errors on `main` today. They still catch real mistakes in the files you changed.

```bash
cd frontend
npx eslint src/path/to/YourFile.tsx     # one file
npm run lint                            # everything, zero warnings allowed
npx tsc --noEmit                        # type-check
```

No Python linter, formatter or type checker is configured.

### Security scans

```bash
(cd frontend && npm audit --audit-level=high)
pip install pip-audit
pip-audit -r backend/requirements.txt
pip-audit -r backend/requirements-test.txt
```

`pip-audit` fails on any known vulnerability; `npm audit` here fails on high or critical ones. If you have Trivy installed, `trivy fs --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .` matches the filesystem scan.

## CI is red — what now?

Open the failed job's log; the last lines name the failing test or file. Then:

| Red job | What it usually means | What to do |
|---|---|---|
| Backend connectivity + provider suite (required) | A gated backend test fails | Run [the two commands](#backend-unit-suites) locally and fix the test or the code. Don't take a file out of `ci-required-files.txt` to get green. |
| Frontend unit suite (required) | A Vitest test fails | `npx vitest run <file>` in `frontend/` |
| A documentation test | A dead link or anchor, raw HTML, a Mermaid syntax error, or a page without a Diátaxis type | The failure message names the page and the problem; see [Contributing](/docs/contributing#add-a-documentation-or-guide-page) |
| Revision ids fit alembic_version(32) | A revision id longer than 32 characters, an entry in `init_aggregation_db`'s additive list that isn't a complete SQL statement, or a column it adds without a matching migration | Shorten the id (and every `down_revision` that names it), repair the statement, or add the migration |
| Every feature flag is really wired | A switch claims a gate or UI surface that nothing reads, ships with the wrong default for its stage, or is missing a required field | [Feature switch lifecycle](/docs/feature-flags-lifecycle) |
| Configuration reference matches the code | You added, renamed or removed an environment-variable read | Run `python3 backend/scripts/export_config_reference.py` and commit `docs/CONFIGURATION.md` |
| Any Schema job | A migration fails on one of the three ways a database is built, or the ORM has a column no migration adds | Reproduce with [the schema checks](#schema-checks); [Database Migrations](/docs/migrations) has the rules |
| npm-audit, pip-audit or trivy-fs | A dependency has a known vulnerability with a fix available | Upgrade the package; Dependabot may already have a pull request open for it |
| Dependency review | Your pull request adds a dependency with a known vulnerability | Choose a fixed version |
| A job marked informational | Existing debt, or an engine hiccup | It doesn't block. Look at it anyway if your change touches that area. |

## Where in the code

| What | Where |
|---|---|
| Workflows | `.github/workflows/*.yml`; Dependabot in `.github/dependabot.yml` |
| Pytest settings and markers | `backend/pytest.ini` |
| Shared backend fixtures | `backend/tests/conftest.py` (`db_session`, `test_client`) |
| Files the required backend job runs by name | `backend/tests/ci-required-files.txt`, guarded by `backend/tests/test_ci_required_list.py` (entries exist, sorted, no duplicates, and the workflow still reads the list) |
| Guard tests | `backend/tests/test_alembic_revision_lengths.py`, `test_additive_migrations_mirror.py`, `test_feature_wiring.py` |
| Configuration reference generator | `backend/scripts/export_config_reference.py` |
| Schema tool | `backend/scripts/upgrade.py` (`upgrade`, `check`, `verify-schema`, `repair`, `current`, `heads`, `history`) |
| Vitest settings | `frontend/vite.config.ts` (`test` block) |
| Documentation checks | `frontend/src/components/docs/docsIntegrity.test.ts`, `mermaidDiagrams.test.ts`, `frontend/src/features/tour/tourAnchors.test.ts` |

## See also

- [Local Integration Testing](/docs/integration-testing) — the Postgres and FalkorDB suites the unit jobs leave out.
- [Database Migrations](/docs/migrations) — the rules a migration follows and what each Schema job proves.
- [Feature switch lifecycle](/docs/feature-flags-lifecycle) — what the wiring guard enforces.
- [Contributing](/docs/contributing) — the change workflow these checks sit in.
