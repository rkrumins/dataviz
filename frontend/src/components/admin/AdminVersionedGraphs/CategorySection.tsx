/**
 * One category of settings: its hero (what it covers, and the posture sentence the server writes
 * from the values in force), its switch where it has one, its settings grouped by the registry's
 * sections, and what the deployment sets for it, read-only.
 */
import type { ReactNode } from 'react'
import { Activity, Database, Eye, GitBranch, Layers, MemoryStick, Server, Settings2, Upload, type LucideIcon } from 'lucide-react'
import type { Category, DeploymentFact, Lens, Setting } from '@/components/settings'
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

export function CategorySection({
    category, settings, total, changed, staged, lens, masterSwitch, extra, deployment, row, filtered, onShowAll,
}: {
    category: Category
    /** The settings shown, in registry order. */
    settings: Setting[]
    total: number
    /** Values chosen here that differ from the default. */
    changed: number
    /** Values and limits staged in this category. */
    staged: number
    lens: Lens
    masterSwitch?: ReactNode
    /** Drawn under the switch: the memory gauges. */
    extra?: ReactNode
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
                    <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-secondary">{category.posture}</p>
                    <p className="mt-1.5 text-[11.5px] text-ink-muted">
                        {changed === 0 ? `All ${total} at their defaults` : `${changed} of ${total} changed from the default`}
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
                    Every setting here is at its default.{' '}
                    <button type="button" onClick={onShowAll} className="font-semibold text-accent-lineage underline-offset-2 hover:underline">Show them all</button>
                </p>
            )}
            {deployment.length > 0 && <DeploymentFacts facts={deployment} lens={lens} />}
        </section>
    )
}
