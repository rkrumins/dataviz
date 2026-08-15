/**
 * Feature flags store — admin-controlled capability switches, fetched once on boot.
 *
 * Mirrors the branding store: seeded with safe defaults so first paint is always
 * correct, then reconciled to the served values by ``loadFeatures()`` (best-effort;
 * a fetch failure keeps the seed — FAIL-OPEN, because the server-side 403 gate is
 * the real enforcement and a network blip must not hide whole product areas).
 *
 * Read flags through ``useFeature(key)`` in components, or ``featureEnabled(key)``
 * in imperative code (stores, event handlers). The first consumer is
 * ``versioningEnabled`` — when off, every versioning surface (edit mode, drafts,
 * reviews, history, enable-CTA, blank models) is hidden and canvases are view-only.
 */
import { create } from 'zustand'
import { fetchPublicFeatureValues } from '@/services/featuresService'
import { onAppVisible } from '@/lib/appVisibility'
import { TOPICS, subscribeToTopic } from '@/store/changeFeed'

/**
 * Seeds — mirror the backend registry defaults (`app/config/features_seed.py`) for EVERY flag
 * the app consumes.
 *
 * This list is load-bearing, not documentation. `coerce()` falls back to the seed when a key is
 * absent, and an absent key with no seed reads as FALSE — so a flag missing from here is a
 * feature that VANISHES whenever the values fetch fails. Only `versioningEnabled` was ever
 * seeded, which meant the store's fail-open promise held for exactly one flag: a network blip
 * would have hidden lineage tracing and made the product look broken, in the name of a setting
 * nobody had changed.
 *
 * Fail-open is the whole point. Enforcement lives on the server (a 403 from the feature gate);
 * the client only decides what to OFFER. If we cannot reach the server to ask, the right answer
 * is to keep showing the product, not to guess it away.
 *
 * `semanticLayerNonAdminEditing` is the exception, and deliberately: it WIDENS who may write, so
 * an unreadable value must resolve to the narrower world — the same fail-closed posture the
 * server takes. Hiding an edit button we're unsure about costs a click; showing one that 403s
 * costs trust.
 */
export const DEFAULT_FEATURES: Record<string, unknown> = {
    versioningEnabled: true,
    editModeEnabled: true,
    nodeSortingEnabled: true,             // kill switch — sort UI; saved orders always render
    traceEnabled: true,
    graphExportEnabled: true,
    blankModelsEnabled: true,
    allowedViewModes: ['graph', 'hierarchy', 'reference', 'layered-lineage'],
    // Fail OPEN to "workspaces decide". Guessing the strictest value on a
    // slow network would hide the Enterprise tier for a deployment nobody
    // had restricted — and the server refuses regardless, so the client's
    // guess must never be what stops someone sharing.
    enterpriseViewPolicy: 'workspaces',
    semanticLayerEditMode: true,
    semanticLayerImportEnabled: true,
    semanticLayerExportEnabled: true,
    semanticLayerAutoSuggest: true,
    semanticLayerVersionHistory: true,
    semanticLayerNonAdminEditing: false,  // fail CLOSED — see above
    signupEnabled: false,                 // fail CLOSED — this one is a door
    // Fail OPEN, unlike signupEnabled, and the asymmetry is the point: seeding
    // this `false` would re-create the bug it exists to control. A visitor
    // holding an invite would be turned away by a value we had not fetched yet,
    // which is exactly how invite links broke in the first place. The server
    // refuses the redemption if the flag is really off; the client's guess must
    // never be what stops someone.
    inviteLinksEnabled: true,
    toursEnabled: false,                  // experimental preview — ships OFF
    // Fail CLOSED, and for once that is the CHEAP direction rather than the
    // cautious one: off means every surface keeps its periodic check against
    // the change manifest, which is correct, just a minute slower. Guessing
    // it ON while the values fetch is still in flight would have every tab
    // open a stream the deployment may not want.
    realtimeChangeFeedEnabled: false,
}

/** Last served values, cached so a returning visitor's first paint reflects the
 *  admin's real settings instead of flashing the seeds until the fetch lands
 *  (same trick as the branding cache). Best-effort on both sides. */
const FEATURES_CACHE_KEY = 'nx-features-cache'

function readCachedValues(): Record<string, unknown> | null {
    try {
        const raw = localStorage.getItem(FEATURES_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
        return null
    }
}

function writeCachedValues(values: Record<string, unknown>): void {
    try {
        localStorage.setItem(FEATURES_CACHE_KEY, JSON.stringify(values))
    } catch {
        // private mode / quota — the flash fix simply won't apply.
    }
}

interface FeaturesState {
    values: Record<string, unknown>
    loaded: boolean
    /** Fetch public flag values and merge over the seeds. Best-effort. */
    loadFeatures: () => Promise<void>
    /** Replace served values (e.g. after an admin save on the Features page). */
    setValues: (v: Record<string, unknown>) => void
}

export const useFeaturesStore = create<FeaturesState>()((set) => ({
    values: { ...DEFAULT_FEATURES, ...(readCachedValues() ?? {}) },
    loaded: false,
    loadFeatures: async () => {
        const served = await fetchPublicFeatureValues()
        if (served) {
            writeCachedValues(served)
            set({ values: { ...DEFAULT_FEATURES, ...served }, loaded: true })
        } else {
            set({ loaded: true }) // keep seeds/cache — fail-open
        }
    },
    setValues: (v) => {
        writeCachedValues(v)
        set({ values: { ...DEFAULT_FEATURES, ...v } })
    },
}))

function coerce(values: Record<string, unknown>, key: string): boolean {
    const v = values[key]
    if (v === undefined || v === null) return Boolean(DEFAULT_FEATURES[key])
    return Boolean(v)
}

/** Reactive boolean flag read for components. Unknown/missing keys fall back to
 *  the seed default (absent from seeds ⇒ false). */
export function useFeature(key: string): boolean {
    return useFeaturesStore((s) => coerce(s.values, key))
}

/** Imperative flag read for non-React code (stores, guards, handlers). */
export function featureEnabled(key: string): boolean {
    return coerce(useFeaturesStore.getState().values, key)
}

/**
 * Read a LIST flag (`allowedViewModes`) — the set of things an admin permits.
 *
 * `useFeature` coerces to a boolean, which for a list is meaningless: a non-empty array is
 * truthy, so it would answer "yes, view modes are on" and tell you nothing about WHICH.
 *
 * Returns `null` when the flag isn't a usable list — the value hasn't arrived, the fetch failed,
 * or the key is unknown. `null` means NO RESTRICTION, not "nothing allowed": the server is the
 * enforcement, and a client that guessed "nothing" on a slow network would blank out the layout
 * picker for a setting nobody had touched.
 */
export function useFeatureList(key: string): string[] | null {
    return useFeaturesStore(s => {
        const value = s.values[key] ?? DEFAULT_FEATURES[key]
        return Array.isArray(value) && value.length > 0 ? (value as string[]) : null
    })
}

/**
 * Read a SINGLE-SELECT flag (`enterpriseViewPolicy`) — one posture chosen from a ladder.
 *
 * Neither of the readers above fits. `useFeature` coerces to a boolean, and every non-empty
 * string is truthy, so it would answer "yes" for a setting whose whole point is WHICH of three
 * values it holds — including the one that means "off". `useFeatureList` wants an array.
 *
 * Returns `null` when the value hasn't arrived or isn't one the caller recognises. `null` means
 * "assume the default", not "assume the strictest": these flags gate capabilities, and a client
 * that guessed the tightest setting on a slow network would hide sharing options for a
 * deployment nobody had restricted. The server is the enforcement either way.
 */
export function useFeatureChoice<T extends string>(
    key: string, allowed: readonly T[],
): T | null {
    return useFeaturesStore(s => {
        const value = s.values[key] ?? DEFAULT_FEATURES[key]
        return typeof value === 'string' && (allowed as readonly string[]).includes(value)
            ? (value as T)
            : null
    })
}

/**
 * Keep flags current WITHOUT a page reload.
 *
 * The values are, and always were, backend/DB-owned — a `feature_flags` row in Postgres, served
 * by `GET /api/v1/features/values`. What was missing was any way for a change to REACH a running
 * client: `loadFeatures()` ran once at boot and nothing ever asked again. So an admin could turn
 * version control off, the database and the API would agree it was off, the server would refuse
 * every versioning write — and every open tab, including the admin's own, would go on showing
 * the buttons until someone happened to hard-refresh. A flag that lies is worse than no flag.
 *
 * Two signals close it, neither of them a timer:
 *   * the tab becoming visible again — which is what a human actually does after changing a
 *     setting in another tab, and costs one request at the moment they look;
 *   * the `features` change topic moving, which is what an admin's save actually is. A tab left
 *     open on a dashboard converges within a second of the write instead of within a minute of
 *     it, and the sixty requests an hour it used to spend confirming nothing had changed are
 *     simply not made.
 *
 * The topic subscription also closes a gap the poll never could: the server's flag cache is
 * per-process with a 30s TTL, and `invalidate()` only clears the worker that served the write.
 * The other seven kept serving the old value, so whether a tab saw the change depended on which
 * worker answered it.
 *
 * Returns a teardown for tests. Enforcement remains SERVER-side (the 403 write gate); this only
 * decides what the UI offers, so a missed refresh is a cosmetic lag, never a security hole.
 */
export function startFeaturesSync(): () => void {
    const refresh = () => {
        if (document.visibilityState !== 'visible') return
        void useFeaturesStore.getState().loadFeatures()
    }
    // `onAppVisible` owns the `visibilitychange` + `focus` pair for the whole app
    // and coalesces them. Subscribing to both here meant one alt-tab fetched flags
    // twice, and this was one of five surfaces doing exactly that.
    const unsubscribeVisible = onAppVisible(refresh)
    // An admin toggling a flag is an event, so the flags refresh on that
    // event rather than on a timer that spent all day confirming nothing
    // had changed. This also closes a real gap: the server's flag cache
    // is per-process with a 30s TTL and `invalidate()` only clears the
    // worker that served the write, so the other workers went on serving
    // the old value. The bump reaches every client regardless of which
    // worker answers them.
    const unsubscribeTopic = subscribeToTopic(TOPICS.features, refresh)
    return () => {
        unsubscribeVisible()
        unsubscribeTopic()
    }
}
