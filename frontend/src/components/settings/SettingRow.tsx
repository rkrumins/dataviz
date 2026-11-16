/**
 * SettingRow — one setting, complete: what it is, the value in force and where it came from, why
 * it differs from the one chosen (with the fix), the control to change it, and on demand everything
 * needed to decide.
 *
 * - The BUSINESS lens titles the row with the setting's question ("What should people see while
 *   new data loads?") and draws choices as outcome cards; the OPERATOR lens titles it with the
 *   label and adds the env var, when a change takes effect, any deployment cap with its value (for
 *   a system admin), and the measured evidence on demand.
 * - Beside the value in force, the level it came from ("From Platform", "Set at Graph").
 * - Changing the control STAGES a value; so does "Use recommended" and "Use the platform's". Nothing
 *   here saves. A staged row carries the accent: a bar, the server's answer for it ("Once saved: …",
 *   and "Chosen: …" when the value in force would differ; "Checking…" until it answers; nothing
 *   while the value needs a fix), and the change on its trail.
 * - A row the viewer may not change shows its value and says who can.
 * - Each row has an anchor (`#reads-mode`) and a button that copies a link to it.
 * - A change of status (after a save, or a switch turned on) is announced.
 */
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, CornerDownRight, FlaskConical, Link2, Lock, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { EDITOR_LABEL, formatValue, inheritedAt, lockedFor, ownValue, SCOPE_LABEL, sameValue, settingAnchor } from './format'
import { GuidancePanel } from './GuidancePanel'
import type { Lens } from './lens'
import { STATUS_META } from './meta'
import { ProvenanceTrail } from './ProvenanceTrail'
import { ScopeBadge } from './ScopeBadge'
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
    const rec = s.guidance.recommended.forThisPlatform?.value ?? s.guidance.recommended.value
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
            aria-labelledby={ids.title}
            aria-describedby={error ? `${ids.summary} ${ids.error}` : ids.summary}
        />
    ) : (
        <div className="flex items-start gap-2 rounded-xl bg-black/[0.03] px-3.5 py-2.5 dark:bg-white/[0.04]">
            <Lock aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-ink-muted" />
            <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">{formatValue(s, resolved.effective)}</p>
                <p className="text-[11.5px] text-ink-secondary">{readOnlyWhy}</p>
            </div>
        </div>
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
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                        <div className="min-w-0 flex-1 basis-64">
                            {business && s.question && (
                                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{s.label}</p>
                            )}
                            <h3 id={ids.title} className={cn('font-semibold tracking-tight text-ink', business && s.question ? 'mt-0.5 text-[15px]' : 'text-sm')}>
                                {title}
                            </h3>
                            <p id={ids.summary} className="mt-1 text-[13px] leading-relaxed text-ink-secondary max-w-prose">{s.guidance.summary}</p>
                        </div>
                        <div className="shrink-0 sm:text-right">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">In force</p>
                            <p className="text-[13px] font-semibold text-ink">{formatValue(s, resolved.effective)}</p>
                            {answer ? (
                                <>
                                    <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">Once saved: {formatValue(s, answer.effective)}</p>
                                    {answer.declared !== null && !sameValue(answer.declared, answer.effective) && (
                                        <p className="text-[11px] text-ink-secondary">Chosen: {formatValue(s, answer.declared)}</p>
                                    )}
                                </>
                            ) : isStaged && !error && checking ? (
                                <p className="text-xs text-ink-secondary">Checking…</p>
                            ) : null}
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:justify-end">
                                <ScopeBadge scope={resolved.source} here={resolved.source === scope}
                                    prefix={resolved.source === 'default' ? undefined : resolved.source === 'env' ? 'Set by' : resolved.source === scope ? 'Set at' : 'From'} />
                                <StatusBadge status={resolved.status} />
                            </div>
                        </div>
                    </div>

                    {!business && (
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-secondary">
                            {/* A long env var wraps rather than widening a phone's page. */}
                            {s.default.env && <code className="min-w-0 rounded-md bg-black/[0.04] px-1.5 py-px font-mono text-[11px] text-ink-secondary [overflow-wrap:anywhere] dark:bg-white/[0.06]">{s.default.env}</code>}
                            <span>{s.takesEffect.text}</span>
                            {s.caps.filter((c) => c.deployment).map((c) => (
                                <span key={c.deployment} className="min-w-0">
                                    {c.value != null ? <>Capped at <span className="font-semibold text-ink">{formatValue(s, c.value)}</span> by </> : 'Capped by '}
                                    <code className="font-mono text-[11px] [overflow-wrap:anywhere]">{c.deployment}</code>
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

                    <ProvenanceTrail setting={s} resolved={resolved} scope={scope} staged={staged} />
                    <WhyBanner why={resolved.why} onFix={onFix} fixLabel={fixLabel} compact />
                </div>

                <div className={cn('min-w-0', wide ? 'basis-full' : 'flex-[1_1_18rem] max-w-[28rem] pt-1')}>
                    {control}
                    <p id={ids.error} aria-live="polite" className={cn('text-xs font-medium text-rose-600 dark:text-rose-400', error ? 'mt-2' : 'sr-only')}>
                        {error ?? ''}
                    </p>
                </div>
            </div>

            {children && <div className="-mt-1 px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>}

            <div className="flex flex-wrap items-center gap-1.5 border-t border-glass-border/50 px-3 py-2 sm:px-4">
                <Button size="sm" variant="ghost" rightIcon={ChevronDown} aria-expanded={open} aria-controls={ids.panel}
                    onClick={() => setOpen((o) => !o)} className={cn('text-ink-secondary [&>svg:last-child]:transition-transform', open && '[&>svg:last-child]:rotate-180')}>
                    {open ? 'Less' : 'How it works'}
                </Button>
                {editable && !sameValue(next, rec) && (
                    <HoverTip label={s.guidance.recommended.forThisPlatform?.why ?? s.guidance.recommended.why} className="inline-flex">
                        <Button size="sm" variant="ghost" leftIcon={Sparkles} onClick={() => onStage(rec)} className="text-ink-secondary">
                            Use recommended · {formatValue(s, rec)}
                        </Button>
                    </HoverTip>
                )}
                {editable && own !== null && (
                    <Button size="sm" variant="ghost" leftIcon={CornerDownRight} onClick={() => onStage(null)} className="text-ink-secondary">
                        {inheritLabel} · {formatValue(s, inherit.value)}
                    </Button>
                )}
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
