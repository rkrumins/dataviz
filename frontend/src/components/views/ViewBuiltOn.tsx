/**
 * ViewBuiltOn — the read-only account of what a view actually rests on.
 *
 * Someone looking at a Context View could not tell which system the data
 * came from, which graph database serves it, or which semantic layer it is
 * read through. Every one of those facts existed; none of them was on the
 * view. The Explorer's preview drawer said two of them, but only if you
 * left the canvas, went back to the Explorer and found the view again.
 *
 * Three facts, three costs — which is why each row stands or falls alone:
 *
 *   - the DATA SOURCE is free. GET /views/{id} — already in flight for the
 *     header — resolves it server-side (NULL → the workspace primary) and
 *     names it, precisely so a non-member never needs the membership-gated
 *     workspace list to find it.
 *   - the GRAPH DATA PROVIDER costs one read of /admin/providers/{id}. The
 *     view carries only the opaque providerId; name and engine live on the
 *     provider row.
 *   - the SEMANTIC LAYER costs one read of /admin/ontologies/{id}. The id
 *     is on the data source, which only a member's workspace store holds —
 *     so for a non-member there is no id to look up, and the row is simply
 *     absent.
 *
 * Both lookups are membership-scoped server-side (they 404 a provider or
 * ontology the caller's workspaces don't touch) and both are permission-
 * gated the same way `useDataSourceProviderMap` gates its pair, so a caller
 * without the capability fires nothing at all. A row whose fact does not
 * resolve is OMITTED — an absent fact must never become "Unknown", and a
 * provider must never be named by its id.
 *
 * This component is mounted only when the details sheet opens, which is
 * what keeps both requests off the canvas's open path.
 */
import { useQuery } from '@tanstack/react-query'
import { Database, Layers, Server } from 'lucide-react'
import { providerService } from '@/services/providerService'
import { useOntologyDefinition } from '@/hooks/useOntologyDefinition'
import { useAnyWorkspacePermission } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
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

function Fact({ icon: Icon, label, value, suffix, hint }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    value: string
    suffix?: string | null
    hint: string
}) {
    return (
        <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="h-3.5 w-3.5 text-ink-muted" />
            </div>
            <div className="min-w-0 flex-1">
                <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-0.5">
                    {label}
                </span>
                <span className="text-sm font-medium text-ink break-words">
                    {value}
                    {suffix && <span className="ml-1.5 font-normal text-ink-muted">{suffix}</span>}
                </span>
                <p className="text-xs text-ink-muted leading-relaxed mt-0.5">{hint}</p>
            </div>
        </div>
    )
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

    // The ontology is assigned to the DATA SOURCE, not the view, and only a
    // member's workspace store carries it. Undefined for everyone else.
    const ontologyId = useWorkspacesStore(s => s.workspaces
        .find(w => w.id === view.workspaceId)?.dataSources
        ?.find(d => d.id === view.dataSourceId)?.ontologyId) ?? null
    const { ontology } = useOntologyDefinition(canReadOntology ? ontologyId : null)

    const provider = providerQuery.data ?? null
    const dataSource = view.dataSourceName ?? view.dataSourceId ?? null

    if (!dataSource && !provider && !ontology) return null

    return (
        <section className="space-y-4">
            <div>
                <h3 className="text-sm font-bold text-ink">What this view is built on</h3>
                <p className="text-xs text-ink-muted mt-0.5">
                    Everything on this canvas is drawn from these.
                </p>
            </div>

            {dataSource && (
                <Fact
                    icon={Database}
                    label="Data source"
                    value={dataSource}
                    hint="The system this view reads from. Change what it holds and this view follows."
                />
            )}

            {provider && (
                <Fact
                    icon={Server}
                    label="Graph data provider"
                    value={provider.name}
                    suffix={TYPE_LABEL[provider.providerType] ?? null}
                    hint="The graph database that stores that data and answers this view's questions."
                />
            )}

            {ontology && (
                <Fact
                    icon={Layers}
                    label="Semantic layer"
                    value={ontology.name}
                    suffix={ontology.version ? `v${ontology.version}` : null}
                    hint="The shared vocabulary this data is read through — the entity types, relationships and hierarchy that decide what counts as a table, a system, or a flow here."
                />
            )}
        </section>
    )
}
