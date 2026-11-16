/**
 * One category of settings: its hero (what it covers, and the posture sentence the server writes
 * from the values in force), its switch where it has one, its settings grouped by the registry's
 * sections, what only the platform sets (on a workspace's page), and what the deployment sets for
 * it, read-only.
 */
import type { ReactNode } from 'react'
import { Activity, Database, Eye, GitBranch, Globe, Layers, MemoryStick, Server, Settings2, Upload, type LucideIcon } from 'lucide-react'
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


function DeploymentFacts({ facts, lens }: { facts: DeploymentFact[]; lens: Lens }) {
    return (
        <section aria-label="Set by your deployment" className="rounded-2xl border border-glass-border/50 bg-black/[0.015] px-5 py-4 dark:bg-white/[0.02]">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <Server aria-hidden className="w-3.5 h-3.5 text-ink-muted" /> Set by your deployment
            </h3>
            <p className="mt-0.5 text-xs text-ink-muted">Read from the deployment’s environment when it starts; they can’t be changed here.</p>
            <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {facts.map((f) => (
                    <div key={f.env} className="min-w-0">
                        <dt className="text-[12.5px] font-medium text-ink">{f.label}</dt>
                        <dd className="text-[11.5px] leading-relaxed text-ink-muted">
                            {f.means}
                            {lens === 'operator' && (
                                <code className="mt-0.5 block w-fit max-w-full break-all rounded bg-black/[0.04] px-1.5 py-px font-mono text-[10.5px] text-ink-secondary dark:bg-white/[0.06]">{f.env}</code>
                            )}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    )
}

/**
 * On a workspace's page, a category's settings only a system admin sets, for every workspace: each
 * with the value in force here and where it came from. Each keeps its anchor, so a search or a
 * link to it lands here.
 */
export function PlatformWideSettings({ settings, values, highlight }: {
    settings: Setting[]
    values: ResolvedValues
    /** The setting a link points at. */
    highlight: string | null
}) {
    return (
        <section aria-label="Set for the whole platform" className="rounded-2xl border border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.02]">
            <div className="px-5 pt-4">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <Globe aria-hidden className="w-3.5 h-3.5 text-ink-secondary" /> Set for the whole platform
                </h3>
                <p className="mt-0.5 text-xs text-ink-secondary">In force for this workspace’s graphs. Only a system admin changes these, for every workspace at once.</p>
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
                                <p className="text-[13px] font-medium text-ink">{s.label}</p>
                                <p className="text-[11.5px] leading-relaxed text-ink-secondary">{s.guidance.summary}</p>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                <span className="text-[13px] font-semibold text-ink">{formatValue(s, r.effective)}</span>
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

/** How many of a category's settings are chosen at this level, in words. */
function counted(scope: 'platform' | 'workspace', total: number, changed: number): string {
    if (scope === 'platform') return changed === 0 ? `All ${total} at their defaults` : `${changed} of ${total} changed from the default`
    if (total === 0) return 'Only a system admin sets these, for the whole platform'
    if (changed === 0) return total === 1 ? 'Its one setting here follows the platform' : `All ${total} settings follow the platform`
    return `${changed} of ${total} ${total === 1 ? 'setting' : 'settings'} set for this workspace`
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
            <header className="flex items-start gap-4 pt-2">
                <span className="grid place-items-center w-11 h-11 shrink-0 rounded-2xl bg-accent-lineage/10 text-accent-lineage">
                    <CategoryIcon name={category.icon} className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="text-lg font-semibold tracking-tight text-ink">{category.label}</h2>
                    <p className="text-[13px] text-ink-muted">{category.summary}</p>
                    {/* The server writes it from the platform's values: below the platform, it says so. */}
                    <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-secondary">
                        {scope !== 'platform' && <span className="font-semibold text-ink">Across the platform: </span>}
                        {category.posture}
                    </p>
                    <p className="mt-1.5 text-[11.5px] text-ink-muted">
                        {counted(scope, total, changed)}
                        {staged > 0 && <span className="font-semibold text-accent-lineage"> · {staged} not saved</span>}
                    </p>
                </div>
            </header>
            {masterSwitch}
            {extra}
            {groups.map((g) => (
                <div key={g.id} className="space-y-3">
                    {groups.length > 1 && g.title && (
                        <h3 className="pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{g.title}</h3>
                    )}
                    {g.settings.map(row)}
                </div>
            ))}
            {settings.length === 0 && filtered && (
                <p className="rounded-2xl border border-dashed border-glass-border/70 px-5 py-4 text-[13px] text-ink-muted">
                    {scope === 'platform' ? 'Every setting here is at its default.' : 'None of these is set for this workspace.'}{' '}
                    <button type="button" onClick={onShowAll} className="font-semibold text-accent-lineage underline-offset-2 hover:underline">Show them all</button>
                </p>
            )}
            {fixed}
            {deployment.length > 0 && <DeploymentFacts facts={deployment} lens={lens} />}
        </section>
    )
}
