/**
 * Drift guard — fails CI if a provider-identity dispatch antipattern is
 * reintroduced into `frontend/src`.
 *
 * PR 2's frontend half (T-J/T-K/T-L/T-M) collapsed ~15 hand-maintained
 * provider-type enumeration sites (per-file label/tint/logo maps, ternaries,
 * if-chains, a duplicated `PROVIDER_TYPES` card list) onto one module,
 * `services/providerTypes.ts` — `PROVIDER_TYPE_IDS` (the id union, derived,
 * never hand-maintained) and `PROVIDER_VISUALS` (a `Record<ProviderType, …>`
 * forcing function: adding an id without its visual is a compile error).
 *
 * Nothing else stops the pattern coming back. The next person who needs a
 * provider-specific branch, or a provider-labelled lookup table, will reach
 * for `x === 'falkordb'` or `{ falkordb: …, neo4j: … }` because it's the
 * obvious thing to write. This test is what tells them `providerTypes.ts`
 * already exists instead.
 *
 * Backend twin: `backend/tests/test_provider_type_literals.py` (T-H) — same
 * source-text-scan design (runs without mounting the app), same
 * docstring/comment-stripping approach, same `{path: reason}` allow-list
 * shape, for the same reason: every current hit in this tree is either
 * prose describing the pattern (stripped below) or a narrow, reasoned
 * exception (allow-listed below), not the pattern itself.
 *
 * Two checks, matching two ways `providerTypes.ts` can be bypassed:
 *
 *   1. A comparison against a hardcoded provider-type literal
 *      (`x === 'falkordb'`, whatever `x` is called — keying the regex on a
 *      variable name instead, e.g. `providerType`, would miss `provider.type`,
 *      `row.type`, or any future spelling).
 *   2. A provider-name-keyed object literal (`{ falkordb: …, neo4j: … }`),
 *      quoted or unquoted. T-L found two real, live sites
 *      (`ProjectionPanel.tsx`, `GraphProvidersPanel.tsx`) using UNQUOTED
 *      keys that a regex requiring a quote mark cannot see — both spellings
 *      are checked here.
 *
 * Both checks are keyed on `PROVIDER_TYPE_IDS` itself, imported rather than
 * retyped: a hardcoded copy of the id list makes the guard blind to exactly
 * the id a new provider adds — the one case it exists for — while reading as
 * if it covered it. Adding an id to `providerTypes.ts` extends both regexes
 * with no edit here.
 *
 * `ShapeKind` (`'generic' | 'falkordb' | 'spanner'`, also in `providerTypes.ts`)
 * is a *different* type whose members coincide in spelling with a subset of
 * `ProviderType` — the wizard compares it ~8 times as
 * `shape.kind === 'falkordb'` / `shapeKind(x, types) === 'falkordb'`. That
 * comparison is exempted by SHAPE (see `isShapeKindComparison` below), not by
 * file path — so a genuine provider-type dispatch on any `PROVIDER_TYPE_IDS`
 * member added anywhere in that same file, including the wizard, still fails
 * this guard. A path-level exemption for the wizard would have blinded the
 * guard to the 3,000-line component most likely to grow one.
 *
 * Deliberately not covered: `ProviderOnboardingWizard.tsx`'s two
 * `formData.providerType || 'falkordb'` fallback defaults (a starting guess
 * for capability lookups before the user has picked a type, not a dispatch
 * branch — the same `supportsFeature`/`providerTypeEntry` catalog call runs
 * for every type either way, so there is no separate per-type logic to fall
 * out of sync). Neither check matches a `||` fallback as written; see T-N's
 * report for the reasoning behind leaving that as-is rather than adding a
 * third pattern for it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_TYPE_IDS } from '../providerTypes'

const FRONTEND_ROOT = resolve(__dirname, '../../..')
const SRC_ROOT = resolve(FRONTEND_ROOT, 'src')

// Imported, never retyped -- see the header. A hardcoded copy would have to
// be edited by the same PR that adds a provider, i.e. exactly when the guard
// is supposed to be watching without being asked.
const _PROVIDER_ALT = PROVIDER_TYPE_IDS.join('|')

// Directories that may contain provider-identity text that isn't production
// dispatch (fixtures, generated snapshots) -- excluded by name wherever they
// might appear, matching the backend guard's own exclusion list.
const _EXCLUDED_DIR_NAMES = new Set(['__fixtures__', 'node_modules'])

function isScannedFile(name: string): boolean {
    return /\.(ts|tsx)$/.test(name) && !name.includes('.test.')
}

function* iterScannedFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (_EXCLUDED_DIR_NAMES.has(entry.name)) continue
            yield* iterScannedFiles(join(dir, entry.name))
        } else if (entry.isFile() && isScannedFile(entry.name)) {
            yield join(dir, entry.name)
        }
    }
}

/** Replaces a matched span with newlines only, so stripping a comment can't
 *  shift the line numbers of the code after it -- same trick as the backend
 *  guard's `_blank_span`, adapted from Python triple-quoted docstrings to
 *  JS/TS block comments. */
function blankSpan(match: string): string {
    return '\n'.repeat((match.match(/\n/g) ?? []).length)
}

function stripComments(src: string): string {
    // Block comments /* ... */ -- also covers a JSX comment `{/* ... */}`,
    // which leaves a harmless empty `{}` behind.
    src = src.replace(/\/\*[\s\S]*?\*\//g, blankSpan)
    // Full-line // comments only (leading whitespace then // to EOL): a
    // trailing `code // comment` is left alone -- same tradeoff the backend
    // guard makes, for the same reason: `//` can appear inside a string
    // literal (a URL), so a trailing-comment stripper is more likely to
    // corrupt real code than earn its keep. Verified live below (Check 1's
    // own allow-list-adjacent comment on line 840 of ProviderOnboardingWizard.tsx,
    // and a "no mock: ..." prose comment in test/canvasHarness.tsx, both
    // stripped here -- without this, both would fail their respective check).
    src = src.replace(/^[ \t]*\/\/.*$/gm, '')
    return src
}

/** Every match of `pattern` outside `allowed` (`{relative posix path:
 *  reason}`), formatted as `path:line: "matched text"`. `isExempt`, when
 *  given, receives up to 100 chars immediately before a match and can
 *  suppress it structurally (by shape, not by path). */
function scan(pattern: RegExp, allowed: Record<string, string>, isExempt?: (before: string) => boolean): string[] {
    const violations: string[] = []
    for (const file of iterScannedFiles(SRC_ROOT)) {
        const rel = relative(FRONTEND_ROOT, file)
        if (rel in allowed) continue
        const src = stripComments(readFileSync(file, 'utf8'))
        for (const m of src.matchAll(pattern)) {
            const index = m.index ?? 0
            if (isExempt?.(src.slice(Math.max(0, index - 100), index))) continue
            const line = src.slice(0, index).split('\n').length
            violations.push(`${rel}:${line}: ${JSON.stringify(m[0])}`)
        }
    }
    return violations
}

// ---------------------------------------------------------------------------
// Pattern A -- a hardcoded provider-type literal compared for (in)equality.
// ---------------------------------------------------------------------------

const _COMPARISON_RE = new RegExp(`(?:===|!==|==|!=)\\s*['"](?:${_PROVIDER_ALT})['"]`, 'g')

/** `ShapeKind` ('generic' | 'falkordb' | 'spanner') coincides in spelling
 *  with a subset of `ProviderType` -- exempt the shape (`.kind === '…'` /
 *  `shapeKind(…) === '…'`), not a file, so a genuine provider-type
 *  comparison added later still fails the guard. */
const _SHAPE_KIND_RE = /(?:\.kind|shapeKind\([^)]*\))\s*$/

function isShapeKindComparison(before: string): boolean {
    return _SHAPE_KIND_RE.test(before)
}

// Re-derived by direct verification against this tree (2026-08-31), not
// transcribed from the plan's §6.3 (which asserted "Allow-list: none" and
// used a regex that cannot see an unquoted key -- see T-N's report).
const _COMPARISON_ALLOWED: Record<string, string> = {
    'src/components/admin/AdminInfrastructure/ServiceTile.tsx':
        "svc.key is an infrastructure service key (vizService, managementDb, busRedis, " +
        "cacheRedis, falkordb, aggregationWorker, statsService, ...) -- workSignal()'s switch " +
        "and qualifier()'s comparisons branch on which infra tile is rendering, not on graph " +
        'provider identity. A new provider type needs no new service tile.',
    'src/components/admin/AdminRedis/index.tsx':
        "role.role is a RedisRole ('streams' | 'cache' | 'falkordb'), the platform's own Redis " +
        'endpoint role -- not a graph provider type. A new provider type needs no new Redis role.',
    'src/components/views/ViewWizard/steps/ScopeStep.tsx':
        'PROVIDER_TYPE_ORDER derives its list FROM PROVIDER_TYPE_IDS (the catalog\'s own source ' +
        "of truth) and excludes only the synthetic, non-backend 'mock' entry from the display " +
        'order -- not a parallel enumeration of real provider types. (Filtering on the catalog\'s ' +
        'own `adminVisible` flag instead would remove even this one literal, but that is a ' +
        "call-site change outside T-N's scope as the drift guard.)",
}

// ---------------------------------------------------------------------------
// Pattern B -- a provider-name-keyed object literal (the old PROVIDER_VISUALS
// / PROVIDER_LABEL / TYPE_LABEL shape), quoted or unquoted. T-L found two
// real sites using the UNQUOTED form (ProjectionPanel.tsx,
// GraphProvidersPanel.tsx) that a quote-requiring regex missed entirely --
// both spellings share one allow-list below, mirroring the backend guard's
// Check 1 (one allow-list covers both its direct- and normalized-comparison
// regexes).
// ---------------------------------------------------------------------------

const _QUOTED_KEY_RE = new RegExp(`['"](?:${_PROVIDER_ALT})['"]\\s*:`, 'g')
// Excludes a preceding `.` / word char / quote so a longer identifier
// (`falkordbConnection:`) can't match, and an already-quoted key
// (`'falkordb':`, counted once by the regex above) is never double-counted.
const _UNQUOTED_KEY_RE = new RegExp(`(?<![.\\w'"])(?:${_PROVIDER_ALT})\\s*:`, 'g')

// Re-derived the same way as _COMPARISON_ALLOWED -- the plan's own "none"
// claim is false partly *because* fixing the unquoted-key blind spot
// necessarily starts matching providerTypes.ts's own PROVIDER_VISUALS and a
// Redis-role map. Two more turned up that neither the plan nor the brief
// anticipated (ServiceTile.tsx's switch-case label, and a wizard form-state
// field name) -- see T-N's report for why each is a false positive for this
// check specifically, not a real provider-identity enumeration.
const _OBJECT_KEY_ALLOWED: Record<string, string> = {
    'src/services/providerTypes.ts':
        'this IS the source of truth -- PROVIDER_VISUALS is the one place a provider id is ' +
        "allowed to key an object literal (see its own doc comment on why it's a typed " +
        'Record<ProviderType, …> forcing function, not a Partial<>).',
    'src/components/admin/AdminRedis/index.tsx':
        "ROLE_CONTENT is a Record<RedisRole, RoleContent> -- 'falkordb' here is the Redis role " +
        'key (same underlying reason as the Pattern-A entry above for this file), not a ' +
        'provider-type enumeration map.',
    'src/components/admin/AdminInfrastructure/ServiceTile.tsx':
        "`case 'falkordb':` in workSignal()'s switch on svc.key -- a switch-case label, not an " +
        'object-literal enumeration of provider types (same underlying reason as the Pattern-A ' +
        'entry above for this file: svc.key is a service key).',
    'src/components/admin/ProviderOnboardingWizard.tsx':
        'the `spanner` field on ProviderOnboardingFormData/buildInitialFormData names the ' +
        'sub-object of Spanner-specific form fields -- a single struct field that happens to ' +
        'share a provider id\'s spelling, not a provider-keyed dispatch map (its sibling fields ' +
        'are `falkordbConnection` and `generic`, never another provider id). Pattern A is NOT ' +
        'exempted by path for this file -- only the structural ShapeKind exemption above applies ' +
        'there -- so a genuine provider-type dispatch on any PROVIDER_TYPE_IDS member added to ' +
        'this file still fails this guard.',
}

describe('provider-type literal drift guard', () => {
    it('no comparison against a hardcoded provider-type literal outside the allow-list', () => {
        const violations = scan(_COMPARISON_RE, _COMPARISON_ALLOWED, isShapeKindComparison)
        expect(violations).toEqual([])
    })

    it('no provider-name-keyed object literal outside the allow-list, quoted or unquoted', () => {
        const violations = [
            ...scan(_QUOTED_KEY_RE, _OBJECT_KEY_ALLOWED),
            ...scan(_UNQUOTED_KEY_RE, _OBJECT_KEY_ALLOWED),
        ]
        expect(violations).toEqual([])
    })
})
