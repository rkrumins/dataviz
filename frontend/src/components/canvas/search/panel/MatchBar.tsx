/**
 * MatchBar — the single source of truth for navigating search matches.
 *
 * Sits above the results list. Replaces the previous ``ResultsHeader``:
 *
 *   ┌─ MatchBar ────────────────────────────────────────────────────────┐
 *   │ 47 matches · 432 ms    [‹ 3 of 47 ›]    [H │ I │ H]  ⊞ Frame  ×  │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 *   - Counter: total matches and elapsed time.
 *   - Stepper: prev/next + "M of N". Each step bumps
 *     ``focusedMatchIndex`` in the search store, which drives both
 *     the in-panel row scroll AND the canvas auto-reveal (wired in
 *     ResultsPane).
 *   - 3-segment Highlight│Isolate│Hide toggle: sets
 *     ``canvasFilterMode`` (persisted per-view). See
 *     ``useSearchHighlight`` for the per-row semantics.
 *   - Frame: fly the canvas viewport to encompass all matches.
 *   - Clear: dismiss results.
 *
 * Pure presentational + store wiring. The auto-reveal effect lives in
 * ResultsPane (which has access to ``view.hits`` and therefore each
 * hit's ``ancestorPath``).
 */
import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertTriangle, ChevronLeft, ChevronRight,
    Crosshair, EyeOff, Filter, Maximize2, Sparkles, X,
} from 'lucide-react'
import {
    type FC, type ReactNode, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import {
    useCanvasFilterMode,
    useFocusedMatchIndex,
    useOrderedMatchUrns,
    useSearchStore,
    type CanvasFilterMode,
} from '@/store/searchStore'


export interface MatchBarProps {
    /** Total matches reported by the backend (may exceed
     *  ``orderedMatchUrns.length`` when the candidate cap was hit). */
    count: number | null
    elapsedMs: number | null
    isRunning: boolean
    errorMessage?: string | null
    truncated?: boolean
    deadlineExceeded?: boolean
    candidateCount?: number | null
    /** Frame all matches on the canvas. Hidden when no matches or
     *  when running. */
    onFrame?: () => void
    /** Fire the full reveal-on-canvas walk for the currently focused
     *  match. The stepper (and J/K keys) only updates focus state +
     *  scrolls the panel row — canvas motion is reserved for this
     *  deliberate action so the user controls when the canvas pans /
     *  expands. No-op when no focused match exists. */
    onShowFocusedOnCanvas?: () => void
    /** Clear results + draft state. */
    onClear?: () => void
    /** The view this panel is bound to — passed to setCanvasFilterMode
     *  so the choice persists for this view in localStorage. */
    viewId: string
}


export const MatchBar: FC<MatchBarProps> = ({
    count, elapsedMs, isRunning, errorMessage, truncated,
    deadlineExceeded, candidateCount, onFrame, onShowFocusedOnCanvas,
    onClear, viewId,
}) => {
    const orderedMatchUrns = useOrderedMatchUrns()
    const focusedMatchIndex = useFocusedMatchIndex()
    const canvasFilterMode = useCanvasFilterMode()
    const stepFocus = useSearchStore((s) => s.stepFocus)
    const setCanvasFilterMode = useSearchStore((s) => s.setCanvasFilterMode)

    const isError = Boolean(errorMessage)
    const showTruncation = Boolean(truncated && !isRunning && !isError)
    const showDeadlineExceeded = Boolean(
        deadlineExceeded && !isRunning && !isError,
    )

    const hasMatches = orderedMatchUrns.length > 0
    // 1-based display for humans; the stored index is 0-based.
    const displayPosition = useMemo(() => {
        if (!hasMatches) return null
        if (focusedMatchIndex === null) return 0
        return focusedMatchIndex + 1
    }, [hasMatches, focusedMatchIndex])

    return (
        <div className="flex flex-col gap-1.5">
            {/* ``flex-wrap`` + ``gap-y-1.5`` mirrors the QueryCard
                header fix: when the search panel is resized narrow,
                the action cluster wraps below the count readout
                instead of overflowing or clipping the right-most
                button ("Fram" in the bug screenshot). */}
            <div className={cn(
                'flex items-center gap-2 gap-y-1.5 flex-wrap',
                'px-2 py-1.5 rounded-lg',
                isError ? 'bg-rose-500/10 border border-rose-500/30' : '',
            )}>
                <CountReadout
                    isRunning={isRunning}
                    isError={isError}
                    errorMessage={errorMessage ?? null}
                    count={count}
                    elapsedMs={elapsedMs}
                    showTruncation={showTruncation}
                />

                <div className={cn(
                    'flex items-center gap-1.5 flex-wrap gap-y-1.5',
                    'ml-auto justify-end',
                )}>
                    {hasMatches && !isRunning && !isError && (
                        <Stepper
                            position={displayPosition ?? 0}
                            total={orderedMatchUrns.length}
                            onPrev={() => stepFocus('prev')}
                            onNext={() => stepFocus('next')}
                        />
                    )}

                    {hasMatches && !isRunning && !isError
                        && onShowFocusedOnCanvas && (
                        <button
                            type="button"
                            onClick={onShowFocusedOnCanvas}
                            disabled={focusedMatchIndex === null}
                            title={focusedMatchIndex === null
                                ? 'Use the stepper or press J / ↓ to focus a match first'
                                : 'Reveal the focused match on the canvas (Enter)'}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 h-6 rounded-md',
                                'text-[11px] font-medium transition-colors',
                                focusedMatchIndex === null
                                    ? 'bg-glass/30 text-ink-muted/50 cursor-not-allowed'
                                    : 'bg-accent-lineage text-canvas-base hover:bg-accent-lineage/90',
                            )}
                        >
                            <Crosshair className="w-3 h-3" />
                            Show
                        </button>
                    )}

                    {hasMatches && !isRunning && !isError && (
                        <ModeToggle
                            mode={canvasFilterMode}
                            onChange={(m) => setCanvasFilterMode(m, viewId)}
                        />
                    )}

                    {onFrame && !isRunning && !isError && (
                        <button
                            type="button"
                            onClick={onFrame}
                            title="Frame all matches on the canvas"
                            className={cn(
                                'inline-flex items-center gap-1 px-2 h-6 rounded-md',
                                'text-[11px] font-medium',
                                'bg-accent-lineage/15 text-accent-lineage',
                                'hover:bg-accent-lineage/25 transition-colors',
                            )}
                        >
                            <Maximize2 className="w-3 h-3" />
                            Frame
                        </button>
                    )}

                    {onClear && (
                        <button
                            type="button"
                            onClick={onClear}
                            title="Clear results"
                            className={cn(
                                'inline-flex items-center justify-center w-6 h-6 rounded-md',
                                'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors',
                            )}
                        >
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>
            </div>
            {(showTruncation || showDeadlineExceeded) && (
                <WarningBanner
                    truncated={showTruncation}
                    deadlineExceeded={showDeadlineExceeded}
                    candidateCount={candidateCount ?? null}
                />
            )}
        </div>
    )
}


function CountReadout({
    isRunning, isError, errorMessage, count, elapsedMs, showTruncation,
}: {
    isRunning: boolean
    isError: boolean
    errorMessage: string | null
    count: number | null
    elapsedMs: number | null
    showTruncation: boolean
}) {
    return (
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
            {isRunning ? (
                <span className="text-[11.5px] text-ink-muted">Searching…</span>
            ) : isError ? (
                <span className="text-[11.5px] text-rose-300 truncate" title={errorMessage ?? ''}>
                    Error · {errorMessage}
                </span>
            ) : count !== null ? (
                <>
                    <span className="text-[14px] font-display font-semibold text-ink tabular-nums">
                        {count.toLocaleString()}{showTruncation && '+'}
                    </span>
                    <span className="text-[12px] text-ink-muted">
                        {count === 1 ? 'match' : 'matches'}
                    </span>
                    {elapsedMs !== null && (
                        <span className="text-[10.5px] text-ink-muted/70 tabular-nums">
                            · {elapsedMs} ms
                        </span>
                    )}
                </>
            ) : null}
        </div>
    )
}


function Stepper({
    position, total, onPrev, onNext,
}: {
    position: number
    total: number
    onPrev: () => void
    onNext: () => void
}) {
    return (
        <div className={cn(
            'inline-flex items-center rounded-md',
            'bg-canvas-base/50 border border-glass-border/60',
        )}>
            <button
                type="button"
                onClick={onPrev}
                aria-label="Previous match"
                title="Previous match (K or ↑)"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6',
                    'text-ink-muted hover:text-ink hover:bg-glass/60',
                    'rounded-l-md transition-colors',
                )}
            >
                <ChevronLeft className="w-3 h-3" />
            </button>
            <span className={cn(
                'px-2 text-[11px] font-mono tabular-nums text-ink-secondary',
                'border-l border-r border-glass-border/40 leading-6',
            )}>
                {position === 0 ? '–' : position} of {total}
            </span>
            <button
                type="button"
                onClick={onNext}
                aria-label="Next match"
                title="Next match (J or ↓)"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6',
                    'text-ink-muted hover:text-ink hover:bg-glass/60',
                    'rounded-r-md transition-colors',
                )}
            >
                <ChevronRight className="w-3 h-3" />
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Mode toggle + premium per-mode tooltip
// ---------------------------------------------------------------------------

/**
 * Per-mode style + copy + diagram bundle. Keeping these inline (vs.
 * splitting per-mode files) lets the tooltip layout iterate on all
 * three modes from one source of truth — they share the same chrome.
 *
 * Each mode picks its own accent palette so the tooltip visually
 * tells you "this mode changes the canvas to look like THIS":
 *   - highlight → cyan (accent-lineage, the existing canvas spotlight)
 *   - isolate   → violet (focused / spotlit subset)
 *   - hide      → rose  (destructive / inverse view)
 */
interface ModeMeta {
    value: CanvasFilterMode
    label: string
    Icon: typeof Sparkles
    title: string
    description: string
    /** Single-line footer hint shown below the diagram. */
    footer: string
    /** Tailwind colour-token group keyed by accent role. Centralising
     *  these on the meta object means the tooltip + button + diagram
     *  pull from one palette per mode. */
    accent: {
        ring: string         // border + ring used on tooltip + diagram
        text: string         // primary accent text colour
        glow: string         // box-shadow colour rgba
        sweepRgba: string    // top "light sweep" rgba in tooltip
        chipBg: string       // active button background
        chipText: string     // active button text
        nodeColor: string    // SVG fill for the "primary" node in the diagram
    }
    diagram: (palette: ModeMeta['accent']) => ReactNode
}


const MODE_OPTIONS: ReadonlyArray<ModeMeta> = [
    {
        value: 'highlight',
        label: 'Highlight',
        Icon: Sparkles,
        title: 'Highlight matches',
        description:
            'Pulse the matched nodes; dim everything that doesn\'t match. The ancestor chain stays bright so you keep your bearings.',
        footer: 'Default canvas behaviour.',
        accent: {
            ring: 'border-cyan-400/40',
            text: 'text-cyan-600 dark:text-cyan-300',
            glow: 'rgba(34,211,238,0.45)',
            sweepRgba: 'rgba(34,211,238,0.55)',
            chipBg: 'bg-cyan-500/15',
            chipText: 'text-cyan-600 dark:text-cyan-300',
            nodeColor: '#22d3ee',
        },
        diagram: (palette) => <HighlightDiagram color={palette.nodeColor} />,
    },
    {
        value: 'isolate',
        label: 'Isolate',
        Icon: Filter,
        title: 'Isolate matches',
        description:
            'Render only the matches and their containment spine. Everything else is hidden — a clean view of just the result set.',
        footer: 'Best when you want to inspect matches without canvas noise.',
        accent: {
            ring: 'border-violet-400/40',
            text: 'text-violet-600 dark:text-violet-300',
            glow: 'rgba(167,139,250,0.45)',
            sweepRgba: 'rgba(167,139,250,0.55)',
            chipBg: 'bg-violet-500/15',
            chipText: 'text-violet-600 dark:text-violet-300',
            nodeColor: '#a78bfa',
        },
        diagram: (palette) => <IsolateDiagram color={palette.nodeColor} />,
    },
    {
        value: 'hide',
        label: 'Hide',
        Icon: EyeOff,
        title: 'Hide matches',
        description:
            'The inverse view: hide matched nodes, keep the rest. Useful for finding gaps in a result set.',
        footer:
            'Try it with "has owner" to surface tables WITHOUT owners.',
        accent: {
            ring: 'border-rose-400/40',
            text: 'text-rose-600 dark:text-rose-300',
            glow: 'rgba(251,113,133,0.45)',
            sweepRgba: 'rgba(251,113,133,0.55)',
            chipBg: 'bg-rose-500/15',
            chipText: 'text-rose-600 dark:text-rose-300',
            nodeColor: '#fb7185',
        },
        diagram: (palette) => <HideDiagram color={palette.nodeColor} />,
    },
] as const


function ModeToggle({
    mode, onChange,
}: {
    mode: CanvasFilterMode
    onChange: (mode: CanvasFilterMode) => void
}) {
    return (
        <div
            role="radiogroup"
            aria-label="Canvas filter mode"
            className={cn(
                'inline-flex items-center rounded-md p-0.5',
                'bg-canvas-base/50 border border-glass-border/60',
            )}
        >
            {MODE_OPTIONS.map((meta) => (
                <ModeChip
                    key={meta.value}
                    meta={meta}
                    active={mode === meta.value}
                    onSelect={() => onChange(meta.value)}
                />
            ))}
        </div>
    )
}


/**
 * One radio chip + its premium tooltip. Owns the hover state +
 * coordinate tracking so each chip can position its tooltip
 * independently (chips at the right edge of the toolbar would
 * otherwise clip the tooltip on small screens).
 */
function ModeChip({
    meta, active, onSelect,
}: {
    meta: ModeMeta
    active: boolean
    onSelect: () => void
}) {
    const { Icon, label, accent } = meta
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [hovered, setHovered] = useState(false)
    const [coords, setCoords] = useState<TooltipCoords | null>(null)

    useLayoutEffect(() => {
        if (!hovered) { setCoords(null); return }
        const update = () => {
            const r = triggerRef.current?.getBoundingClientRect()
            if (!r) return
            setCoords(computeTooltipCoords(r))
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [hovered])

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={label}
                onClick={onSelect}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => setHovered(false)}
                className={cn(
                    'inline-flex items-center gap-1 px-1.5 h-5 rounded',
                    'text-[10.5px] font-medium transition-colors',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-lineage/60',
                    active
                        ? cn(accent.chipBg, accent.chipText)
                        : 'text-ink-muted hover:text-ink',
                )}
            >
                <Icon className="w-3 h-3" />
                {label}
            </button>

            {typeof document !== 'undefined' && createPortal(
                <AnimatePresence>
                    {hovered && coords && (
                        <PremiumModeTooltip meta={meta} coords={coords} />
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    )
}


// ---------------------------------------------------------------------------
// Premium tooltip (matches SearchMatchBadge's visual identity)
// ---------------------------------------------------------------------------

const TOOLTIP_WIDTH = 280
const TOOLTIP_HEIGHT_ESTIMATE = 196


interface TooltipCoords {
    top: number
    left: number
    placeAbove: boolean
    anchorX: number
}


function computeTooltipCoords(triggerRect: DOMRect): TooltipCoords {
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth
    const spaceBelow = viewportH - triggerRect.bottom
    const placeAbove =
        spaceBelow < TOOLTIP_HEIGHT_ESTIMATE + 16
        && triggerRect.top > spaceBelow
    const idealLeft =
        (triggerRect.left + triggerRect.right) / 2 - TOOLTIP_WIDTH / 2
    const left = Math.max(
        8,
        Math.min(idealLeft, viewportW - TOOLTIP_WIDTH - 8),
    )
    const top = placeAbove ? triggerRect.top - 10 : triggerRect.bottom + 10
    const anchorX =
        (triggerRect.left + triggerRect.right) / 2 - left
    return { top, left, placeAbove, anchorX }
}


function PremiumModeTooltip({
    meta, coords,
}: {
    meta: ModeMeta
    coords: TooltipCoords
}) {
    const { Icon, title, description, footer, accent } = meta
    const caretLeft = Math.max(
        16, Math.min(TOOLTIP_WIDTH - 16, coords.anchorX),
    )
    return (
        <motion.div
            initial={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{
                position: 'fixed',
                top: coords.placeAbove ? undefined : coords.top,
                bottom: coords.placeAbove
                    ? window.innerHeight - coords.top
                    : undefined,
                left: coords.left,
                width: TOOLTIP_WIDTH,
                zIndex: 9999,
                pointerEvents: 'none',
            }}
            className={cn(
                'relative rounded-2xl border',
                accent.ring,
                'bg-gradient-to-br from-canvas-elevated via-canvas-elevated to-canvas-base/95',
                'shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.04)]',
                'backdrop-blur-xl overflow-hidden',
            )}
        >
            {/* Accent light sweep at the top — matches SearchMatchBadge's
                "glow from the trigger" feel. Each mode lights up in its
                own colour so the tooltip is recognisable at a glance. */}
            <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{
                    background: `linear-gradient(90deg, transparent, ${accent.sweepRgba}, transparent)`,
                }}
            />
            <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-16 opacity-[0.18] pointer-events-none"
                style={{
                    background: `radial-gradient(ellipse at 50% 0%, ${accent.sweepRgba}, transparent 70%)`,
                }}
            />

            {/* Hero */}
            <div className="relative px-4 pt-3.5 pb-3 flex items-start gap-3">
                <div className={cn(
                    'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                    'bg-gradient-to-br from-white/[0.04] to-white/[0.02]',
                    'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
                )} style={{
                    boxShadow: `inset 0 0 0 1px ${accent.glow.replace('0.45', '0.35')}`,
                }}>
                    <Icon
                        className={cn('w-4 h-4', accent.text)}
                        strokeWidth={2.4}
                    />
                </div>
                <div className="flex flex-col leading-tight min-w-0">
                    <span className="text-[14px] font-display font-semibold text-ink leading-none">
                        {title}
                    </span>
                    <span className="mt-1.5 text-[11.5px] text-ink-secondary leading-snug">
                        {description}
                    </span>
                </div>
            </div>

            <ModeTooltipDivider />

            {/* Diagram — "after" preview of the canvas */}
            <div className="relative px-4 pt-3 pb-3.5 flex flex-col gap-1.5">
                <div className="text-[9.5px] font-mono uppercase tracking-[0.16em] text-ink-muted/70">
                    What the canvas will look like
                </div>
                <div className={cn(
                    'flex items-center justify-center rounded-xl py-3',
                    'bg-canvas-base/40 border border-glass-border/40',
                )}>
                    {meta.diagram(accent)}
                </div>
            </div>

            <ModeTooltipDivider />

            {/* Footer hint */}
            <div className={cn(
                'px-4 py-2.5 flex items-center gap-1.5',
                'text-[10.5px] text-ink-muted/85',
            )}>
                <Sparkles
                    className={cn('w-3 h-3', accent.text)}
                    strokeWidth={2.4}
                />
                <span>{footer}</span>
            </div>

            <ModeTooltipCaret
                placeAbove={coords.placeAbove}
                left={caretLeft}
                accent={accent}
            />
        </motion.div>
    )
}


function ModeTooltipDivider() {
    return (
        <div
            aria-hidden
            className="h-px"
            style={{
                background:
                    'linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent)',
            }}
        />
    )
}


function ModeTooltipCaret({
    placeAbove, left, accent,
}: {
    placeAbove: boolean
    left: number
    accent: ModeMeta['accent']
}) {
    const common = {
        position: 'absolute' as const,
        left,
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
    }
    // Use the same translucent border-colour token as the tooltip
    // body so the caret reads as a contiguous extension of the card.
    const borderRgba = accent.glow.replace('0.45', '0.3')
    if (placeAbove) {
        return (
            <span
                aria-hidden
                style={{
                    ...common,
                    bottom: -7,
                    borderLeft: '7px solid transparent',
                    borderRight: '7px solid transparent',
                    borderTop: `7px solid ${borderRgba}`,
                    filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.4))',
                }}
            />
        )
    }
    return (
        <span
            aria-hidden
            style={{
                ...common,
                top: -7,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderBottom: `7px solid ${borderRgba}`,
                filter: 'drop-shadow(0 -1px 0 rgba(0,0,0,0.4))',
            }}
        />
    )
}


// ---------------------------------------------------------------------------
// "After" preview diagrams — one per mode
// ---------------------------------------------------------------------------

const DIAGRAM_W = 220
const DIAGRAM_H = 60
const NODE_R = 7
const NODE_Y = DIAGRAM_H / 2
const NODE_XS = [38, 110, 182] as const
const NODE_LABEL_Y = NODE_Y + 18

function HighlightDiagram({ color }: { color: string }) {
    return (
        <svg
            width={DIAGRAM_W}
            height={DIAGRAM_H}
            viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
            className="text-ink-muted"
        >
            {/* Containment line connecting ancestor → match → unrelated */}
            <line
                x1={NODE_XS[0]} y1={NODE_Y} x2={NODE_XS[2]} y2={NODE_Y}
                stroke="currentColor" strokeOpacity="0.25" strokeWidth="1"
            />
            {/* Ancestor — bright */}
            <DiagramNode
                cx={NODE_XS[0]} cy={NODE_Y} r={NODE_R}
                fill={`${color}66`} stroke={color} strokeOpacity={0.7}
                label="Ancestor"
            />
            {/* Match — pulsing glow */}
            <circle cx={NODE_XS[1]} cy={NODE_Y} r={NODE_R + 5}
                fill={color} fillOpacity={0.2}>
                <animate attributeName="r" values={`${NODE_R + 3};${NODE_R + 7};${NODE_R + 3}`}
                    dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.2;0.05;0.2"
                    dur="1.6s" repeatCount="indefinite" />
            </circle>
            <DiagramNode
                cx={NODE_XS[1]} cy={NODE_Y} r={NODE_R}
                fill={color} stroke={color} strokeOpacity={0.9}
                label="Match"
            />
            {/* Unrelated — dim */}
            <DiagramNode
                cx={NODE_XS[2]} cy={NODE_Y} r={NODE_R}
                fill="currentColor" fillOpacity={0.12}
                stroke="currentColor" strokeOpacity={0.25}
                label="Dimmed"
                labelMuted
            />
        </svg>
    )
}

function IsolateDiagram({ color }: { color: string }) {
    return (
        <svg
            width={DIAGRAM_W}
            height={DIAGRAM_H}
            viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
            className="text-ink-muted"
        >
            {/* Line only between ancestor + match (the spine) */}
            <line
                x1={NODE_XS[0]} y1={NODE_Y} x2={NODE_XS[1]} y2={NODE_Y}
                stroke="currentColor" strokeOpacity="0.35" strokeWidth="1"
            />
            <DiagramNode
                cx={NODE_XS[0]} cy={NODE_Y} r={NODE_R}
                fill={`${color}66`} stroke={color} strokeOpacity={0.7}
                label="Ancestor"
            />
            <DiagramNode
                cx={NODE_XS[1]} cy={NODE_Y} r={NODE_R}
                fill={color} stroke={color} strokeOpacity={0.9}
                label="Match"
            />
            {/* Unrelated — gone (dashed placeholder shows where it was) */}
            <g opacity={0.3}>
                <circle
                    cx={NODE_XS[2]} cy={NODE_Y} r={NODE_R}
                    fill="none" stroke="currentColor"
                    strokeDasharray="2 2"
                />
            </g>
            <DiagramLabel
                x={NODE_XS[2]} y={NODE_LABEL_Y}
                text="Hidden"
                muted
            />
        </svg>
    )
}

function HideDiagram({ color }: { color: string }) {
    return (
        <svg
            width={DIAGRAM_W}
            height={DIAGRAM_H}
            viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
            className="text-ink-muted"
        >
            {/* Line broken in the middle to show the match was removed */}
            <line
                x1={NODE_XS[0]} y1={NODE_Y} x2={NODE_XS[1] - NODE_R - 4} y2={NODE_Y}
                stroke="currentColor" strokeOpacity="0.25" strokeWidth="1"
            />
            <line
                x1={NODE_XS[1] + NODE_R + 4} y1={NODE_Y} x2={NODE_XS[2]} y2={NODE_Y}
                stroke="currentColor" strokeOpacity="0.25" strokeWidth="1"
            />
            <DiagramNode
                cx={NODE_XS[0]} cy={NODE_Y} r={NODE_R}
                fill="currentColor" fillOpacity={0.4}
                stroke="currentColor" strokeOpacity={0.7}
                label="Kept"
            />
            {/* Match — gone, dashed outline with a strikethrough X */}
            <g opacity={0.55}>
                <circle
                    cx={NODE_XS[1]} cy={NODE_Y} r={NODE_R}
                    fill="none" stroke={color} strokeDasharray="2 2"
                />
                <line
                    x1={NODE_XS[1] - 4} y1={NODE_Y - 4}
                    x2={NODE_XS[1] + 4} y2={NODE_Y + 4}
                    stroke={color} strokeWidth="1.5"
                />
                <line
                    x1={NODE_XS[1] - 4} y1={NODE_Y + 4}
                    x2={NODE_XS[1] + 4} y2={NODE_Y - 4}
                    stroke={color} strokeWidth="1.5"
                />
            </g>
            <DiagramLabel
                x={NODE_XS[1]} y={NODE_LABEL_Y}
                text="Hidden"
                color={color}
            />
            <DiagramNode
                cx={NODE_XS[2]} cy={NODE_Y} r={NODE_R}
                fill="currentColor" fillOpacity={0.4}
                stroke="currentColor" strokeOpacity={0.7}
                label="Kept"
            />
        </svg>
    )
}


/**
 * Node + label primitive shared across the three diagrams. Keeps the
 * label positioning and font tokens identical so all three previews
 * read as a coordinated set.
 */
function DiagramNode({
    cx, cy, r, fill, fillOpacity, stroke, strokeOpacity = 1,
    label, labelMuted = false,
}: {
    cx: number
    cy: number
    r: number
    fill: string
    fillOpacity?: number
    stroke?: string
    strokeOpacity?: number
    label: string
    labelMuted?: boolean
}) {
    return (
        <>
            <circle
                cx={cx} cy={cy} r={r}
                fill={fill}
                fillOpacity={fillOpacity}
                stroke={stroke ?? 'none'}
                strokeOpacity={strokeOpacity}
            />
            <DiagramLabel
                x={cx} y={NODE_LABEL_Y}
                text={label}
                muted={labelMuted}
            />
        </>
    )
}

function DiagramLabel({
    x, y, text, muted = false, color,
}: {
    x: number
    y: number
    text: string
    muted?: boolean
    color?: string
}) {
    return (
        <text
            x={x}
            y={y}
            textAnchor="middle"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
            fill={color ?? 'currentColor'}
            fillOpacity={muted ? 0.45 : (color ? 0.85 : 0.7)}
            letterSpacing="0.04em"
        >
            {text}
        </text>
    )
}


/**
 * Carried over from the previous ResultsHeader — preserves the
 * high-contrast amber/rose warning treatment for truncation and
 * deadline-exceeded states. Kept locally to keep MatchBar
 * self-contained rather than re-importing from SearchMapPanel.
 */
function WarningBanner({
    truncated, deadlineExceeded, candidateCount,
}: {
    truncated: boolean
    deadlineExceeded: boolean
    candidateCount: number | null
}) {
    return (
        <div className="flex flex-col gap-2">
            {truncated && (
                <div className={cn(
                    'flex items-start gap-2.5 px-3 py-2.5 rounded-lg',
                    'border-l-4 border-l-amber-400 border border-amber-400/50',
                    'bg-amber-500/[0.18] dark:bg-amber-500/[0.14]',
                    'shadow-[0_0_18px_-4px_rgba(245,158,11,0.35)]',
                )}>
                    <div className={cn(
                        'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                        'bg-amber-400/30 border border-amber-400/60',
                    )}>
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-700 dark:text-amber-200" strokeWidth={2.6} />
                    </div>
                    <div className="flex-1 min-w-0 text-[12px] leading-snug">
                        <div className="font-display font-semibold text-amber-900 dark:text-amber-100">
                            Results truncated — candidate cap reached
                        </div>
                        <div className="mt-0.5 text-amber-900/85 dark:text-amber-100/90">
                            {candidateCount !== null
                                ? `${candidateCount.toLocaleString()} candidates scanned before the cap fired. `
                                : 'The candidate-scan cap fired before the full result set was returned. '}
                            Some matches aren't shown. Narrow your filters,
                            tighten the scope, or raise the candidate cap in
                            Options.
                        </div>
                    </div>
                </div>
            )}
            {deadlineExceeded && (
                <div className={cn(
                    'flex items-start gap-2.5 px-3 py-2.5 rounded-lg',
                    'border-l-4 border-l-rose-400 border border-rose-400/50',
                    'bg-rose-500/[0.18] dark:bg-rose-500/[0.14]',
                    'shadow-[0_0_18px_-4px_rgba(244,63,94,0.35)]',
                )}>
                    <div className={cn(
                        'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                        'bg-rose-400/30 border border-rose-400/60',
                    )}>
                        <AlertTriangle className="w-3.5 h-3.5 text-rose-700 dark:text-rose-200" strokeWidth={2.6} />
                    </div>
                    <div className="flex-1 min-w-0 text-[12px] leading-snug">
                        <div className="font-display font-semibold text-rose-900 dark:text-rose-100">
                            Soft deadline exceeded — partial results
                        </div>
                        <div className="mt-0.5 text-rose-900/85 dark:text-rose-100/90">
                            The provider returned what it had when the
                            timeout fired. Some matches are missing.
                            Tighten the predicate, lower the candidate cap,
                            or raise the deadline in Options.
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}


