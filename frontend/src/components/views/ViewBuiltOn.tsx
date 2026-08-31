/**
 * ViewBuiltOn — the read-only account of what a view actually rests on.
 *
 * Someone looking at a Context View could not tell which system the data
 * came from, which graph database serves it, or which semantic layer it is
 * read through. Every one of those facts existed; none of them was on the
 * view. The Explorer's preview drawer said two of them, but only if you
 * left the canvas, went back to the Explorer and found the view again.
 *
 * THE DATA, and what each fact costs — which is why each rung stands or
 * falls alone:
 *
 *   - the WORKSPACE and the DATA SOURCE are free. GET /views/{id} — already
 *     in flight for the header — names both, and resolves the source
 *     server-side (NULL → the workspace primary) precisely so a non-member
 *     never needs the membership-gated workspace list to find it.
 *   - the GRAPH DATA PROVIDER costs one read of /admin/providers/{id}. The
 *     view carries only the opaque providerId; name and engine live on the
 *     provider row.
 *   - the SEMANTIC LAYER costs one read of /admin/ontologies/{id}. The id
 *     is on the data source, which only a member's workspace store holds —
 *     so for a non-member there is no id to look up, and the rung is simply
 *     absent.
 *
 * Both lookups are membership-scoped server-side (they 404 a provider or
 * ontology the caller's workspaces don't touch) and both are permission-
 * gated the same way `useDataSourceProviderMap` gates its pair, so a caller
 * without the capability fires nothing at all. A rung whose fact does not
 * resolve is OMITTED — an absent fact must never become "Unknown", and a
 * provider must never be named by its id. Everything the rungs are ENRICHED
 * with obeys the same rule and costs nothing extra: health comes from the
 * shared provider-health resolver (a store read), the type counts ride on
 * the ontology payload already fetched, and the source's provenance and
 * data-change time were already on the two responses in hand.
 *
 * THE PICTURE IS THE POINT. This used to be three grey blocks, each a label,
 * a value and a two-line paragraph explaining the label — so the explanations
 * outweighed the facts, nothing was scannable, and the relationship between
 * the three (the whole reason they are on one panel) was left for the reader
 * to infer from prose. It is now a CHAIN, drawn as one: a spine connects four
 * rungs running from the workspace — your world — down to the semantic layer,
 * the machine's. One tinted tile per layer, at one saturation so they read as
 * a family, and the tints are the ones the app already spends on these
 * concepts (ViewScopeBadge's emerald source and sky provider, the schema
 * pages' indigo, the workspace's own learned colour). The prose all of it
 * needed moved behind ONE disclosure, so the panel can be scanned in a
 * glance and still read in full by anyone who wants to.
 *
 * A rung is a LINK only where the destination exists and would actually open
 * for this caller — membership for the workspace, the same nav gate the route
 * itself uses for Ingestion and Schema. One without a destination gets no
 * hover, no chevron and no cursor, because looking like a link and doing
 * nothing is worse than being plainly inert.
 *
 * This component is mounted only when the details sheet opens, which is
 * what keeps both requests off the canvas's open path.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, ChevronRight, Database, Layers, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { providerService } from '@/services/providerService'
import { resolveSourceMode } from '@/services/workspaceService'
import { useOntologyDefinition } from '@/hooks/useOntologyDefinition'
import { PROVIDER_HEALTH_META, useProviderHealth } from '@/store/providerHealthModel'
import { useAnyWorkspacePermission, useNavPermission } from '@/store/auth'
import { useSidebarSpec } from '@/store/navCatalogue'
import { useWorkspacesStore } from '@/store/workspaces'
import { workspaceColor } from '@/lib/workspaceColor'
import type { View } from '@/services/viewApiService'

/** Same neutral map AdminInfrastructure's GraphProvidersPanel uses — no
 *  privileged provider, and never the raw `falkordb` token in the UI. */
const TYPE_LABEL: Record<string, string> = {
    falkordb: 'FalkorDB',
    neo4j: 'Neo4j',
    spanner: 'Spanner',
    datahub: 'DataHub',
    mock: 'Mock',
}

/** One rung of the chain. `pending` means the layer is known to exist and its
 *  lookup is still in flight — it keeps its place and its name so the stack
 *  never reflows under the reader. */
interface Rung {
    key: string
    label: string
    icon: React.ComponentType<{ className?: string }>
    /** Tile fill + border. Literal strings — Tailwind's JIT scans source text. */
    tile: string
    /** Icon colour, at the same saturation as every other rung's. */
    glyph: string
    /** The plain-language answer to "what IS this?", collected into the one
     *  disclosure at the foot rather than printed under every value. */
    what: string
    pending?: boolean
    value?: string
    /** Right-aligned on the value line: a version, a health state. */
    badge?: string
    status?: { dot: string; label: string }
    secondary?: string
    to?: string
    linkLabel?: string
}

export function ViewBuiltOn({ view }: { view: View }) {
    // Mirror the backend gates so a caller who cannot have these never
    // fires a guaranteed-403 pair (providers.py / ontologies.py both
    // `requires(..., workspace_any=True)`).
    const canReadProviders = useAnyWorkspacePermission('workspace:provider:read')
    const canReadOntology = useAnyWorkspacePermission('workspace:ontology:read')

    // Shares the ['provider', id] cache with useDataSourceProfile.
    const providerQuery = useQuery({
        queryKey: ['provider', view.providerId],
        queryFn: () => providerService.get(view.providerId as string),
        enabled: canReadProviders && Boolean(view.providerId),
        retry: false,
        staleTime: 5 * 60_000,
    })

    // Membership-scoped by construction: the store lists only the workspaces
    // this caller belongs to. That is exactly the test for "would
    // /workspaces/{id} open for them?", and it is the only place the data
    // source's ontology id and provenance live.
    const myWorkspaces = useWorkspacesStore(s => s.workspaces)
    const workspace = myWorkspaces.find(w => w.id === view.workspaceId) ?? null
    const dataSourceRow = workspace?.dataSources
        ?.find(d => d.id === view.dataSourceId) ?? null

    const ontologyId = dataSourceRow?.ontologyId ?? null
    const { ontology, isLoading: ontologyLoading } =
        useOntologyDefinition(canReadOntology ? ontologyId : null)

    // Health rides the ONE canonical resolver (providerStatus → shared meta);
    // `unknown` is a non-fact, so it is dropped rather than printed.
    const health = useProviderHealth(view.providerId)

    // A destination only counts if the route would open. Both pages sit behind
    // the same nav spec their <RequireNav> guard reads, so asking here is
    // asking the guard's own question.
    const canReachIngestion = useNavPermission(useSidebarSpec('ingestion'))
    const canReachSchema = useNavPermission(useSidebarSpec('schema'))

    const provider = providerQuery.data ?? null
    const rungs: Rung[] = []

    // 1 — YOUR WORLD. Never named by id: a non-member gets no name from the
    // response and the rung is simply absent.
    if (view.workspaceName) {
        const ws = workspaceColor(view.workspaceId)
        rungs.push({
            key: 'workspace',
            label: 'Workspace',
            icon: Boxes,
            tile: cn(ws.bg, ws.border),
            glyph: ws.text,
            value: view.workspaceName,
            to: workspace ? `/workspaces/${view.workspaceId}` : undefined,
            linkLabel: `Open the ${view.workspaceName} workspace`,
            what: 'The workspace this view lives in — it decides who can reach '
                + 'the view and which data sources it may be built on.',
        })
    }

    if (view.dataSourceName) {
        // Both halves are free or absent: provenance comes off the member's
        // store row, and the data-change time was already on the view.
        const parts: string[] = []
        if (dataSourceRow) {
            parts.push(resolveSourceMode(dataSourceRow) === 'managed'
                ? 'Managed graph' : 'External graph')
        }
        if (view.dataUpdatedAt) parts.push(`Data updated ${timeAgo(view.dataUpdatedAt)}`)
        const catalogId = dataSourceRow?.catalogItemId
        rungs.push({
            key: 'dataSource',
            label: 'Data source',
            icon: Database,
            tile: 'bg-emerald-500/15 border-emerald-500/30',
            glyph: 'text-emerald-600 dark:text-emerald-400',
            value: view.dataSourceName,
            secondary: parts.join(' · ') || undefined,
            to: catalogId && canReachIngestion ? `/datasources/${catalogId}` : undefined,
            linkLabel: `Open the ${view.dataSourceName} data source`,
            what: 'The system this view reads from. Change what it holds and '
                + 'this view follows.',
        })
    }

    if (provider || providerQuery.isLoading) {
        rungs.push({
            key: 'provider',
            label: 'Graph data provider',
            icon: Server,
            tile: 'bg-sky-500/15 border-sky-500/30',
            glyph: 'text-sky-600 dark:text-sky-400',
            pending: !provider,
            value: provider?.name,
            secondary: provider ? TYPE_LABEL[provider.providerType] : undefined,
            status: health.state === 'unknown' ? undefined : {
                dot: PROVIDER_HEALTH_META[health.state].dot,
                label: PROVIDER_HEALTH_META[health.state].label,
            },
            what: 'The graph database that stores that data and answers this '
                + "view's questions.",
        })
    }

    if (ontology || ontologyLoading) {
        // Counts ride on the payload already fetched — no second request for
        // a number, and no number at all when the payload predates them.
        const entities = Object.keys(ontology?.entityTypeDefinitions ?? {}).length
        const rels = Object.keys(ontology?.relationshipTypeDefinitions ?? {}).length
        const counts = [
            entities ? `${entities} entity type${entities === 1 ? '' : 's'}` : null,
            rels ? `${rels} relationship${rels === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ')
        rungs.push({
            key: 'ontology',
            label: 'Semantic layer',
            icon: Layers,
            tile: 'bg-indigo-500/15 border-indigo-500/30',
            glyph: 'text-indigo-600 dark:text-indigo-400',
            pending: !ontology,
            value: ontology?.name,
            badge: ontology?.version ? `v${ontology.version}` : undefined,
            secondary: counts || undefined,
            to: ontology && canReachSchema ? `/schema/${ontology.id}` : undefined,
            linkLabel: ontology ? `Open the ${ontology.name} semantic layer` : undefined,
            what: 'The shared vocabulary this data is read through — the entity '
                + 'types, relationships and hierarchy that decide what counts as '
                + 'a table, a system, or a flow here.',
        })
    }

    if (rungs.length === 0) return null

    return (
        <section className="space-y-3">
            <div>
                <h3 className="text-sm font-bold text-ink">What this view is built on</h3>
                <p className="text-xs text-ink-muted mt-0.5">
                    Each layer rests on the one below it.
                </p>
            </div>

            <ol className="space-y-0">
                {rungs.map((r, i) => (
                    <RungRow key={r.key} rung={r} last={i === rungs.length - 1} />
                ))}
            </ol>

            {/* Every explanation the rows used to carry inline, in one place a
                reader opens once and never again. Native <details> — keyboard
                reachable and correctly announced without a line of JS. */}
            <details className="group/why rounded-xl border border-black/[0.07] bg-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.02]">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    <ChevronRight
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-open/why:rotate-90"
                    />
                    What do these mean?
                </summary>
                <dl className="space-y-2.5 px-3 pb-3 pt-0.5">
                    {rungs.map(r => (
                        <div key={r.key}>
                            <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                                {r.label}
                            </dt>
                            <dd className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
                                {r.what}
                            </dd>
                        </div>
                    ))}
                </dl>
            </details>
        </section>
    )
}

/**
 * One rung, and the spine that ties it to the next.
 *
 * The whole content block is the link when there is somewhere to go, so the
 * target is the size of the row rather than the size of a name; the chevron
 * appears on hover and focus so the row is quiet until it is asked about.
 * Without a destination it renders as a plain div — no hover, no cursor, no
 * chevron — because a row that looks clickable and is not is the complaint
 * this panel was rebuilt over.
 */
function RungRow({ rung, last }: { rung: Rung; last: boolean }) {
    const Icon = rung.icon
    const body = (
        <>
            <div className="flex items-center gap-1.5">
                <span
                    data-testid="rung-label"
                    className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted"
                >
                    {rung.label}
                </span>
                {rung.to && (
                    <ChevronRight
                        aria-hidden
                        className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-muted opacity-0 transition-all group-hover/rung:translate-x-0.5 group-hover/rung:opacity-100 group-focus-visible/rung:opacity-100"
                    />
                )}
            </div>

            {rung.pending ? (
                <div data-testid={`rung-skeleton-${rung.key}`} className="mt-1 space-y-1.5">
                    <span className="block h-[13px] w-32 animate-pulse rounded bg-black/[0.07] dark:bg-white/[0.09]" />
                    <span className="block h-2.5 w-20 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.06]" />
                </div>
            ) : (
                <>
                    <div className="mt-0.5 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                            {rung.value}
                        </span>
                        {rung.badge && (
                            <span className="shrink-0 rounded-md border border-black/10 bg-black/[0.03] px-1.5 py-px text-[10px] font-bold tabular-nums text-ink-secondary dark:border-white/[0.12] dark:bg-white/[0.04]">
                                {rung.badge}
                            </span>
                        )}
                        {rung.status && (
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold text-ink-secondary">
                                {/* Never colour alone — the state is spelled out
                                    beside its dot, as everywhere else. */}
                                <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', rung.status.dot)} />
                                {rung.status.label}
                            </span>
                        )}
                    </div>
                    {rung.secondary && (
                        <p className="mt-px truncate text-[11px] text-ink-muted">{rung.secondary}</p>
                    )}
                </>
            )}
        </>
    )

    return (
        <li className={cn('relative flex gap-3', last ? 'pb-0' : 'pb-4')}>
            {/* The spine. Drawn from the tile's underside to the next tile's
                top edge, so four rows read as one chain rather than four cards. */}
            {!last && (
                <span
                    aria-hidden
                    /* A real neutral, NOT `glass-border`: that token is
                       rgba(255,255,255,.4) in light mode, so a spine drawn with
                       it would be white on the near-white canvas — the chain
                       would simply not be there. */
                    className="absolute left-[17px] top-[38px] bottom-0 w-px bg-black/10 dark:bg-white/10"
                />
            )}
            <span className={cn(
                'relative z-[1] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl border',
                rung.tile,
            )}>
                <Icon className={cn('h-4 w-4', rung.glyph)} />
            </span>

            {rung.to ? (
                <Link
                    to={rung.to}
                    aria-label={rung.linkLabel}
                    className="group/rung -mx-2 min-w-0 flex-1 rounded-lg px-2 py-0.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                    {body}
                </Link>
            ) : (
                <div className="min-w-0 flex-1 py-0.5">{body}</div>
            )}
        </li>
    )
}
