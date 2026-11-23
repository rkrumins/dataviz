/**
 * SettingRow — one setting, complete: what it is, the control that states and changes its value,
 * where that value came from, why it differs from the one chosen (with the fix), and on demand
 * everything needed to decide.
 *
 * - The control states the value; a row the viewer may not change states it with `LockedValue`,
 *   saying who can. A status badge shows only when the value chosen isn't the value in force.
 * - The BUSINESS lens titles the row with the setting's question ("What should people see while
 *   new data loads?"), draws choices as outcome cards, and says in one line under the control where
 *   the value comes from ("From the platform: 30 days", "Set for this workspace", "Locked by the
 *   platform", "Kept as an exception", or what is in force now when it was adjusted).
 * - The OPERATOR lens titles it with the label and adds the env var, when a change takes effect,
 *   any deployment cap with its value (for a system admin), the measured evidence on demand, and
 *   the whole trail Default → Platform → Workspace → Graph, which says where the value came from.
 * - Changing the control STAGES a value; so do the footer's actions. Nothing here saves. A staged
 *   row carries the accent: a bar, the server's answer for it under the control ("Once saved: …",
 *   and "Chosen: …" when the value in force would differ; "Checking…" until it answers; nothing
 *   while the value needs a fix), and the change on its trail.
 * - The footer offers one way back to the inherited value; when that is the recommended value too
 *   (as it is for every setting's default), it says so rather than offering a second button. What
 *   the platform's own facts suggest, when it isn't in force, is said in the open, not in a tip.
 * - Each row has an anchor (`#reads-mode`) and a button that copies a link to it.
 * - A change of status (after a save, or a switch turned on) is announced.
 */
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, CornerDownRight, FlaskConical, Link2, Lock, Server, ShieldAlert, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { EDITOR_LABEL, formatValue, inheritedAt, lockedFor, ownValue, SCOPE_HERE, SCOPE_LABEL, sameValue, settingAnchor, stepAt } from './format'
import { GuidancePanel } from './GuidancePanel'
import type { Lens } from './lens'
import { SCOPE_ICON, STATUS_META } from './meta'
import { ProvenanceTrail } from './ProvenanceTrail'
import { SettingControl } from './SettingControl'
import { StatusBadge } from './StatusBadge'
import type { DimensionInfo, ResolvedSetting, Scope, Setting, SettingValue, Term, WhyFix, WhyItem } from './types'
import { WhyBanner } from './WhyBanner'

export interface SettingRowProps {
    setting: Setting
    resolved: ResolvedSetting
    /** The level being edited. */
    scope: Scope
    lens?: Lens
    /** A value staged at this scope; undefined when nothing is staged. */
    staged?: SettingValue | null
    onStage: (value: SettingValue | null) => void
    onUnstage?: () => void
    /** What is wrong with the staged value. */
    error?: string | null
    /** The server's answer for the staged values (the quick preview): what is in force once saved.
     *  Only an answer for the value staged now is shown. */
    preview?: ResolvedSetting
    /** That answer is on its way. */
    checking?: boolean
    onFix?: (fix: WhyFix, item: WhyItem) => void
    fixLabel?: (fix: WhyFix) => string
    dimensions?: DimensionInfo[]
    glossary?: Term[]
    /** An explainer drawn in the guidance panel (SettingVisual). */
    visual?: ReactNode
    defaultOpen?: boolean
    /** The row a deep link pointed at. */
    highlighted?: boolean
    className?: string
    /** Drawn inside the row, under the control: what the page adds (the platform's limits, the
     *  server's preview of a staged value). */
    children?: ReactNode
}

/**
 * A value the viewer can't change here, stated where its control would be: the value, and why it
 * can't be changed (who can). Without `why`, the value alone, for a row that says why beside it.
 */
export function LockedValue({ setting, value, why, className }: {
    setting: Setting
    value: SettingValue | null
    why?: string
    className?: string
}) {
    return (
        <div className={cn('flex items-start gap-2 rounded-xl bg-black/[0.03] px-3.5 py-2.5 dark:bg-white/[0.04]', className)}>
            <Lock aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-ink">{formatValue(setting, value)}</p>
                {why && <p className="text-[12.5px] text-ink-secondary">{why}</p>}
            </div>
        </div>
    )
}

/** Who the level a value comes from is, in a sentence: "the platform", "your deployment". */
function fromWho(source: ResolvedSetting['source']): string {
    if (source === 'env') return 'your deployment'
    return `the ${SCOPE_LABEL[source].toLowerCase()}`
}

/**
 * The Business view's provenance, in one line: where the value in force comes from, said once.
 * A lock or an exception is always said, as the trail would; a value the platform adjusted, or a
 * deployment value it couldn't use, says what is in force now (the why beside it says why).
 */
function Provenance({ setting: s, resolved: r, scope }: { setting: Setting; resolved: ResolvedSetting; scope: Scope }) {
    const locked = lockedFor(r, scope)
    const exception = r.status === 'exception' || (r.source !== 'env' && Boolean(stepAt(r, r.source)?.exception))
    const value = formatValue(s, r.effective)
    // A switch and a choice say their value themselves; a number's own field shows it only faintly.
    const says = s.kind === 'bool' || s.kind === 'choice'
    let words: string
    let Icon = r.source === 'env' ? Server : SCOPE_ICON[r.source]
    if (locked) {
        words = 'Locked by the platform'
        Icon = Lock
    } else if (r.status === 'adjusted' || r.status === 'invalid_env') words = `In force now: ${value}`
    else if (r.source === scope) words = `Set for ${SCOPE_HERE[scope]}`
    else if (says) words = `Follows ${r.source === 'default' ? 'the default' : fromWho(r.source)}`
    else words = r.source === 'default' ? `The default: ${value}` : `From ${fromWho(r.source)}: ${value}`
    return (
        <p className="mt-2.5 space-y-1 text-[12.5px] leading-snug text-ink-secondary">
            <span className="flex min-w-0 items-start gap-1.5">
                <Icon aria-hidden className="mt-px w-3.5 h-3.5 shrink-0" />
                <span>{words}</span>
            </span>
            {exception && (
                <span className="flex items-start gap-1.5 font-medium text-sky-700 dark:text-sky-300">
                    <ShieldAlert aria-hidden className="mt-px w-3.5 h-3.5 shrink-0" />
                    <span>Kept as an exception</span>
                </span>
            )}
        </p>
    )
}

function CopyLink({ anchor, label }: { anchor: string; label: string }) {
    const [copied, setCopied] = useState(false)
    const copy = () => {
        const { origin, pathname, search } = window.location
        navigator.clipboard?.writeText(`${origin}${pathname}${search}#${anchor}`).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
        }, () => {})
    }
    return (
        <HoverTip label={copied ? 'Link copied' : 'Copy a link to this setting'} className="inline-flex">
            <button
                type="button"
                onClick={copy}
                aria-label={copied ? `Link to ${label} copied` : `Copy a link to ${label}`}
                className="grid place-items-center w-8 h-8 rounded-lg text-ink-secondary transition-colors hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
                {copied ? <Check aria-hidden className="w-4 h-4 text-emerald-500" /> : <Link2 aria-hidden className="w-4 h-4" />}
            </button>
        </HoverTip>
    )
}

/** A footer action that names a value: on a phone it wraps rather than widening the page. */
const FOOTER_ACTION = 'h-auto min-h-7 max-w-full whitespace-normal py-1 text-left text-ink-secondary'

/** A button with its reason on hover, when it has one. */
const tipped = (tip: string | null, button: ReactNode) => (tip ? <HoverTip label={tip} className="inline-flex">{button}</HoverTip> : button)

export function SettingRow({
    setting: s, resolved, scope, lens = 'business', staged, onStage, onUnstage, error, preview, checking = false, onFix, fixLabel,
    dimensions = [], glossary, visual, defaultOpen = false, highlighted = false, className, children,
}: SettingRowProps) {
    const [open, setOpen] = useState(defaultOpen)
    // Announce a change of status, not the status a row opens with.
    const [seenStatus, setSeenStatus] = useState(resolved.status)
    const [announcement, setAnnouncement] = useState('')
    if (seenStatus !== resolved.status) {
        setSeenStatus(resolved.status)
        setAnnouncement(`${s.label}: ${STATUS_META[resolved.status].label}. ${resolved.why[0]?.text ?? STATUS_META[resolved.status].hint}`)
    }

    const anchor = settingAnchor(s.key)
    const ids = { title: `${anchor}-title`, summary: `${anchor}-summary`, panel: `${anchor}-guidance`, error: `${anchor}-error` }
    const isStaged = staged !== undefined
    const own = isStaged ? staged : ownValue(resolved, scope)
    const inherit = inheritedAt(resolved, scope)
    const next = own ?? inherit.value
    // The server's answer, when it is for the value staged now (an answer for an earlier one is kept
    // while the next is asked for); never while that value needs a fix.
    const answer = isStaged && !error && preview && sameValue(ownValue(preview, scope), staged) ? preview : undefined
    const locked = lockedFor(resolved, scope)
    const editable = resolved.editable && !locked && Boolean(s.scopes[scope])
    const business = lens === 'business'
    const title = business && s.question ? s.question : s.label
    const { recommended } = s.guidance
    const rec = recommended.forThisPlatform?.value ?? recommended.value
    // Going back to the inherited value is going to the recommended one: one action, said so.
    const recInherited = sameValue(rec, inherit.value)
    // What this platform's facts suggest, while it isn't the value in force: said in the open.
    const suggested = recommended.forThisPlatform && !sameValue(recommended.forThisPlatform.value, resolved.effective) ? recommended.forThisPlatform : null
    const wide = s.kind === 'choice' && (business || s.choices.some((c) => c.frames.length > 0))
    const readOnlyWhy = locked
        ? 'The platform locked this value.'
        : !s.scopes[scope]
            ? `Set at another level than ${scope === 'graph' ? 'a graph' : scope === 'workspace' ? 'a workspace' : 'the platform'}.`
            : resolved.editor ? `Only ${EDITOR_LABEL[resolved.editor]} can change it here.` : 'You can’t change it here.'
    const inheritLabel = inherit.scope === 'default' ? 'Use the default' : `Use the ${SCOPE_LABEL[inherit.scope].toLowerCase()}’s value`

    const control = editable ? (
        <SettingControl
            setting={s}
            value={own}
            onChange={onStage}
            resolved={resolved}
            scope={scope}
            lens={lens}
            dimensions={dimensions}
            invalid={Boolean(error)}
            inheritNote={false}
            aria-labelledby={ids.title}
            aria-describedby={error ? `${ids.summary} ${ids.error}` : ids.summary}
        />
    ) : (
        // In Business a lock is said once, by the line under it.
        <LockedValue setting={s} value={resolved.effective} why={business && locked ? undefined : readOnlyWhy} />
    )

    return (
        <article
            id={anchor}
            // A deep link moves focus here (and screen readers with it); never a tab stop.
            tabIndex={-1}
            aria-labelledby={ids.title}
            className={cn(
                'relative scroll-mt-24 rounded-2xl border bg-canvas-elevated outline-none transition-[border-color,box-shadow] duration-200',
                'focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                isStaged ? 'border-accent-lineage/35' : 'border-glass-border/50',
                highlighted && 'shadow-[0_0_0_4px_rgb(var(--nx-divider-rgb)/0.08)]',
                className,
            )}
        >
            {isStaged && <span aria-hidden className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-accent-lineage" />}
            {/* Words and control side by side where the row is wide enough, stacked where it isn't:
                sized by the row (a page, a drawer, a phone), not by the window. */}
            <div className="flex flex-wrap gap-x-8 gap-y-5 p-5 sm:p-6">
                <div className={cn('min-w-0 space-y-3', wide ? 'basis-full' : 'flex-[999_1_26rem]')}>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1 basis-64">
                            {business && s.question && (
                                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{s.label}</p>
                            )}
                            <h3 id={ids.title} className={cn('text-[15px] font-semibold tracking-tight text-ink', business && s.question && 'mt-0.5')}>
                                {title}
                            </h3>
                            <p id={ids.summary} className="mt-1 max-w-prose text-[13.5px] leading-relaxed text-ink-secondary">{s.guidance.summary}</p>
                        </div>
                        {/* "In effect" is the quiet default: only a status that isn't says so. */}
                        {resolved.status !== 'in_effect' && <StatusBadge status={resolved.status} className="shrink-0" />}
                    </div>

                    {!business && (
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-secondary">
                            {/* A long env var wraps rather than widening a phone's page. */}
                            {s.default.env && <code className="min-w-0 rounded-md bg-black/[0.04] px-1.5 py-px font-mono text-[11.5px] text-ink-secondary [overflow-wrap:anywhere] dark:bg-white/[0.06]">{s.default.env}</code>}
                            <span>{s.takesEffect.text}</span>
                            {s.caps.filter((c) => c.deployment).map((c) => (
                                <span key={c.deployment} className="min-w-0">
                                    {c.value != null ? <>Capped at <span className="font-semibold text-ink">{formatValue(s, c.value)}</span> by </> : 'Capped by '}
                                    <code className="font-mono text-[11.5px] [overflow-wrap:anywhere]">{c.deployment}</code>
                                    {c.value === null && c.problem && <>: its value couldn’t be read. {c.problem}</>}
                                </span>
                            ))}
                            {s.guidance.evidence && (
                                <HoverTip label={s.guidance.evidence} width="data" className="inline-flex">
                                    <button type="button" onClick={() => setOpen(true)} aria-controls={ids.panel}
                                        className="inline-flex items-center gap-1 rounded font-medium text-ink-secondary underline decoration-dotted underline-offset-[3px] outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                        <FlaskConical aria-hidden className="w-3 h-3" /> Evidence
                                    </button>
                                </HoverTip>
                            )}
                        </p>
                    )}

                    {!business && <ProvenanceTrail setting={s} resolved={resolved} scope={scope} staged={staged} />}
                    <WhyBanner why={resolved.why} onFix={onFix} fixLabel={fixLabel} compact />
                </div>

                <div className={cn('min-w-0', wide ? 'basis-full' : 'flex-[1_1_18rem] max-w-[28rem] pt-1')}>
                    {control}
                    <p id={ids.error} aria-live="polite" className={cn('text-[12.5px] font-medium text-rose-600 dark:text-rose-400', error ? 'mt-2' : 'sr-only')}>
                        {error ?? ''}
                    </p>
                    {business && <Provenance setting={s} resolved={resolved} scope={scope} />}
                    {answer ? (
                        <div className="mt-2.5 space-y-0.5">
                            <p className="text-[12.5px] font-semibold text-indigo-700 dark:text-indigo-300">Once saved: {formatValue(s, answer.effective)}</p>
                            {answer.declared !== null && !sameValue(answer.declared, answer.effective) && (
                                <p className="text-[12.5px] text-ink-secondary">Chosen: {formatValue(s, answer.declared)}</p>
                            )}
                        </div>
                    ) : isStaged && !error && checking ? (
                        <p className="mt-2.5 text-[12.5px] text-ink-secondary">Checking…</p>
                    ) : null}
                </div>
            </div>

            {children && <div className="-mt-1 px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>}

            {suggested && (
                <div className="-mt-1 px-5 pb-5 sm:px-6 sm:pb-6">
                    <div className="flex items-start gap-2.5 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] px-3.5 py-3 dark:border-indigo-400/25 dark:bg-indigo-400/[0.06]">
                        <Sparkles aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
                        <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-ink">Suggested for your platform: {formatValue(s, suggested.value)}</p>
                            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{suggested.why}</p>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5 border-t border-glass-border/50 px-3 py-2 sm:px-4">
                <Button size="sm" variant="ghost" rightIcon={ChevronDown} aria-expanded={open} aria-controls={ids.panel}
                    onClick={() => setOpen((o) => !o)} className={cn('text-ink-secondary [&>svg:last-child]:transition-transform', open && '[&>svg:last-child]:rotate-180')}>
                    {open ? 'Less' : 'How it works'}
                </Button>
                {editable && !recInherited && !sameValue(next, rec) && tipped(suggested ? null : recommended.forThisPlatform?.why ?? recommended.why, (
                    <Button size="sm" variant="ghost" leftIcon={Sparkles} onClick={() => onStage(rec)} className={FOOTER_ACTION}>
                        Use recommended · {formatValue(s, rec)}
                    </Button>
                ))}
                {editable && own !== null && tipped(recInherited && !suggested ? recommended.forThisPlatform?.why ?? recommended.why : null, (
                    <Button size="sm" variant="ghost" leftIcon={recInherited ? Sparkles : CornerDownRight} onClick={() => onStage(null)} className={FOOTER_ACTION}>
                        {inheritLabel} · {formatValue(s, inherit.value)}{recInherited && ' (recommended)'}
                    </Button>
                ))}
                {isStaged && onUnstage && (
                    <Button size="sm" variant="ghost" leftIcon={Undo2} onClick={onUnstage} className="text-ink-secondary">Revert</Button>
                )}
                <span className="ml-auto" />
                <CopyLink anchor={anchor} label={s.label} />
            </div>

            <div id={ids.panel} hidden={!open} className="border-t border-glass-border/50 p-5 sm:p-6">
                {open && (
                    <GuidancePanel setting={s} dimensions={dimensions} glossary={glossary} lens={lens} current={next}
                        onUseRecommended={editable ? onStage : undefined} visual={visual} />
                )}
            </div>
            <span className="sr-only" aria-live="polite">{announcement}</span>
        </article>
    )
}
