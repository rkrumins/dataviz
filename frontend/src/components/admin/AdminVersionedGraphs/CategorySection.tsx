/**
 * One category of settings: its header card (what it covers, the posture sentence the server writes
 * from the values in force, and how many of its settings there are, are changed and aren't saved),
 * its switch where it has one, its settings grouped by the registry's sections (each with its
 * count), what only the platform sets (on a workspace's page), and what the deployment sets for
 * it, read-only and folded to one line ("Set by your deployment · 3 read-only values"), open in the
 * Technical view: for a system admin, each with the value it has now and whether the deployment
 * chose it, or why it couldn't be read.
 */
import type { ReactNode } from 'react'
import { Activity, ChevronDown, Database, Eye, GitBranch, Globe, Info, Layers, MemoryStick, Server, Settings2, Upload, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    ScopeBadge, StatusBadge, formatValue, settingAnchor,
    type Category, type DeploymentFact, type Lens, type ResolvedValues, type Setting,
} from '@/components/settings'
import { categoryAnchor } from './meta'

const CATEGORY_ICONS: Record<string, LucideIcon> = {
    eye: Eye, activity: Activity, layers: Layers, 'memory-stick': MemoryStick, database: Database, 'git-branch': GitBranch, upload: Upload,
}

/** A category's icon, by the lucide name the registry gives it. */
export function CategoryIcon({ name, className }: { name: string; className?: string }) {
    const Icon = CATEGORY_ICONS[name] ?? Settings2
    return <Icon aria-hidden className={className} />
}


/** A fact's value as config reads it now, with its unit: served to system admins only (absent otherwise). */
function FactValue({ fact: f }: { fact: DeploymentFact }) {
    if (!('value' in f)) return null
    if (f.value === null || f.value === undefined) {
        return (
            <dd className="col-span-2 text-[12.5px] text-ink-secondary">
                <span aria-hidden>—</span><span className="sr-only">Not known</span>, couldn’t be read{f.problem ? `: ${f.problem}` : '.'}
            </dd>
        )
    }
    return (
        <dd className="text-right text-[13px] font-semibold tabular-nums text-ink">
            {formatValue({ kind: f.kind, unit: f.unit } as Setting, f.value)}
            {f.set != null && <span className="block text-[12px] font-normal text-ink-secondary">{f.set ? 'set by your deployment' : 'the default'}</span>}
        </dd>
    )
}

/** What the deployment sets for a category, read-only: one line until opened, open in the Technical view. */
function DeploymentFacts({ facts, lens, category }: { facts: DeploymentFact[]; lens: Lens; category: string }) {
    return (
        <section aria-label={`${category}: set by your deployment`}>
            {/* Opens and folds with the view; between switches, as the reader leaves it. */}
            <details open={lens === 'operator'} className="group rounded-2xl border border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.02]">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl px-5 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 [&::-webkit-details-marker]:hidden">
                    <Server aria-hidden className="w-3.5 h-3.5 shrink-0 text-ink-secondary" />
                    <span className="text-[13px] font-semibold text-ink">Set by your deployment</span>
                    <span className="text-[12.5px] text-ink-secondary">· {facts.length} read-only {facts.length === 1 ? 'value' : 'values'}</span>
                    <ChevronDown aria-hidden className="ml-auto w-4 h-4 shrink-0 text-ink-secondary transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <div className="px-5 pb-4">
                    <p className="text-[12.5px] text-ink-secondary">Read from the deployment’s environment when it starts; they can’t be changed here.</p>
                    <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                        {facts.map((f) => (
                            <div key={f.env} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                                <dt className="text-[13px] font-medium text-ink">{f.label}</dt>
                                <FactValue fact={f} />
                                <dd className="col-span-2 text-[12.5px] leading-relaxed text-ink-secondary">
                                    {f.means}
                                    {lens === 'operator' && (
                                        <code className="mt-0.5 block w-fit max-w-full break-all rounded bg-black/[0.04] px-1.5 py-px font-mono text-[11.5px] text-ink-secondary dark:bg-white/[0.06]">{f.env}</code>
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </details>
        </section>
    )
}

/**
 * On a workspace's page, a category's settings only a system admin sets, for every workspace: each
 * with the value in force here and where it came from. Each keeps its anchor, so a search or a
 * link to it lands here.
 */
export function PlatformWideSettings({ settings, values, highlight, category }: {
    settings: Setting[]
    values: ResolvedValues
    /** The setting a link points at. */
    highlight: string | null
    /** The category's name, which names the list. */
    category: string
}) {
    return (
        <section aria-label={`${category}: set for the whole platform`} className="rounded-2xl border border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.02]">
            <div className="px-5 pt-4">
                <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                    <Globe aria-hidden className="w-3.5 h-3.5 text-ink-secondary" /> Set for the whole platform
                </h3>
                <p className="mt-0.5 text-[12.5px] text-ink-secondary">In force for this workspace’s graphs. Only a system admin changes these, for every workspace at once.</p>
            </div>
            <ul className="mt-3 divide-y divide-glass-border/40 border-t border-glass-border/40">
                {settings.map((s) => {
                    const r = values[s.key]
                    return (
                        <li key={s.key} id={settingAnchor(s.key)} tabIndex={-1}
                            className={cn('flex scroll-mt-24 flex-wrap items-start justify-between gap-x-4 gap-y-1.5 px-5 py-3 outline-none',
                                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40',
                                highlight === s.key && 'bg-black/[0.03] dark:bg-white/[0.04]')}>
                            <div className="min-w-0 flex-1 basis-60">
                                <p className="text-[13.5px] font-medium text-ink">{s.label}</p>
                                <p className="text-[12.5px] leading-relaxed text-ink-secondary">{s.guidance.summary}</p>
                            </div>
                            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                                <span className="text-[13.5px] font-semibold text-ink">{formatValue(s, r.effective)}</span>
                                <ScopeBadge scope={r.source} prefix={r.source === 'default' ? undefined : r.source === 'env' ? 'Set by' : 'From'} />
                                {r.status !== 'in_effect' && <StatusBadge status={r.status} />}
                            </div>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}

/** How many of a category's settings this level has, and how many are chosen here, as chips. */
function counts(scope: 'platform' | 'workspace', total: number, changed: number): string[] {
    const settings = `${total} ${total === 1 ? 'setting' : 'settings'}`
    if (scope === 'platform') return [settings, changed ? `${changed} changed` : 'All at their defaults']
    return [settings, changed ? `${changed} set here` : total === 1 ? 'Follows the platform' : 'All follow the platform']
}

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
    return (
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium',
            tone === 'accent' ? 'bg-indigo-500/10 font-semibold text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300'
                : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.07]')}>
            {children}
        </span>
    )
}

export function CategorySection({
    category, scope = 'platform', settings, total, changed, staged, lens, masterSwitch, extra, fixed, deployment, row, filtered, onShowAll,
}: {
    category: Category
    /** The level the page edits. */
    scope?: 'platform' | 'workspace'
    /** The settings shown, in registry order. */
    settings: Setting[]
    /** The category's settings this level can have. */
    total: number
    /** Values chosen here (on the platform: that differ from the default). */
    changed: number
    /** Values and limits staged in this category. */
    staged: number
    lens: Lens
    masterSwitch?: ReactNode
    /** Drawn under the switch: the memory gauges. */
    extra?: ReactNode
    /** Drawn after the settings: what only the platform sets (a workspace's page). */
    fixed?: ReactNode
    deployment: DeploymentFact[]
    row: (s: Setting) => ReactNode
    /** The "changed only" filter hides some. */
    filtered: boolean
    onShowAll: () => void
}) {
    const titleId = `${categoryAnchor(category.id)}-title`
    const groups = category.sections
        .map((sec) => ({ ...sec, settings: settings.filter((s) => s.section === sec.id) }))
        .filter((g) => g.settings.length > 0)
    const loose = settings.filter((s) => !category.sections.some((sec) => sec.id === s.section))
    if (loose.length) groups.push({ id: '_', title: '', settings: loose })

    return (
        <section id={categoryAnchor(category.id)} data-category={category.id} aria-labelledby={titleId} className="scroll-mt-4 space-y-4">
            <header className="rounded-2xl border border-glass-border/50 bg-canvas-elevated p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none sm:p-6">
                <div className="flex items-start gap-4">
                    <span className="grid place-items-center w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/20">
                        <CategoryIcon name={category.icon} className="w-5 h-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-ink">{category.label}</h2>
                        <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-secondary">{category.summary}</p>
                    </div>
                </div>
                {/* The server writes it from the platform's values: below the platform, it says so. */}
                <p className="mt-4 flex items-start gap-2.5 rounded-xl bg-indigo-500/[0.05] px-4 py-3 text-[13.5px] leading-relaxed text-ink-secondary dark:bg-indigo-400/[0.07]">
                    <Info aria-hidden className="mt-1 w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
                    <span className="min-w-0">
                        {scope !== 'platform' && <span className="font-semibold text-ink">Across the platform: </span>}
                        {category.posture}
                    </span>
                </p>
                {scope === 'workspace' && total === 0 ? (
                    <p className="mt-3 text-[12.5px] text-ink-secondary">Only a system admin sets these, for the whole platform</p>
                ) : (
                    <p className="mt-3 flex flex-wrap gap-1.5">
                        {counts(scope, total, changed).map((c) => <Chip key={c}>{c}</Chip>)}
                        {staged > 0 && <Chip tone="accent">{staged} not saved</Chip>}
                    </p>
                )}
            </header>
            {masterSwitch}
            {extra}
            {groups.map((g) => (
                <div key={g.id} className="space-y-3">
                    {groups.length > 1 && g.title && (
                        <h3 className="flex items-baseline gap-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">
                            {g.title}{' '}
                            <span className="font-medium normal-case tracking-normal">
                                · {g.settings.length}<span className="sr-only"> {g.settings.length === 1 ? 'setting' : 'settings'}</span>
                            </span>
                        </h3>
                    )}
                    {g.settings.map(row)}
                </div>
            ))}
            {settings.length === 0 && filtered && (
                <p className="rounded-2xl border border-dashed border-glass-border/70 px-5 py-4 text-[13.5px] text-ink-secondary">
                    {scope === 'platform' ? 'Every setting here is at its default.' : 'None of these is set for this workspace.'}{' '}
                    <button type="button" onClick={onShowAll}
                        className="rounded font-semibold text-indigo-700 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                        Show them all
                    </button>
                </p>
            )}
            {fixed}
            {deployment.length > 0 && <DeploymentFacts facts={deployment} lens={lens} category={category.label} />}
        </section>
    )
}
