/**
 * QueryHeader — the top of the query card, in every editor and every state.
 *
 *   ╭───────────────────────────────────────────────────────────────╮
 *   │ [ ▦ Form ][ ✦ Sentence ][ </> Code ][ >_ Cypher ]     ✎  💾  🏷  │
 *   │ FIND [◈ Entities│⌁ Connections]           ↶  ↷ │ ◉ Auto  ▶ Run │
 *   ╰───────────────────────────────────────────────────────────────╯
 *
 * The first row is the query itself — the editor it is shown in, and New,
 * Save and Tag; the second what it finds, its history, and running it.
 *
 * The editors are always one click away — an empty Form used to trade them
 * for a landing card, leaving no way back to Sentence or Code — and so are
 * undo and redo, so a Clear can be taken back from where it was made.
 */
import { motion } from 'framer-motion'
import {
    Boxes,
    Code2,
    LayoutList,
    Loader2,
    Play,
    Redo2,
    Save as SaveIcon,
    Sparkles,
    SquarePen,
    Tags,
    Terminal,
    Undo2,
    Waypoints,
} from 'lucide-react'
import {
    type ComponentType,
    type KeyboardEvent,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react'

import { Segmented } from '@/components/ui/Segmented'
import { cn } from '@/lib/utils'
import { useLibraryCanEdit } from '@/store/viewLibraryStore'

import type { EditorMode } from './builderMode'
import type { FindMode } from './findMode'


type Icon = ComponentType<{ className?: string }>

/** Form (the filter cards, where the card starts) and Sentence (guided)
 *  build a query by pointing; Code and Cypher by typing. All four edit the
 *  same draft. Each has its own tint when chosen. */
const EDITOR_MODES: { value: EditorMode; label: string; icon: Icon; tint: string }[] = [
    { value: 'form', label: 'Form', icon: LayoutList, tint: 'text-accent-lineage' },
    { value: 'sentence', label: 'Sentence', icon: Sparkles, tint: 'text-violet-500 dark:text-violet-300' },
    { value: 'code', label: 'Code', icon: Code2, tint: 'text-sky-600 dark:text-sky-300' },
    { value: 'cypher', label: 'Cypher', icon: Terminal, tint: 'text-emerald-600 dark:text-emerald-300' },
]

/** What the search finds: entities, or the connections between them. */
const FIND_MODES: { value: FindMode; label: string; icon: Icon }[] = [
    { value: 'entities', label: 'Entities', icon: Boxes },
    { value: 'connections', label: 'Connections', icon: Waypoints },
]

/** The header's width (px) from which New, Save and Tag show their names. */
const ACTION_NAMES_FROM_PX = 600
/** …from which "Find" names the Entities/Connections switch. */
const FIND_LABEL_FROM_PX = 500
/** …below which the editors not chosen show their icons alone. */
const TAB_ICONS_BELOW_PX = 440


export interface QueryHeaderProps {
    mode: EditorMode
    onModeChange: (next: EditorMode) => void
    findMode: FindMode
    onFindModeChange: (next: FindMode) => void
    /** Top-level filters still to fill in. */
    incomplete: number
    canUndo: boolean
    canRedo: boolean
    onUndo: () => void
    onRedo: () => void
    canClear: boolean
    onClear: () => void
    canSave: boolean
    onSave: () => void
    canCreateRule: boolean
    /** Why this query can make no rule, whatever is filled in. */
    ruleRefusal?: string
    onCreateRule: () => void
    runMode: 'auto' | 'manual'
    onRunModeChange: (next: 'auto' | 'manual') => void
    canRun: boolean
    hasPendingChanges: boolean
    isRunning: boolean
    onRunNow: () => void
}


export function QueryHeader(props: QueryHeaderProps) {
    const {
        mode, onModeChange, findMode, onFindModeChange, incomplete,
        canUndo, canRedo, onUndo, onRedo, isRunning,
    } = props
    const [el, setEl] = useState<HTMLDivElement | null>(null)
    // Unmeasured (jsdom, before the first measure): the editors and Find
    // named, the actions as icons.
    const width = useWidth(el)
    const roomy = (from: number) => width === 0 || width >= from

    return (
        <div ref={setEl} className={cn(
            'flex flex-col gap-2 rounded-t-2xl border-b border-glass-border/60 px-2.5 pt-2.5 pb-2',
            'bg-gradient-to-b from-white/90 to-white/40 dark:from-white/[0.045] dark:to-white/[0.01]',
        )}>
            <div className="flex items-center gap-2">
                <ModeTabs value={mode} onChange={onModeChange} iconsOnly={width > 0 && width < TAB_ICONS_BELOW_PX} />
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <SecondaryActions {...props} named={width >= ACTION_NAMES_FROM_PX} />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <div className="flex min-w-0 items-center gap-2">
                    {roomy(FIND_LABEL_FROM_PX) && (
                        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                            Find
                        </span>
                    )}
                    <Segmented
                        options={isRunning ? FIND_MODES.map((o) => ({ ...o, disabled: true })) : FIND_MODES}
                        value={findMode} onChange={onFindModeChange} label="What to find" className="shrink-0" />
                    {incomplete > 0 && (
                        <span className={cn(
                            'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium tabular-nums',
                            'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                        )}>
                            {incomplete} incomplete
                        </span>
                    )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <HistoryButtons canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />
                    <span aria-hidden className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-white/10" />
                    <AutoRunSwitch runMode={props.runMode} onRunModeChange={props.onRunModeChange} />
                    <RunButton runMode={props.runMode} canRun={props.canRun}
                               hasPendingChanges={props.hasPendingChanges} isRunning={isRunning}
                               onRunNow={props.onRunNow} />
                </div>
            </div>
        </div>
    )
}


/** The four editors as tabs: one tab stop, arrow keys move between them,
 *  and the chosen one's surface slides across to it. Narrow, the ones not
 *  chosen show their icons alone. */
function ModeTabs({ value, onChange, iconsOnly }: {
    value: EditorMode
    onChange: (next: EditorMode) => void
    iconsOnly: boolean
}) {
    const refs = useRef<Array<HTMLButtonElement | null>>([])
    // One surface per card: Studio and the panel can show a card each.
    const surface = useId()

    const move = (e: KeyboardEvent, from: number) => {
        const n = EDITOR_MODES.length
        let to: number | undefined
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (from + 1) % n
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (from - 1 + n) % n
        else if (e.key === 'Home') to = 0
        else if (e.key === 'End') to = n - 1
        if (to === undefined) return
        e.preventDefault()
        onChange(EDITOR_MODES[to].value)
        refs.current[to]?.focus()
    }

    return (
        <div role="radiogroup" aria-label="How to build the query" className={cn(
            'flex min-w-0 items-center gap-0.5 rounded-xl p-1',
            // Narrow, the strip is as wide as its tabs; else it fills the row.
            iconsOnly ? 'flex-none' : 'flex-1',
            'bg-slate-100/90 ring-1 ring-inset ring-slate-200/80',
            'dark:bg-white/[0.04] dark:ring-white/[0.07]',
        )}>
            {EDITOR_MODES.map((m, i) => {
                const on = m.value === value
                const Icon = m.icon
                const named = on || !iconsOnly
                return (
                    <button
                        key={m.value}
                        ref={(node) => { refs.current[i] = node }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={m.label}
                        title={named ? undefined : m.label}
                        tabIndex={on ? 0 : -1}
                        onClick={() => onChange(m.value)}
                        onKeyDown={(e) => move(e, i)}
                        className={cn(
                            'relative inline-flex h-8 items-center justify-center gap-1 rounded-lg',
                            !named ? 'w-9 shrink-0' : iconsOnly ? 'shrink-0 px-2.5' : 'min-w-0 flex-auto px-2',
                            'text-[12px] font-medium transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            on ? 'text-ink' : 'text-ink-muted hover:bg-white/60 hover:text-ink dark:hover:bg-white/[0.04]',
                        )}
                    >
                        {on && (
                            <motion.span
                                layoutId={`query-mode-surface-${surface}`}
                                transition={{ type: 'spring', bounce: 0.16, duration: 0.36 }}
                                className={cn(
                                    'absolute inset-0 rounded-lg bg-white',
                                    'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_0_0_1px_rgba(15,23,42,0.05)]',
                                    'dark:bg-white/[0.09] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]',
                                )}
                            />
                        )}
                        <Icon className={cn('relative h-3.5 w-3.5 shrink-0', on && m.tint)} />
                        {named && <span className="relative truncate">{m.label}</span>}
                    </button>
                )
            })}
        </div>
    )
}


/** Undo and redo, there whether or not there is anything to take back, so
 *  the header doesn't move under the pointer as the history fills. */
function HistoryButtons({ canUndo, canRedo, onUndo, onRedo }: {
    canUndo: boolean
    canRedo: boolean
    onUndo: () => void
    onRedo: () => void
}) {
    return (
        <>
            <IconButton icon={Undo2} label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={onUndo} />
            <IconButton icon={Redo2} label="Redo" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={onRedo} />
        </>
    )
}


/** New, Save and Tag: their names beside their icons when there is room. */
function SecondaryActions({
    canClear, onClear, canSave, onSave, canCreateRule, ruleRefusal, onCreateRule, isRunning, named,
}: QueryHeaderProps & { named: boolean }) {
    const canEditView = useLibraryCanEdit()
    return (
        <>
            {/* "New query", not "Clear all": people look for it by intent
                — to start a new search — and a trash can read as cleanup. */}
            <IconButton icon={SquarePen} label="New query" text={named ? 'New' : undefined}
                        title="New query (clears the current filters)"
                        disabled={!canClear || isRunning} onClick={onClear} />
            <IconButton icon={SaveIcon} label="Save query" text={named ? 'Save' : undefined}
                        title={canSave ? 'Save this query to your library' : 'Add at least one complete filter to save'}
                        disabled={!canSave || isRunning} onClick={onSave} />
            {/* A display rule is the view's: only its editors can add one. */}
            <IconButton icon={Tags} label="Create display rule" text={named ? 'Tag' : undefined}
                        title={!canEditView
                            ? 'Only people who can edit this view can add display rules'
                            : ruleRefusal ?? (canCreateRule
                                ? 'Tag every match on the canvas with a display rule'
                                : 'Add at least one complete filter to tag matches')}
                        disabled={!canCreateRule || isRunning || !canEditView} onClick={onCreateRule} />
        </>
    )
}


/**
 * Auto: every edit runs, after a short debounce — a filter you edit shows
 * you its results. Off, the query runs only when Run is pressed: the relief
 * valve for someone composing many filters at once. Chosen per browser.
 */
function AutoRunSwitch({ runMode, onRunModeChange }: {
    runMode: 'auto' | 'manual'
    onRunModeChange: (next: 'auto' | 'manual') => void
}) {
    const on = runMode === 'auto'
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Run as you edit"
            title={on
                ? 'Runs as you edit. Switch off to run only when you press Run.'
                : 'Runs only when you press Run. Switch on to run as you edit.'}
            onClick={() => onRunModeChange(on ? 'manual' : 'auto')}
            className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[11.5px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                on ? 'text-ink-secondary hover:text-ink' : 'text-ink-muted hover:text-ink',
            )}
        >
            <span aria-hidden className={cn(
                'relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-200',
                on ? 'bg-accent-lineage' : 'bg-slate-300 dark:bg-white/15',
            )}>
                <span className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200',
                    on ? 'translate-x-3.5' : 'translate-x-0.5',
                )} />
            </span>
            Auto
        </button>
    )
}


/**
 * The query's one primary action, always at the trailing edge. In Auto it
 * runs now instead of after the debounce; with Auto off it is how a query
 * runs at all, and a dot says when there are edits it hasn't run.
 */
function RunButton({ runMode, canRun, hasPendingChanges, isRunning, onRunNow }: {
    runMode: 'auto' | 'manual'
    canRun: boolean
    hasPendingChanges: boolean
    isRunning: boolean
    onRunNow: () => void
}) {
    const pending = runMode === 'manual' && hasPendingChanges && !isRunning
    const enabled = canRun && !isRunning
    return (
        <button
            type="button"
            onClick={onRunNow}
            disabled={!enabled}
            title={!canRun
                ? 'Add at least one complete filter to run'
                : hasPendingChanges ? 'Run the current draft' : 'Run the current draft again'}
            className={cn(
                'relative inline-flex h-8 items-center gap-1.5 rounded-lg px-3',
                'text-[12px] font-semibold transition-all duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50 focus-visible:ring-offset-1',
                enabled
                    ? cn(
                        'bg-accent-lineage text-white',
                        'shadow-[0_1px_2px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.18)]',
                        'hover:brightness-110 active:brightness-95',
                    )
                    : cn(
                        'cursor-not-allowed bg-slate-100 text-ink-muted/60',
                        'dark:bg-white/[0.05] dark:text-ink-muted/50',
                    ),
            )}
        >
            {isRunning
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.4} />
                : <Play className="h-3.5 w-3.5" strokeWidth={2.4} fill="currentColor" />}
            Run
            {pending && (
                <span className={cn(
                    'absolute -right-1 -top-1 h-2 w-2 rounded-full',
                    'bg-amber-400 ring-2 ring-white animate-pulse dark:ring-canvas-base',
                )} />
            )}
        </button>
    )
}


/** A quiet action: its icon, and its name beside it when there is room. */
function IconButton({ icon: Icon, label, text, title, disabled, onClick }: {
    icon: Icon
    /** The accessible name. */
    label: string
    /** The name shown beside the icon. */
    text?: string
    title: string
    disabled?: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={title}
            className={cn(
                'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-[11.5px] font-medium transition-colors',
                text ? 'px-2.5' : 'w-7',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                disabled
                    ? 'cursor-not-allowed text-ink-muted/35'
                    : 'text-ink-secondary hover:bg-slate-100 hover:text-ink dark:hover:bg-white/[0.06]',
            )}
        >
            <Icon className="h-4 w-4 shrink-0" />
            {text}
        </button>
    )
}


/** The element's width, followed as it changes. */
function useWidth(el: HTMLElement | null): number {
    const [width, setWidth] = useState(0)
    useLayoutEffect(() => {
        if (!el || typeof ResizeObserver !== 'function') return
        const ro = new ResizeObserver(() => setWidth(el.clientWidth))
        ro.observe(el)
        return () => ro.disconnect()
    }, [el])
    return width
}
