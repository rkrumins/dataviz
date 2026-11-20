/**
 * WorkspaceHeroHeader — what this workspace is, whether it's ready, and the way in.
 *
 * It used to lead with a database icon and four graph counters (Nodes, Edges,
 * Entity Types, Views) above a row of database-vendor chips: the workspace
 * described by its plumbing. A person opening it wants three answers first —
 * what is this for, can I use it right now, and where do I start — so the hero
 * gives those: the workspace's own colour and name, its health as a sentence with
 * the one place to go about it, who uses it and for what, and the primary action
 * (explore its views). The plumbing is still here in the Technical view.
 */
import { Link } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
    ArrowRight, Calendar, Check, Compass, FlaskConical, GitBranch, MoreHorizontal, Pencil, Plus, ShieldCheck, X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { workspaceColor, workspaceMonogram } from '@/lib/workspaceColor'
import { compact } from '@/lib/formatMetric'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { useAuthStore, effectiveRoleFor, SYSTEM_ROLE_LABELS } from '@/store/auth'
import { ROLE_NAMES } from '@/lib/roleNames'
import { usePersonaMode } from '@/store/persona'
import { useWorkspaceUsage } from '@/hooks/useContentInsights'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { TourLaunchButton } from '@/features/tour/TourLaunchButton'
import { WorkspaceHealthBadge, type WorkspaceHealth } from './WorkspaceHealthBadge'
import { WorkspaceUsageLine } from './WorkspaceUsageLine'
import { getProviderLogo } from '../ProviderLogos'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'
import type { HealthStory } from './workspaceHealthStory'
import type { DataSection } from './workspaceTabs'

export interface HeroLink {
    label: string
    to: string
    icon: ComponentType<{ className?: string }>
}

interface WorkspaceHeroHeaderProps {
    workspace: WorkspaceResponse
    healthStatus: WorkspaceHealth
    healthStory: HealthStory
    onHealthAction?: (section: DataSection) => void
    aggregateStats: { totalNodes: number; totalEdges: number; totalTypes: number; totalViews: number }
    primaryOntologyName?: string
    providerInfos: DataSourceProviderInfo[]
    /** The primary action: the workspace's views in the Explorer. */
    exploreHref: string
    /** Offered to people who may create a view here. */
    onNewView?: () => void
    /** The rest, under More: tools this reader has. */
    moreLinks?: HeroLink[]
    /** Renaming and describing is a workspace admin's. */
    canEdit: boolean
    isEditing: boolean
    editName: string
    editDesc: string
    onEditNameChange: (v: string) => void
    onEditDescChange: (v: string) => void
    onStartEdit: () => void
    onSave: () => void
    onCancel: () => void
}

const PROVIDER_NAMES: Record<string, string> = { neo4j: 'Neo4j', falkordb: 'FalkorDB', datahub: 'DataHub' }

/** The status capsule's tint: calm when all is well, warm when it isn't. */
const HEALTH_TINT: Record<WorkspaceHealth, string> = {
    healthy: 'bg-emerald-500/[0.07] border-emerald-500/20',
    warning: 'bg-amber-500/[0.08] border-amber-500/25',
    critical: 'bg-rose-500/[0.07] border-rose-500/25',
    'no-data': 'bg-black/[0.03] dark:bg-white/[0.04] border-glass-border',
    empty: 'bg-black/[0.03] dark:bg-white/[0.04] border-glass-border',
    unknown: 'bg-black/[0.03] dark:bg-white/[0.04] border-glass-border',
}

const PRIMARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/25 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50'

/** "a Member", "an Admin". */
function withArticle(label: string): string {
    return `${/^[AEIOU]/i.test(label) ? 'an' : 'a'} ${label}`
}

export function WorkspaceHeroHeader({
    workspace, healthStatus, healthStory, onHealthAction, aggregateStats, primaryOntologyName,
    providerInfos, exploreHref, onNewView, moreLinks = [], canEdit,
    isEditing, editName, editDesc, onEditNameChange, onEditDescChange, onStartEdit, onSave, onCancel,
}: WorkspaceHeroHeaderProps) {
    const isPlayground = workspace.kind === 'playground'
    const color = workspaceColor(workspace.id, workspace.kind)
    const technical = usePersonaMode() === 'technical'
    const usage = useWorkspaceUsage([workspace.id]).data?.[workspace.id]
    const claims = useAuthStore(s => s.permissions)
    const role = claims ? effectiveRoleFor(claims, workspace.id) : null
    // In the Playground, member-shaped permissions are the Playground member role.
    const roleLabel = role && (isPlayground && role === ROLE_NAMES.WORKSPACE_MEMBER ? 'Playground member' : SYSTEM_ROLE_LABELS[role])
    const uniqueProviders = Array.from(new Map(providerInfos.map(p => [p.providerType, p])).values())

    return (
        <section
            aria-labelledby="workspace-title"
            className="relative overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_40px_-20px_rgba(15,23,42,0.18)] dark:shadow-[0_16px_40px_-20px_rgba(0,0,0,0.6)]"
        >
            {/* The workspace's colour, as everywhere it appears: a wash, a fine dot
                texture fading out across the card, a soft glow and the top edge. */}
            <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-[0.06] dark:opacity-[0.12]', color.gradient)} />
            <div aria-hidden className="pointer-events-none absolute inset-0 text-slate-900/[0.07] dark:text-white/[0.06] [background-image:radial-gradient(currentColor_1px,transparent_1.2px)] [background-size:18px_18px] [mask-image:linear-gradient(105deg,black_10%,transparent_60%)]" />
            <div aria-hidden className={cn('pointer-events-none absolute -top-32 -right-24 h-80 w-80 rounded-full blur-3xl opacity-70', color.glow)} />
            <div aria-hidden className={cn('relative h-1 w-full bg-gradient-to-r', color.gradient)} />
            {isPlayground && (
                <p className="relative flex items-center gap-2 border-b border-violet-500/15 bg-gradient-to-r from-violet-500/[0.12] via-fuchsia-500/[0.06] to-transparent px-5 sm:px-8 py-2 text-xs font-medium text-violet-800 dark:text-violet-200">
                    <FlaskConical className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    <span><strong className="font-semibold">Playground</strong> · for experiments — nothing here is production data, and nothing here changes it.</span>
                </p>
            )}

            <div className="relative p-5 sm:p-8">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-4 min-w-0 flex-1">
                        <div
                            aria-hidden
                            className={cn(
                                'relative w-16 h-16 rounded-[20px] bg-gradient-to-br text-white font-display text-2xl font-bold tracking-tight',
                                'flex items-center justify-center shrink-0 shadow-lg shadow-black/10 ring-4 ring-white/70 dark:ring-white/[0.06] overflow-hidden',
                                color.gradient,
                            )}
                        >
                            <span className="absolute inset-x-0 top-0 h-1/2 bg-white/15" />
                            {isPlayground
                                ? <FlaskConical className="relative w-7 h-7" />
                                : <span className="relative">{workspaceMonogram(workspace.name)}</span>}
                        </div>

                        <div className="min-w-0 flex-1">
                            {isEditing ? (
                                <div className="space-y-3 max-w-2xl">
                                    <label className="block">
                                        <span className="sr-only">Workspace name</span>
                                        <input
                                            value={editName}
                                            onChange={(e) => onEditNameChange(e.target.value)}
                                            autoFocus
                                            placeholder="Workspace name"
                                            className="w-full font-display text-2xl font-bold text-ink bg-transparent border-b-2 border-accent-lineage outline-none pb-0.5"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="sr-only">Description</span>
                                        <textarea
                                            value={editDesc}
                                            onChange={(e) => onEditDescChange(e.target.value)}
                                            placeholder="What is this workspace for? Who should use it?"
                                            rows={2}
                                            className="input w-full text-sm resize-none"
                                        />
                                    </label>
                                    <div className="flex gap-2">
                                        <Button size="sm" variant="primary" onClick={onSave}><Check className="w-3.5 h-3.5" /> Save</Button>
                                        <Button size="sm" variant="ghost" onClick={onCancel}><X className="w-3.5 h-3.5" /> Cancel</Button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h1 id="workspace-title" className="font-display text-2xl sm:text-[28px] leading-tight font-bold text-ink truncate">
                                            {workspace.name}
                                        </h1>
                                        {workspace.isDefault && <Badge tone="accent" variant="soft" caps size="md">Default</Badge>}
                                        {canEdit && (
                                            <IconButton icon={Pencil} label="Rename or describe this workspace" variant="ghost" size="sm" onClick={onStartEdit} />
                                        )}
                                    </div>

                                    {workspace.description ? (
                                        <p className="mt-1 text-sm text-ink-secondary max-w-3xl">{workspace.description}</p>
                                    ) : canEdit ? (
                                        <button type="button" onClick={onStartEdit} className="mt-1 text-sm text-ink-muted hover:text-ink italic">
                                            Add a description so people know what this workspace is for.
                                        </button>
                                    ) : null}

                                    {/* Can I use it? — a sentence, and where to go about it. */}
                                    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-tour="workspace-health">
                                        <span className={cn('inline-flex max-w-full flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 rounded-2xl sm:rounded-full border px-3 py-1.5', HEALTH_TINT[healthStatus])}>
                                            <span className="shrink-0"><WorkspaceHealthBadge status={healthStatus} showLabel size="md" /></span>
                                            <span aria-hidden className="hidden sm:block h-3.5 w-px bg-current opacity-15" />
                                            <span className="text-ink-secondary sm:truncate">{healthStory.detail}</span>
                                        </span>
                                        {healthStory.action && onHealthAction && (
                                            <button
                                                type="button"
                                                onClick={() => onHealthAction(healthStory.action!.section)}
                                                className="inline-flex items-center gap-1 font-semibold text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
                                            >
                                                {healthStory.action.label} <ArrowRight className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>

                                    {/* Who uses it, for what, and the reader's own place in it. */}
                                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                        <WorkspaceUsageLine usage={usage} />
                                        {roleLabel && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                                                <ShieldCheck className="w-3 h-3" aria-hidden /> You’re {withArticle(roleLabel)} here
                                            </span>
                                        )}
                                    </div>

                                    {/* The plumbing, for the Technical view. */}
                                    {technical && (
                                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-muted">
                                            <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Created {new Date(workspace.createdAt).toLocaleDateString()}</span>
                                            {primaryOntologyName && <span className="inline-flex items-center gap-1"><GitBranch className="w-3 h-3" /> {primaryOntologyName}</span>}
                                            <span title="Entities · relationships · entity types across every source">
                                                {compact(aggregateStats.totalNodes)} entities · {compact(aggregateStats.totalEdges)} relationships · {aggregateStats.totalTypes} types
                                            </span>
                                            {uniqueProviders.map(p => {
                                                const Logo = getProviderLogo(p.providerType)
                                                return (
                                                    <span key={p.providerType} className="inline-flex items-center gap-1 rounded-full border border-glass-border px-2 py-0.5 text-ink-secondary">
                                                        <Logo className="w-3 h-3" /> {PROVIDER_NAMES[p.providerType] ?? p.providerType}
                                                    </span>
                                                )
                                            })}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {!isEditing && (
                        <div className="flex flex-wrap items-center gap-2 shrink-0" data-tour="workspace-actions">
                            {/* The way in is its views; with none yet, it is making the first. */}
                            {aggregateStats.totalViews === 0 && onNewView ? (
                                <button type="button" onClick={onNewView} className={PRIMARY}>
                                    <Plus className="w-4 h-4" /> New view
                                </button>
                            ) : (
                                <>
                                    <Link to={exploreHref} className={PRIMARY}>
                                        <Compass className="w-4 h-4" /> Explore views
                                    </Link>
                                    {onNewView && (
                                        <Button onClick={onNewView}><Plus className="w-4 h-4" /> New view</Button>
                                    )}
                                </>
                            )}
                            {moreLinks.length > 0 && (
                                <DropdownMenu.Root modal={false}>
                                    <DropdownMenu.Trigger asChild>
                                        <button
                                            type="button"
                                            aria-label="More tools"
                                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-glass-border bg-canvas-elevated text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                                        >
                                            <MoreHorizontal className="w-4 h-4" />
                                        </button>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                        <DropdownMenu.Content
                                            align="end"
                                            sideOffset={6}
                                            className="z-[9999] w-52 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl animate-in fade-in slide-in-from-top-1 duration-100"
                                        >
                                            {moreLinks.map(({ label, to, icon: Icon }) => (
                                                <DropdownMenu.Item
                                                    key={label}
                                                    asChild
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink rounded-lg cursor-pointer outline-none data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.06]"
                                                >
                                                    <Link to={to}><Icon className="w-4 h-4 text-ink-muted" /> {label}</Link>
                                                </DropdownMenu.Item>
                                            ))}
                                        </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                            )}
                            <TourLaunchButton tourId="workspace-detail" />
                        </div>
                    )}
                </div>
            </div>
        </section>
    )
}
