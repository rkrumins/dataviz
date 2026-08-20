/**
 * Chart theme — the palette every Analytics visual draws from.
 *
 * SVG `stroke`/`fill` cannot take a Tailwind class, so series colours have to
 * be resolved to real hex at render time. That makes this the one place in the
 * app where light/dark is a JavaScript value rather than a `dark:` variant.
 *
 * WHY THESE HEXES
 * They are the app's own brand accents (`--nx-accent-*` in globals.css), each
 * snapped to the step that passes on both surfaces. The ORDER is not cosmetic:
 * it was chosen by running every candidate ordering through a colour-vision
 * validator and keeping only those that clear all six checks in both modes.
 * This one does, with zero warnings:
 *
 *   worst adjacent CVD ΔE      10.3 light / 8.1 dark   (target ≥ 8)
 *   worst adjacent normal ΔE   26.4 light / 22.6 dark  (floor  ≥ 15)
 *   contrast vs surface        ≥ 3:1 in both modes
 *
 * So: assign slots in order and never cycle. A seventh series does not get a
 * generated hue — under colour-vision deficiency it would be indistinguishable
 * from one already on screen. Fold the tail into "Other" instead (the backend
 * already does this for categorical breakdowns).
 *
 * Colour follows the ENTITY, never its rank. A filter that drops a series must
 * not repaint the survivors, or a reader who learned "Views is amber" is being
 * misled by the next render.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { usePreferencesStore } from '@/store/preferences'

/** Categorical slots, in fixed assignment order. */
export const SERIES_LIGHT = [
    '#4f46e5', // indigo  — accent-lineage, the brand hue
    '#d97706', // amber   — accent-technical
    '#0891b2', // cyan    — accent-explore
    '#db2777', // pink
    '#7c3aed', // violet
    '#059669', // emerald — accent-business
] as const

export const SERIES_DARK = [
    '#6366f1',
    '#d97706',
    '#0891b2',
    '#ec4899',
    '#8b5cf6',
    '#059669',
] as const

/**
 * Ordinal ramp — ONE hue, low → high, for ordered magnitude (cohort heatmap,
 * funnel stages). Never a rainbow: a multi-hue ramp makes the reader decode
 * colour before they can read size.
 *
 * Five steps, not six. These are discrete marks a reader compares to each
 * other, so every step has to be visibly apart from its neighbour (ΔL ≥ 0.06)
 * AND the step nearest the surface still has to be visible against it (≥ 2:1).
 * Six steps of one hue cannot satisfy both at once on white — the sixth has to
 * come from the near-surface end, and that end washes out. Five clears every
 * gate in both modes; the light end sits at 2.98:1 / 3.87:1.
 *
 * The dark ramp runs the other way because "more" means further FROM the
 * surface, and the surface is dark. It is not the light ramp reversed — it is
 * its own selection, validated against the dark surface.
 */
export const RAMP_LIGHT = ['#818cf8', '#6366f1', '#4f46e5', '#3730a3', '#1e1b4b'] as const
export const RAMP_DARK = ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#eef2ff'] as const

export interface ChartTheme {
    isDark: boolean
    /** Categorical slots. Index by series position, never by rank. */
    series: readonly string[]
    /** Sequential ramp, low → high. */
    ramp: readonly string[]
    /** Page surface the marks sit on — also the colour of the 2px gaps/rings. */
    surface: string
    /** Hairline grid + axis rules. Recessive: one step off the surface. */
    grid: string
    /** De-emphasised chrome (crosshair, empty tracks). */
    muted: string
    /** A grey MARK — for the "Other" residual, which is not a category and so
     *  must not take a categorical slot. Solid enough to read as a segment,
     *  desaturated enough to stay behind the real classes. */
    neutralMark: string
}

const LIGHT: Omit<ChartTheme, 'isDark'> = {
    series: SERIES_LIGHT,
    ramp: RAMP_LIGHT,
    surface: '#ffffff',
    grid: 'rgba(15, 23, 42, 0.09)',
    muted: 'rgba(15, 23, 42, 0.18)',
    neutralMark: '#94a3b8',
}

const DARK: Omit<ChartTheme, 'isDark'> = {
    series: SERIES_DARK,
    ramp: RAMP_DARK,
    surface: '#161b22',
    grid: 'rgba(226, 232, 240, 0.10)',
    muted: 'rgba(226, 232, 240, 0.20)',
    neutralMark: '#64748b',
}

const SCHEME_QUERY = '(prefers-color-scheme: dark)'

/** jsdom has no `matchMedia`, and this hook is mounted by every chart — so it
 *  answers "light" rather than throwing where the API is absent. */
function schemeQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
    return window.matchMedia(SCHEME_QUERY)
}

function subscribeToScheme(onChange: () => void): () => void {
    const mq = schemeQuery()
    if (!mq) return () => {}
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
}

function systemPrefersDark(): boolean {
    return schemeQuery()?.matches ?? false
}

/**
 * Read-only sibling of `useAppliedTheme`. That hook also *applies* the theme to
 * `<html>`, and it is already mounted by AppLayout — calling it here would make
 * a chart a second applier, which is how you get duelling class writes. This
 * one only observes.
 *
 * `useSyncExternalStore` rather than an effect: the OS colour-scheme preference
 * IS an external store, and subscribing to it that way means the first render
 * already has the right answer. Mirroring it into state via an effect would
 * paint one frame in the wrong palette and then cascade a re-render.
 */
export function useChartTheme(): ChartTheme {
    const mode = usePreferencesStore((s) => s.theme)
    const systemIsDark = useSyncExternalStore(
        subscribeToScheme,
        systemPrefersDark,
        () => false,   // SSR/test snapshot: assume light rather than throw
    )
    const isDark = mode === 'dark' ? true : mode === 'light' ? false : systemIsDark

    return useMemo(() => ({ isDark, ...(isDark ? DARK : LIGHT) }), [isDark])
}

/** Dense angled motion is a vestibular risk; entrance animation is opt-out. */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ── Geometry shared by every chart ──────────────────────────────────
export const MARK = {
    /** Bars never fill their slot — the leftover band is deliberate air. */
    maxBarWidth: 24,
    /** Rounded at the data end, square at the baseline. */
    barRadius: 4,
    lineWidth: 2,
    dotRadius: 4,
    /** White doing the separating: between touching marks, and around dots. */
    surfaceGap: 2,
    /** A pointer target is bigger than the mark it selects. */
    minHitTarget: 24,
} as const


/** Fallback width before the first measurement — also what a non-layout
 *  environment (jsdom) renders at, so tests get a sane geometry. */
const FALLBACK_WIDTH = 720

/**
 * Measure the chart's container so the SVG can be drawn at 1 viewBox unit = 1
 * CSS pixel.
 *
 * A fixed viewBox with `width: 100%` does NOT do this. `preserveAspectRatio`
 * defaults to `xMidYMid meet`, which scales the drawing to FIT the box and
 * centres what is left over — so a 720-unit chart in a 1280px card renders 720
 * units wide, floating in the middle, with 560px of empty card either side.
 * Setting `preserveAspectRatio="none"` fills the width but stretches strokes
 * and text with it. Measuring is the only option that gives full width AND
 * undistorted marks.
 */
export function useChartWidth(): [React.RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement | null>(null)
    const [width, setWidth] = useState(FALLBACK_WIDTH)

    useLayoutEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver !== 'function') return
        const apply = (next: number) => {
            // Ignore a zero from a hidden tab panel — keeping the last good
            // width means switching back doesn't render a collapsed chart.
            if (next > 0) setWidth(Math.round(next))
        }
        apply(el.getBoundingClientRect().width)
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) apply(entry.contentRect.width)
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    return [ref, width]
}
