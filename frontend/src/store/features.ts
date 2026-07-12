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

/** Seeds — mirror the backend registry defaults for the flags the app consumes. */
export const DEFAULT_FEATURES: Record<string, unknown> = {
    versioningEnabled: true,
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
    values: { ...DEFAULT_FEATURES },
    loaded: false,
    loadFeatures: async () => {
        const served = await fetchPublicFeatureValues()
        if (served) {
            set({ values: { ...DEFAULT_FEATURES, ...served }, loaded: true })
        } else {
            set({ loaded: true }) // keep seeds — fail-open
        }
    },
    setValues: (v) => set({ values: { ...DEFAULT_FEATURES, ...v } }),
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
