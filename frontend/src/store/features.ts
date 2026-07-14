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
    traceEnabled: true,
    graphExportEnabled: true,
    blankModelsEnabled: true,
    allowedViewModes: ['graph', 'hierarchy', 'reference', 'layered-lineage'],
    semanticLayerEditMode: true,
    semanticLayerImportEnabled: true,
    semanticLayerExportEnabled: true,
    semanticLayerAutoSuggest: true,
    semanticLayerVersionHistory: true,
    semanticLayerNonAdminEditing: false,  // fail CLOSED — see above
    signupEnabled: false,                 // fail CLOSED — this one is a door
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

/** How often a VISIBLE tab re-checks the served flags. The server caches these for 30s, and the
 *  payload is a few hundred bytes with no auth, so this is cheap. Background tabs never poll. */
const REFRESH_MS = 60_000

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
 * Two cheap signals close it, no websocket required:
 *   * the tab becoming visible again — which is what a human actually does after changing a
 *     setting in another tab, and costs one request at the moment they look;
 *   * a slow poll while visible, so a tab left open on a dashboard still converges.
 *
 * A hidden tab polls nothing: it will refresh the instant it is looked at, which is the only
 * moment its correctness matters.
 *
 * Returns a teardown for tests. Enforcement remains SERVER-side (the 403 write gate); this only
 * decides what the UI offers, so a missed refresh is a cosmetic lag, never a security hole.
 */
export function startFeaturesSync(): () => void {
    const refresh = () => {
        if (document.visibilityState !== 'visible') return
        void useFeaturesStore.getState().loadFeatures()
    }
    const onVisibility = () => refresh()
    document.addEventListener('visibilitychange', onVisibility)   // fires on document, not window
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('focus', refresh)
        window.clearInterval(timer)
    }
}
