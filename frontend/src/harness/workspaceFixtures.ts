/**
 * Fixtures for the workspace page harness: one workspace in three states, as
 * the API would answer for it. Kept to the fields the page reads.
 */
const now = Date.now()
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString()

export type WorkspaceFixtureName = 'populated' | 'failing' | 'empty' | 'playground'

const SOURCES = [
    {
        id: 'ds_ledger', workspaceId: 'ws_fin', catalogItemId: 'cat_ledger', label: 'General Ledger',
        isPrimary: true, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(5), projectionMode: 'in_source', identityProperty: 'urn',
        createdAt: ago(900), updatedAt: ago(30), sourceMode: 'federated', aggregationEdgeCount: 182_400,
        // Certified and confidential, described, linked and tagged.
        description: 'Every balance and journal line Finance signs off at month-end, from the ERP ledger to the trial balance. The source of truth for the regulatory returns.',
        catalogDescription: 'SAP S/4 general ledger, nightly extract.',
        tags: ['finance', 'month-end', 'gl', 'sox', 'audit'], classification: 'confidential', trustStatus: 'certified',
    },
    {
        id: 'ds_risk', workspaceId: 'ws_fin', catalogItemId: 'cat_risk', label: 'Risk Models',
        isPrimary: false, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(26), projectionMode: 'dedicated', identityProperty: 'qualifiedName',
        createdAt: ago(600), updatedAt: ago(48), sourceMode: 'federated', aggregationEdgeCount: 41_250,
        // Untagged, undescribed: the catalog's words stand in.
        description: null, catalogDescription: 'Market and credit risk models, with the inputs each one reads.',
        tags: [], classification: 'internal', trustStatus: null,
    },
    {
        id: 'ds_reg', workspaceId: 'ws_fin', catalogItemId: 'cat_reg', label: 'Regulatory Reporting',
        isPrimary: false, isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
        lastAggregatedAt: ago(72), projectionMode: 'in_source', identityProperty: 'urn',
        createdAt: ago(300), updatedAt: ago(70), sourceMode: 'managed', aggregationEdgeCount: 9_800,
        // On its way out, with a note saying what to use instead.
        description: 'The 2024 reporting graph, kept while the last FR Y-9C returns move across.',
        catalogDescription: null, tags: ['finance', 'regulatory'], classification: 'restricted', trustStatus: 'deprecated',
    },
]

// ── Data source details, as GET …/metadata answers for each reader ──────
const personOf = (id: string, displayName: string) => ({ id, displayName, email: null, avatarId: null, hasImage: false, deleted: false })
export const PEOPLE = {
    usr_ada: personOf('usr_ada', 'Ada Okafor'), usr_ana: personOf('usr_ana', 'Ana Ruiz'),
    usr_ben: personOf('usr_ben', 'Ben Hall'), usr_me: personOf('usr_me', 'Sam Reader'),
}
const DETAILS: Record<string, object> = {
    ds_ledger: {
        links: [
            { label: 'Runbook', url: 'https://wiki.example.com/finance/gl-runbook' },
            { label: 'Data dictionary', url: 'https://wiki.example.com/finance/gl-dictionary' },
            { label: 'Month-end calendar', url: 'https://calendar.example.com/finance' },
        ],
        trustNote: 'Reconciled to the trial balance every month-end; the sign-off is in the runbook.',
        trustStatusBy: PEOPLE.usr_ada, trustStatusAt: ago(200), updatedAt: ago(30), updatedBy: PEOPLE.usr_ana,
        onboarding: { at: ago(900), by: PEOPLE.usr_ana, how: 'catalog',
            fromRequest: { id: 'dr_0', title: 'The general ledger', requesterName: 'Priya Nair', requestedAt: ago(950), connectedAt: ago(900) } },
    },
    ds_risk: {
        links: [], trustNote: null, trustStatusBy: null, trustStatusAt: null, updatedAt: null, updatedBy: null,
        onboarding: { at: ago(600), by: PEOPLE.usr_ben, how: 'provider', fromRequest: null },
    },
    ds_reg: {
        links: [{ label: 'Migration plan', url: 'https://wiki.example.com/finance/reg-v2' }],
        trustNote: 'Use Regulatory Reporting v2 instead — this one stops refreshing on 31 December.',
        trustStatusBy: PEOPLE.usr_ada, trustStatusAt: ago(30), updatedAt: ago(30), updatedBy: PEOPLE.usr_ada,
        onboarding: { at: ago(300), by: PEOPLE.usr_ada, how: 'blank', fromRequest: null },
    },
}

/** What GET …/metadata says to this reader: a viewer reads, a member edits the details,
 *  an admin (or, with `steward`, anyone) changes the status too. */
export function metadataOf(dsId: string, as: 'viewer' | 'member' | 'admin', steward = false) {
    const ds = SOURCES.find(d => d.id === dsId) ?? SOURCES[0]
    return {
        dataSourceId: ds.id, description: ds.description, catalogDescription: ds.catalogDescription, tags: ds.tags,
        classification: ds.classification, trustStatus: ds.trustStatus, ...DETAILS[ds.id],
        canEdit: as !== 'viewer', canEditTrust: as === 'admin' || steward,
    }
}

/** Who to ask: the ledger's are named, the others' worked out. */
export function contactsOf(dsId: string, as: 'viewer' | 'member' | 'admin') {
    const named = dsId === 'ds_ledger'
    return {
        owner: { subjectType: 'user', subjectId: named ? 'usr_ada' : 'usr_ben', name: named ? 'Ada Okafor' : 'Ben Hall', memberCount: null,
            via: named ? 'named_owner' : 'created_source' },
        stewards: named ? [{ subjectType: 'group', subjectId: 'grp_eng', name: 'Finance Risk · Engineers', memberCount: 7, via: 'named_steward' }] : [],
        provenance: named ? 'named' : 'derived', updatedAt: named ? ago(400) : null,
        canEdit: as !== 'viewer', canEditOwner: as === 'admin', people: PEOPLE,
    }
}

/** A source's history, newest first, as the activity ledger answers it. */
export function sourceActivityOf(dsId: string) {
    const ds = SOURCES.find(d => d.id === dsId) ?? SOURCES[0]
    const ev = (i: number, eventType: string, summary: string, h: number, who: keyof typeof PEOPLE | null) => ({
        id: `sa_${dsId}_${i}`, eventType, label: summary, category: 'data', severity: 'info', outcome: 'success', summary,
        occurredAt: ago(h), recordedAt: ago(h), actorKind: who ? 'user' : 'system',
        actor: who ? { id: who, name: PEOPLE[who].displayName, email: null, deleted: false, avatarId: null, hasImage: false } : null,
        workspaceId: 'ws_fin', workspaceName: 'Finance Risk', dataSourceId: dsId, dataSourceName: ds.label,
        correlationId: null, apiKeyId: null, apiKeyName: null, payload: null, details: {}, resolvedNames: {},
    })
    return [
        ev(1, 'workspace.data_source.metadata_changed', `Changed the description and tags of ${ds.label}`, 0.5, 'usr_ana'),
        ev(2, 'workspace.data_source.trust_changed', ds.trustStatus === 'deprecated' ? `Marked ${ds.label} deprecated` : `Certified ${ds.label}`, 3, 'usr_ada'),
        ev(3, 'workspace.data_source.trust_changed', `Classified ${ds.label} as Confidential`, 3.2, 'usr_ada'),
        ev(4, 'workspace.data_source.contacts_changed', `Named Ada Okafor the Owner of ${ds.label}`, 30, 'usr_ada'),
        ev(5, 'workspace.data_source.primary_set', `Made ${ds.label} the primary data source`, 80, 'usr_me'),
        ev(6, 'workspace.data_source.projection_changed', `Changed where ${ds.label} keeps its connections`, 200, 'usr_ben'),
        ev(7, 'workspace.data_request.connected', `Connected the data request “The general ledger” as ${ds.label}`, 900, 'usr_ana'),
        ev(8, 'workspace.data_source.added', `Added ${ds.label} to Finance Risk`, 900.1, 'usr_ana'),
    ]
}

// The Playground: two graphs of the reader's, one of someone else's.
const PLAYGROUND_SOURCES = [
    ['ds_pg_supply', 'Supply chain sketch', 'usr_me', 30], ['ds_pg_crm', 'CRM data flows', 'usr_me', 4],
    ['ds_pg_ml', 'ML feature pipeline', 'usr_ada', 60],
].map(([id, label, createdBy, h]) => ({
    id: id as string, workspaceId: 'ws_fin', label: label as string, providerId: 'prov_sandbox', graphName: (id as string).slice(3),
    isPrimary: id === 'ds_pg_supply', isActive: true, ontologyId: 'ont_fin', aggregationStatus: 'ready',
    lastAggregatedAt: ago(h as number), projectionMode: 'in_source', identityProperty: 'urn',
    createdAt: ago((h as number) + 10), updatedAt: ago(h as number), sourceMode: 'managed', aggregationEdgeCount: 320,
    createdBy: createdBy as string,
}))

export function workspaceOf(name: WorkspaceFixtureName) {
    if (name === 'playground') {
        return {
            id: 'ws_fin', name: 'Playground', kind: 'playground',
            description: 'A sandbox for trying things out — build a graph of your own and explore it.',
            isDefault: false, isActive: true, publishPolicy: 'request', requestPolicy: 'open',
            createdAt: ago(2000), updatedAt: ago(10), memberCount: 37, dataSources: PLAYGROUND_SOURCES,
        }
    }
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

const PLAYGROUND_VIEWS: Array<[string, string, string, string, string, string]> = [
    ['v_pg_suppliers', 'Suppliers to stores', 'layered-lineage', 'ds_pg_supply', 'usr_me', 'private'],
    ['v_pg_crm', 'Where leads go', 'graph', 'ds_pg_crm', 'usr_me', 'workspace'],
    ['v_pg_features', 'Feature store map', 'reference', 'ds_pg_ml', 'usr_ada', 'workspace'],
    ['v_pg_models', 'Models and their inputs', 'hierarchy', 'ds_pg_ml', 'usr_ada', 'workspace'],
]

export function viewsOf(name: WorkspaceFixtureName) {
    if (name === 'empty') return []
    if (name === 'playground') {
        return PLAYGROUND_VIEWS.map(([id, viewName, viewType, dsId, by, visibility], i) => ({
            id, name: viewName, viewType, workspaceId: 'ws_fin', workspaceName: 'Playground', dataSourceId: dsId,
            dataSourceName: PLAYGROUND_SOURCES.find(d => d.id === dsId)?.label, config: {}, visibility,
            isPinned: false, favouriteCount: 3 - i, isFavourited: false, createdAt: ago(200 - i * 30), updatedAt: ago(3 + i * 7),
            createdBy: by, createdByName: by === 'usr_me' ? 'Sam Reader' : 'Ada Okafor', tags: [],
        }))
    }
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
    ds_pg_supply: { nodeCount: 64, edgeCount: 112 },
    ds_pg_crm: { nodeCount: 23, edgeCount: 31 },
    ds_pg_ml: { nodeCount: 140, edgeCount: 260 },
}

export const ONTOLOGIES = [
    { id: 'ont_fin', name: 'Finance Lineage', version: 4, isPublished: true, entityTypeDefinitions: {}, relationshipTypeDefinitions: {}, createdAt: ago(2000) },
]
