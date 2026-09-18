/**
 * The pieces the Automation modal is built from: ``PipelineRail`` (the diagram
 * that sits under the header, in the slot the wizards give their stepper),
 * ``StageRow`` for one stage's section, ``SettingRow`` for one line of a
 * stage's control ledger, and ``Advanced`` for the settings that are ranked
 * below the essentials rather than removed.
 *
 * This replaces a three-equal-column grid of stage cards. The columns were the
 * whole problem: they read as three unrelated boxes of settings, and because
 * every column was as tall as the tallest one, ① Detect ended in half a screen
 * of void while ③ Act ran the full height — which accidentally said Act mattered
 * most, when Detect is the stage that makes the other two mean anything. The
 * pipeline is now stated once, at the top, as a diagram; the stages stack
 * full-width below it in run order, each exactly as tall as its content.
 *
 * The rail is a diagram, NOT a stepper. It borrows the wizard's geometry
 * because this app already speaks that idiom, but nothing in it is navigation:
 * no pill is clickable, none of them complete, and all three are live at once.
 * The numerals are indices that encode dependency order, not progress.
 *
 * What the rail is FOR is the one failure this modal exists to make visible: a
 * stage starved by the one before it. Turn Detect off and the connector goes
 * dashed and amber, and everything downstream of it desaturates — the operator
 * SEES the dependency break instead of reading a warning they may skip.
 */
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

import { STAGES, STAGE_ACCENT, hintIdFor } from './automationCopy'

type Stage = keyof typeof STAGES

/** State changes are colour AND pattern AND word, and none of them animate for
 *  a reader who asked for stillness. */
const CALM = 'transition-opacity duration-200 motion-reduce:transition-none'

/** One pill of the rail. Not a button: there is nothing to navigate to. */
function StagePill({ stage, on, muted }: { stage: Stage; on: boolean | null; muted: boolean }) {
    const s = STAGES[stage]
    const accent = STAGE_ACCENT[stage]
    // Off is a state of the pipeline, so the pill still reads — it just stops
    // wearing its accent. Muted is the downstream consequence of someone
    // else's off, and reads as exactly that: faded, not disabled.
    const live = on !== false

    return (
        <div
            className={cn(
                'flex items-center gap-2 shrink-0 rounded-full px-3 py-1.5 text-sm font-medium',
                live ? accent.pill : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
                CALM, muted && 'opacity-45',
            )}
        >
            <span
                aria-hidden
                className={cn(
                    'w-4 h-4 shrink-0 rounded-full flex items-center justify-center',
                    'text-[10px] font-bold tabular-nums text-white',
                    live ? accent.disc : 'bg-ink-muted/60',
                )}
            >
                {s.n}
            </span>
            <span className="uppercase tracking-[0.1em] text-[12px] font-semibold">{s.name}</span>
            <span
                aria-hidden
                className={cn(
                    'w-1.5 h-1.5 shrink-0 rounded-full',
                    on == null ? 'ring-1 ring-current opacity-60'
                        : on ? 'bg-emerald-500' : 'bg-slate-400',
                )}
            />
            <span className="sr-only">
                {on == null ? 'not shown to you' : on ? 'on' : 'off'}
            </span>
        </div>
    )
}

/**
 * The seam between two stages, and the one loud thing in here.
 *
 * Feeding: a solid hairline in the downstream stage's accent. Starved: dashed,
 * amber, and labelled — the moment the upstream stage goes off, the downstream
 * cadence stops meaning what it says. The state is carried by the dash pattern
 * and the word as well as the colour, and nothing about it animates on a loop.
 */
function Connector({ into, starved, muted, unknown = false }: {
    into: Stage
    starved: boolean
    muted: boolean
    /** The reader cannot see the upstream stage's switch, so this seam has no
     *  state to report. It keeps the line — the pipeline's shape is not a claim
     *  — and says nothing, rather than asserting `feeding` about a setting the
     *  same screen tells them is hidden from them. */
    unknown?: boolean
}) {
    const accent = STAGE_ACCENT[into]

    return (
        // The caption hangs UNDER the line, so the column is padded to put the
        // line itself on the pills' centreline rather than their top edge.
        <div className="flex-1 min-w-[16px] flex flex-col items-center gap-1 px-1.5 pt-3.5">
            <span
                aria-hidden
                className={cn(
                    'w-full',
                    starved
                        ? 'border-t-2 border-dashed border-amber-500'
                        : cn('h-0.5 rounded-full', accent.line, muted && 'opacity-40'),
                    CALM,
                )}
            />
            {!unknown && (
                <span
                    className={cn(
                        'text-[10px] leading-none tracking-wide truncate',
                        starved
                            ? 'font-semibold text-amber-600 dark:text-amber-400'
                            : cn('text-ink-muted', muted && 'opacity-60'),
                    )}
                >
                    {starved ? 'starved' : 'feeding'}
                </span>
            )}
        </div>
    )
}

/**
 * The whole pipeline in one line: ① Detect → ② Check → ③ Act, in the order it
 * runs, with each seam declaring whether it is feeding the next stage.
 */
export function PipelineRail({ detect, check, act, starvedIntoCheck, starvedIntoAct }: {
    /** null = this reader is not allowed to see the setting. Saying "off"
     *  would be a lie, and saying "on" a worse one. */
    detect: boolean | null
    check: boolean
    act: boolean | null
    starvedIntoCheck: boolean
    starvedIntoAct: boolean
}) {
    return (
        <div
            role="group"
            aria-label="Automation pipeline"
            className="flex items-start min-w-0 overflow-x-auto"
        >
            <StagePill stage="detect" on={detect} muted={false} />
            {/* ``starvedIntoCheck`` is false for a reader who cannot see the
                probe setting — correctly, since we must not claim it is off.
                But that made this seam read `feeding` to exactly the reader the
                pill beside it tells `hidden`. */}
            <Connector
                into="check"
                starved={starvedIntoCheck}
                muted={false}
                unknown={detect == null}
            />
            <StagePill stage="check" on={check} muted={starvedIntoCheck} />
            <Connector into="act" starved={starvedIntoAct} muted={starvedIntoCheck} />
            <StagePill stage="act" on={act} muted={starvedIntoCheck || starvedIntoAct} />
        </div>
    )
}

/**
 * One stage's section: what it does, what it costs, its controls, and what it
 * has actually been doing.
 *
 * The three sections are identical in shape on purpose. The dialog this
 * replaces gave each policy its own box, its own vocabulary and its own units,
 * so a reader could not line them up; here the only thing that changes between
 * ①, ② and ③ is the words and one accent.
 */
export function StageRow({ stage, on, muted = false, whenOff = false, stat, children }: {
    stage: Stage
    on: boolean | null
    /** Something upstream is off, so this stage's cadence buys less than it
     *  claims — worth showing on the stage itself, not only in a warning. */
    muted?: boolean
    /** Say what this stage being OFF actually costs, in the shared words.
     *  Opt-in per host rather than derived from ``on``, because a stage can
     *  read "off" for a reason these words would misdescribe — a version-
     *  controlled source's ③ Act is off because the projector owns its
     *  rollups, and telling that reader to rebuild by hand is wrong. */
    whenOff?: boolean
    /** What this stage has actually been doing: the live count. */
    stat?: ReactNode
    children?: ReactNode
}) {
    const s = STAGES[stage]
    const accent = STAGE_ACCENT[stage]
    const headingId = `automation-stage-${stage}`

    return (
        // The accent is the ONLY border on this element. tailwind-merge folds
        // `border-{color}` and `border-l-{color}` into one conflict group, so a
        // whole-border colour listed after the accent here would silently drop
        // it — verified, not assumed.
        <section aria-labelledby={headingId} className={cn('border-l-2 pl-4 sm:pl-5', accent.rule)}>
            <div className="flex items-center gap-3">
                <span
                    aria-hidden
                    className={cn(
                        'w-6 h-6 shrink-0 rounded-full flex items-center justify-center',
                        'text-[11px] font-bold tabular-nums text-white',
                        accent.disc, CALM, muted && 'opacity-40',
                    )}
                >
                    {s.n}
                </span>
                <h3
                    id={headingId}
                    className="text-sm font-semibold uppercase tracking-[0.13em] text-ink"
                >
                    {s.name}
                </h3>
                {/* On/off only. A starved stage is still on, and saying so in a
                    third dot colour would make colour the only carrier of a
                    state the rail already spells out in words. */}
                <span className="ml-auto shrink-0 flex items-center gap-1.5">
                    <span
                        aria-hidden
                        className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            on == null ? 'ring-1 ring-ink-muted/60'
                                : on ? 'bg-emerald-500' : 'bg-slate-400',
                        )}
                    />
                    <span className="text-[11px] font-medium text-ink-muted">
                        {on == null ? 'hidden' : on ? 'on' : 'off'}
                    </span>
                </span>
            </div>

            {/* Starved dims what this stage DELIVERS — its promise and its
                numbers — and never its controls: they still work, and greying
                a live control would be the lie the dimming exists to expose. */}
            <div className={cn(CALM, muted && 'opacity-70')}>
                <p className="mt-1.5 text-[13px] text-ink-secondary leading-snug">{s.means}</p>
                <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">{s.costs}</p>
                {/* The consequence, in the slate every held/off state on this
                    page wears. Not amber: this is a state someone chose, not
                    a problem to fix. */}
                {whenOff && on === false && (
                    <p className="mt-2 rounded-lg border border-slate-500/25 bg-slate-500/[0.06] px-2.5 py-1.5 text-[11px] text-ink-secondary leading-snug">
                        {s.whenOff}
                    </p>
                )}
            </div>

            {children}

            {stat != null && (
                <p className={cn(
                    'mt-2 text-[11px] text-ink-muted tabular-nums text-right',
                    CALM, muted && 'opacity-70',
                )}>
                    {stat}
                </p>
            )}
        </section>
    )
}

/**
 * One line of a stage's control ledger: what it is on the left, the control
 * that changes it on the right, a hairline between each.
 *
 * It exists to kill five identical uppercase micro-labels. They were all the
 * same treatment, so they established no rhythm at all — they were the main
 * reason the whole modal read as one flat grey. A label that sits beside its
 * control does not need to shout to be found.
 *
 * A row with BOTH ``htmlFor`` and ``hint`` gives the hint ``hintIdFor(htmlFor)``,
 * and the control in that row must carry
 * ``aria-describedby={hintIdFor(htmlFor)}`` — the hint used to live inside the
 * ``<label>``, so it reached screen readers as part of the name, and moving it
 * out for a cleaner name took the explanation away from the readers who most
 * needed it. It is not wired here because the control is opaque: some rows pass
 * a bare input, others a wrapper holding the input plus its unit, and cloning
 * would land the attribute on whichever happened to be outermost.
 */
export function SettingRow({ label, htmlFor, hint, disabled = false, children }: {
    label: string
    /** Points the words at the control, so clicking them does something. */
    htmlFor?: string
    hint?: ReactNode
    disabled?: boolean
    children: ReactNode
}) {
    const words = 'block text-[13px] text-ink-secondary leading-snug'

    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
            <div className="min-w-0 flex-1">
                {htmlFor != null ? (
                    <label
                        htmlFor={htmlFor}
                        className={cn(words, disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
                    >
                        {label}
                    </label>
                ) : (
                    <span className={words}>{label}</span>
                )}
                {hint != null && (
                    <p
                        id={htmlFor != null ? hintIdFor(htmlFor) : undefined}
                        className="mt-0.5 text-[11px] text-ink-muted leading-snug"
                    >
                        {hint}
                    </p>
                )}
            </div>
            <div className="shrink-0 ml-auto">{children}</div>
        </div>
    )
}

/**
 * The settings that are ranked below the essentials, not removed from them.
 *
 * Closed by default, one per stage that has any. ① Detect deliberately has
 * none: it genuinely owns one setting, and an empty disclosure there would be
 * symmetry for its own sake.
 *
 * The accessible name carries the stage, because two collapsed rows both
 * reading "Advanced" would be indistinguishable to anyone not looking at the
 * screen.
 */
export function Advanced({ stage, open, onToggle, children }: {
    stage: Stage
    open: boolean
    onToggle: () => void
    children: ReactNode
}) {
    const id = `automation-${stage}-advanced`

    return (
        <div className="border-t border-glass-border/50">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                // Only while there IS a panel: pointing at an id that is not in
                // the document is a dangling reference, not a hint.
                aria-controls={open ? id : undefined}
                aria-label={`Advanced ${STAGES[stage].name} settings`}
                className={cn(
                    'flex items-center gap-1 -ml-0.5 py-2 rounded',
                    'text-[11px] font-semibold uppercase tracking-[0.13em]',
                    'text-ink-muted hover:text-ink-secondary transition-colors motion-reduce:transition-none',
                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                )}
            >
                <ChevronRight
                    aria-hidden
                    className={cn(
                        'w-3.5 h-3.5 transition-transform duration-150 motion-reduce:transition-none',
                        open && 'rotate-90',
                    )}
                />
                Advanced
            </button>
            {open && (
                <div id={id} className="pb-1 divide-y divide-glass-border/50">
                    {children}
                </div>
            )}
        </div>
    )
}
