/**
 * Fixtures for the workspace page harness: one workspace in three states, as
 * the API would answer for it. Kept to the fields the page reads.
 */
const now = Date.now()
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString()

export type WorkspaceFixtureName = 'populated' | 'failing' | 'empty'

const SOURCES = [
    {
        id: 'ds_ledger', workspaceId: 'ws_fin', catalogItemId: 'cat_ledger', label: 'General Ledger',
        isPrimary: true, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(5), projectionMode: 'in_source', identityProperty: 'urn',
        createdAt: ago(900), updatedAt: ago(30), sourceMode: 'federated', aggregationEdgeCount: 182_400,
    },
    {
        id: 'ds_risk', workspaceId: 'ws_fin', catalogItemId: 'cat_risk', label: 'Risk Models',
        isPrimary: false, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(26), projectionMode: 'dedicated', identityProperty: 'qualifiedName',
        createdAt: ago(600), updatedAt: ago(48), sourceMode: 'federated', aggregationEdgeCount: 41_250,
    },
    {
        id: 'ds_reg', workspaceId: 'ws_fin', catalogItemId: 'cat_reg', label: 'Regulatory Reporting',
        isPrimary: false, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(72), projectionMode: 'in_source', identityProperty: 'urn',
        createdAt: ago(300), updatedAt: ago(70), sourceMode: 'managed', aggregationEdgeCount: 9_800,
    },
]

export function workspaceOf(name: WorkspaceFixtureName) {
    const dataSources = name === 'empty' ? [] : SOURCES.map(ds =>
        name === 'failing' && ds.id === 'ds_risk' ? { ...ds, aggregationStatus: 'failed' } : ds)
    return {
        id: 'ws_fin',
        name: name === 'empty' ? 'Treasury Sandbox' : 'Finance Risk',
        description: name === 'empty' ? '' : 'Lineage for the numbers Finance signs off: from the ledger to every regulatory return.',
        isDefault: false, isActive: true, publishPolicy: 'open',
        createdAt: ago(2000), updatedAt: ago(10), memberCount: name === 'empty' ? 1 : 14,
        dataSources,
    }
}

const VIEW_DEFS: Array<[string, string, string, string]> = [
    ['v_exposure', 'Counterparty exposure lineage', 'layered-lineage', 'ds_risk'],
    ['v_close', 'Month-end close map', 'reference', 'ds_ledger'],
    ['v_coa', 'Chart of accounts', 'hierarchy', 'ds_ledger'],
    ['v_fr', 'FR Y-9C return sources', 'layered-lineage', 'ds_reg'],
    ['v_capital', 'Capital adequacy drivers', 'graph', 'ds_risk'],
    ['v_recon', 'Reconciliation controls', 'reference', 'ds_ledger'],
    ['v_var', 'VaR model inputs', 'graph', 'ds_risk'],
    ['v_gl_tables', 'GL tables and owners', 'list', 'ds_ledger'],
]
const SOURCE_NAME: Record<string, string> = { ds_ledger: 'General Ledger', ds_risk: 'Risk Models', ds_reg: 'Regulatory Reporting' }

export function viewsOf(name: WorkspaceFixtureName) {
    if (name === 'empty') return []
    return VIEW_DEFS.map(([id, viewName, viewType, dsId], i) => ({
        id, name: viewName, viewType, workspaceId: 'ws_fin', workspaceName: 'Finance Risk', dataSourceId: dsId,
        dataSourceName: SOURCE_NAME[dsId], config: {}, visibility: i % 3 === 0 ? 'enterprise' : 'workspace',
        isPinned: false, favouriteCount: 8 - i, isFavourited: i === 2 || i === 5,
        createdAt: ago(800 - i * 40), updatedAt: ago(6 + i * 9), createdBy: 'usr_ada', createdByName: 'Ada Okafor',
        tags: [],
    }))
}

export function readinessOf(name: WorkspaceFixtureName, dsId: string) {
    const ds = workspaceOf(name).dataSources.find(d => d.id === dsId)
    const failed = ds?.aggregationStatus === 'failed'
    return {
        dataSourceId: dsId, isReady: !failed, aggregationStatus: ds?.aggregationStatus ?? 'none',
        canCreateViews: true, driftDetected: false, lastAggregatedAt: ds?.lastAggregatedAt,
        aggregationEdgeCount: ds?.aggregationEdgeCount ?? 0, projectorCurrent: null,
        message: failed ? 'The last aggregation job failed.' : 'Ready',
        activeJob: failed ? { id: 'job_1', status: 'failed', progress: 62, errorMessage: 'FalkorDB timeout after 900s while applying batch 41 of 66 (MATCH (a)-[:FLOWS_TO*1..]->(b))' } : undefined,
    }
}

export const STATS: Record<string, { nodeCount: number; edgeCount: number }> = {
    ds_ledger: { nodeCount: 48_210, edgeCount: 121_900 },
    ds_risk: { nodeCount: 12_480, edgeCount: 30_115 },
    ds_reg: { nodeCount: 3_920, edgeCount: 8_640 },
}

export const ONTOLOGIES = [
    { id: 'ont_fin', name: 'Finance Lineage', version: 4, isPublished: true, entityTypeDefinitions: {}, relationshipTypeDefinitions: {} },
]
