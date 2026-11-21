/**
 * The AI harness's scripted answers: what the in-memory service (`aiBackend.ts`) streams for each
 * named state of the assistant rail. Each is a question and the frames of its answer, in the
 * contract's order (meta, steps, text, blocks, follow-ups, done); `holdAfter` leaves the stream
 * open part-way, to look at an answer still being worked out.
 */
import type { AiStatus, Block, Clarification, ContextBrief, Entity } from '../features/ai-assistant/api/types'
import type { AssistantPageRegistration } from '../features/ai-assistant/lib/useAssistantPage'

export const HARNESS_VIEW_ID = 'harness-view'
export const HARNESS_VIEW_NAME = 'Supply chain'

export interface ScriptFrame {
    event: string
    data: unknown
}

export interface AiFixture {
    note: string
    persona?: 'data' | 'help'
    /** Asked on load; none leaves the rail on its welcome. */
    question?: string
    status?: AiStatus
    /** Entities selected on the (stand-in) canvas. */
    selected?: string[]
    frames?: ScriptFrame[]
    /** Leave the stream open after this many frames. */
    holdAfter?: number
    /** What answering a clarification streams. */
    afterClarify?: ScriptFrame[]
    /** What `GET /context` answers (none: a 404). */
    brief?: ContextBrief
    /** The harness view's name, when the fixture's view is another one. */
    viewName?: string
    /** The route the harness opens on (default: the harness view). */
    route?: string
    /** What a non-view page registers itself as (`useAssistantPage`). */
    page?: AssistantPageRegistration
    /** Start with the rail folded away — the launcher on show. With a `question`, it folds once asked. */
    railClosed?: boolean
    /** An answer finished while the rail was closed. */
    unread?: boolean
    /** Open the "What I know" popover. */
    openContext?: boolean
    /** A stand-in canvas dock (320px) in the bottom-right corner, reserving `--canvas-dock-height`. */
    dock?: boolean
    /** A notification on screen, to see the corner's stacking. */
    notify?: string
    /** The real First steps checklist, in the canvas's corner. */
    checklist?: boolean
    /** Focus the launcher, so it opens into its pill. */
    focusLauncher?: boolean
}

export const ENTITY_TYPES = [
    { id: 'dataPlatform', name: 'Platform', icon: 'Server', color: '#64748b' },
    { id: 'container', name: 'Schema', icon: 'Folder', color: '#0ea5e9' },
    { id: 'dataset', name: 'Table', icon: 'Table', color: '#6366f1' },
    { id: 'schemaField', name: 'Column', icon: 'Columns3', color: '#8b5cf6' },
    { id: 'dashboard', name: 'Dashboard', icon: 'LayoutDashboard', color: '#f59e0b' },
    { id: 'chart', name: 'Chart', icon: 'BarChart3', color: '#f97316' },
    { id: 'dataJob', name: 'Job', icon: 'Workflow', color: '#10b981' },
]

const CONFIGURED: AiStatus = {
    configured: true, personas: { data: true, help: true }, connectionName: 'Corp gateway',
    knowledge: { docs: 'ready', views: 'ready' }, dataPolicy: { sendDescriptions: true, sendPropertyValues: false, sendSampleValues: false },
    limits: { maxStepsPerTurn: 8 },
}

const e = (urn: string, name: string, type: string, path?: string[]): Entity => ({ urn, name, type, ...(path ? { path } : {}) })
const SALES = ['Snowflake', 'sales']
const firstName = e('urn:col:first_name', 'first_name', 'schemaField', [...SALES, 'customers'])
const customers = e('urn:tbl:customers', 'customers', 'dataset', SALES)
const fullName = e('urn:col:full_name', 'full_name', 'schemaField', ['Snowflake', 'marts', 'dim_customer'])
const dimCustomer = e('urn:tbl:dim_customer', 'dim_customer', 'dataset', ['Snowflake', 'marts'])
const c360 = e('urn:dash:c360', 'Customer 360', 'dashboard', ['Tableau', 'Sales'])
const churn = e('urn:dash:churn', 'Churn watch', 'dashboard', ['Tableau', 'Retention'])
const crm = e('urn:dash:crm', 'CRM contact list', 'dashboard', ['Looker', 'Ops'])
const nightly = e('urn:job:nightly', 'nightly_customers', 'dataJob', ['Airflow'])

const meta = (persona = 'data') => ({ event: 'meta', data: { conversationId: 'conv_h1', messageId: 'msg_h1', persona, contractVersion: 1, connectionName: 'Corp gateway' } })
const step = (id: string, label: string, status: 'running' | 'done' | 'error', detail?: string) =>
    ({ event: 'step', data: { id, label, status, ...(detail ? { detail } : {}) } })
const text = (delta: string) => ({ event: 'text', data: { delta } })
const block = (b: Block) => ({ event: 'block', data: b })
const done = (status: 'ok' | 'clarify' | 'error' = 'ok') => ({ event: 'done', data: { status } })
/** Words as a model streams them: a few at a time. */
const words = (s: string) => s.match(/\S+\s*/g)!.reduce<string[]>((out, w, i) => {
    if (i % 3 === 0) out.push(w)
    else out[out.length - 1] += w
    return out
}, []).map(text)

const IMPACT_BLOCK: Block = {
    id: 'blk_impact', type: 'impact', data: {
        direction: 'downstream', target: firstName, change: 'drop', severity: 'high',
        severityReasons: ['Feeds 3 dashboards', '2 owning teams', 'Read nightly'],
        summary: 'Dropping first_name breaks 3 dashboards and 31 columns in 9 tables.',
        totals: { entities: 47, exact: true, byType: [
            { type: 'schemaField', label: 'Column', count: 31 }, { type: 'dataset', label: 'Table', count: 9 },
            { type: 'chart', label: 'Chart', count: 4 }, { type: 'dashboard', label: 'Dashboard', count: 3 },
        ] },
        byContainer: [
            { entity: e('urn:sch:marts', 'marts', 'container', ['Snowflake']), count: 18 },
            { entity: e('urn:sch:sales', 'sales', 'container', ['Snowflake']), count: 12 },
            { entity: e('urn:ws:tableau', 'Tableau · Sales', 'dataPlatform'), count: 9 },
        ],
        consumers: [{ ...c360, hops: 3 }, { ...churn, hops: 4 }, { ...crm, hops: 5 }],
        owners: [
            { owner: 'data-platform-team', property: 'owner', count: 9, assets: [dimCustomer, customers] },
            { owner: 'sales-analytics', property: 'owner', count: 5, assets: [c360, churn] },
        ],
        paths: [
            { nodes: [firstName, fullName, c360], edges: [
                { type: 'TRANSFORMS', detail: "concat(first_name, ' ', last_name)" }, { type: 'CONSUMES', detail: 'Customer name filter' }] },
            { nodes: [firstName, e('urn:col:greeting', 'greeting', 'schemaField', ['Snowflake', 'marts', 'crm_contacts']), crm], edges: [
                { type: 'TRANSFORMS', detail: "'Hi ' || first_name" }, { type: 'CONSUMES', detail: null }] },
            { nodes: [firstName, dimCustomer, churn], edges: [{ type: 'TRANSFORMS', detail: null }, { type: 'CONSUMES', detail: null }] },
        ],
        timing: { schedules: [{ job: nightly, schedule: '0 4 * * *', human: 'daily at 04:00 UTC' }],
            note: 'The first job that reads it, nightly_customers, runs daily at 04:00 UTC.' },
        grain: 'fine', truncated: false,
        notes: ['Two of the affected tables have no owner property, so their owners are not listed.'],
        trace: { urn: firstName.urn, direction: 'downstream', depth: 10 },
        resultRef: 'r2', query: { predicate: { kind: 'entityType', op: 'in', values: ['dashboard'] }, scopeMode: 'data_source' },
        workspaceId: 'ws', dataSourceId: 'ds', viewId: HARNESS_VIEW_ID,
    },
}

const PII_CLARIFY: Clarification = {
    id: 'clr_pii',
    question: 'There’s no property called “PII”. Which of these means PII here?',
    concept: 'PII',
    options: [
        { id: 'opt_1', label: 'Tag “pii”', description: 'on 312 columns', count: 312 },
        { id: 'opt_2', label: 'personal_data is true', description: 'property on 290 columns', count: 290 },
        { id: 'opt_3', label: 'Either of these', description: '340 columns', count: 340 },
    ],
    allowRemember: true,
    allowOther: true,
}

const RESULTS_FRAMES: ScriptFrame[] = [
    step('s3', 'Searching columns tagged pii, changed since 14 November', 'running'),
    step('s3', 'Searching columns tagged pii, changed since 14 November', 'done', '214 found'),
    ...words('**214 columns** tagged PII were updated in the last 7 days, most of them in the CRM tables. '
        + 'Nine tables hold them; `crm.contacts` alone has 31.'),
    block({ id: 'blk_results', type: 'results', data: {
        title: 'PII columns updated in the last 7 days', total: 214, totalExact: true,
        byType: [{ type: 'schemaField', label: 'Column', count: 214 }],
        byContainer: [
            { entity: e('urn:tbl:contacts', 'contacts', 'dataset', ['Snowflake', 'crm']), count: 31 },
            { entity: customers, count: 24 },
            { entity: e('urn:tbl:leads', 'leads', 'dataset', ['Snowflake', 'crm']), count: 19 },
            { entity: e('urn:tbl:payments', 'payments', 'dataset', ['Snowflake', 'finance']), count: 12 },
        ],
        items: ['email', 'phone', 'first_name', 'last_name', 'date_of_birth', 'street', 'postcode', 'iban', 'tax_id', 'ip_address', 'device_id', 'passport_no']
            .map((n, i) => e(`urn:col:${n}`, n, 'schemaField', ['Snowflake', 'crm', i % 2 ? 'contacts' : 'leads'])),
        resultRef: 'r1',
        query: { predicate: { kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['schemaField'] }, { kind: 'tag', op: 'hasAny', values: ['pii'] }] }, scopeMode: 'data_source' },
        workspaceId: 'ws', dataSourceId: 'ds', viewId: HARNESS_VIEW_ID,
        notes: ['“Updated” reads the lastModified property; 12 tables don’t record it and were left out.'],
    } }),
    { event: 'followups', data: ['Do any of those feed a dashboard?', 'Who owns these tables?'] },
    done(),
]

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const HOUR = 3600_000

/** What the assistant knows about the harness view: four layers, a four-step hierarchy, five kinds of connection. */
export const VIEW_BRIEF: ContextBrief = {
    kind: 'view',
    about: {
        name: HARNESS_VIEW_NAME,
        description: 'Where shipments, suppliers and stock levels come from: the ERP and carrier feeds as they land, '
            + 'through staging and the operations marts, to the dashboards the Monday ops review reads. '
            + 'Certified by data platform; columns tagged pii are masked outside the marts.',
        workspace: 'Operations', dataSource: 'Snowflake prod', semanticLayer: 'Supply chain v3',
        template: 'Layered lineage', layout: 'layered-lineage', tags: ['supply-chain', 'certified'],
        owner: 'Ana Ruiz', updatedAt: ago(2 * 24 * HOUR), dataUpdatedAt: ago(4 * HOUR), visibility: 'workspace',
        viewId: HARNESS_VIEW_ID, workspaceId: 'ws', dataSourceId: 'ds',
    },
    scope: { entityScope: 'all', visibleTypes: [], maxDepth: null, roots: null },
    layers: [
        { name: 'Sources', description: 'Raw feeds as they land', types: ['dataPlatform', 'container'] },
        { name: 'Staging', description: 'Cleaned and typed, one table per feed', types: ['dataset', 'dataJob'] },
        { name: 'Marts', description: 'Modelled for the business', types: ['dataset', 'schemaField'] },
        { name: 'Reports', description: 'What people read', types: ['dashboard', 'chart'] },
    ],
    types: [
        { id: 'schemaField', name: 'Column', plural: 'Columns', level: 3, inView: 1420, inSource: 5210, contains: [], containedBy: ['dataset'], root: false },
        { id: 'dataset', name: 'Table', plural: 'Tables', level: 2, inView: 184, inSource: 612, contains: ['schemaField'], containedBy: ['container'], root: false,
            description: 'A table or view in the warehouse' },
        { id: 'chart', name: 'Chart', plural: 'Charts', level: null, inView: 64, inSource: 210, contains: [], containedBy: ['dashboard'], root: false },
        { id: 'dataJob', name: 'Job', plural: 'Jobs', level: null, inView: 41, inSource: 96, contains: [], containedBy: [], root: false },
        { id: 'tag', name: 'Tag', plural: 'Tags', level: null, inView: 22, inSource: 22, contains: [], containedBy: [], root: false },
        { id: 'dashboard', name: 'Dashboard', plural: 'Dashboards', level: null, inView: 18, inSource: 44, contains: ['chart'], containedBy: [], root: false },
        { id: 'container', name: 'Schema', plural: 'Schemas', level: 1, inView: 12, inSource: 38, contains: ['dataset'], containedBy: ['dataPlatform'], root: false },
        { id: 'dataFlow', name: 'Pipeline', plural: 'Pipelines', level: null, inView: 9, inSource: 21, contains: [], containedBy: [], root: false },
        { id: 'dataPlatform', name: 'Platform', plural: 'Platforms', level: 0, inView: 3, inSource: 5, contains: ['container'], containedBy: [], root: true },
    ],
    hierarchy: { chains: [['dataPlatform', 'container', 'dataset', 'schemaField']] },
    connections: [
        { id: 'TRANSFORMS', name: 'Transforms', class: 'lineage', category: 'flow', description: 'One column or table is computed from another',
            from: ['schemaField', 'dataset'], to: ['schemaField', 'dataset'], count: 2380 },
        { id: 'CONTAINS', name: 'Contains', class: 'containment', category: 'structural', description: 'A platform holds schemas, a schema tables, a table columns',
            from: ['dataPlatform', 'container', 'dataset'], to: ['container', 'dataset', 'schemaField'], count: 1619 },
        { id: 'TAGGED_WITH', name: 'Tagged with', class: 'other', category: 'metadata', description: 'A glossary tag on an asset',
            from: ['dataset', 'schemaField'], to: ['tag'], count: 318 },
        { id: 'PRODUCES', name: 'Produces', class: 'lineage', category: 'flow', description: 'A job writes a table', from: ['dataJob'], to: ['dataset'], count: 212 },
        { id: 'CONSUMES', name: 'Consumes', class: 'lineage', category: 'flow', description: 'A dashboard or chart reads a table',
            from: ['dataset'], to: ['chart', 'dashboard'], count: 148 },
    ],
    contents: {
        entities: 1773, complete: true,
        properties: [
            { key: 'owner', count: 1631, coverage: 0.92, kinds: ['string'] },
            { key: 'description', count: 1418, coverage: 0.8, kinds: ['string'] },
            { key: 'lastModified', count: 1241, coverage: 0.7, kinds: ['datetime'] },
            { key: 'classification', count: 887, coverage: 0.5, kinds: ['string'] },
            { key: 'rowCount', count: 184, coverage: 0.1, kinds: ['number'] },
            { key: 'schedule', count: 41, coverage: 0.02, kinds: ['string'] },
            { key: 'sla_hours', count: 30, coverage: 0.02, kinds: ['number'] },
        ],
        propertiesNotShown: 14,
        tags: [{ tag: 'pii', count: 214 }, { tag: 'certified', count: 96 }, { tag: 'deprecated', count: 12 }],
    },
    typeProperty: null,
    caveats: [],
    notes: ['Counts in the view are exact; whole-source counts are from the last profile, 4 hours ago.'],
}

/** A FalkorDB source with one label and no semantic layer: everything is a Node; `kind` says what. */
export const GENERIC_BRIEF: ContextBrief = {
    kind: 'view',
    about: {
        name: 'Estate graph', description: 'Everything the crawler found in the estate, as one graph.',
        workspace: 'Platform', dataSource: 'FalkorDB estate', semanticLayer: null, layout: 'graph', tags: [],
        owner: 'Sam Lee', updatedAt: ago(6 * 24 * HOUR), dataUpdatedAt: ago(HOUR), visibility: 'workspace',
        viewId: HARNESS_VIEW_ID, workspaceId: 'ws', dataSourceId: 'ds',
    },
    layers: [],
    types: [{ id: 'Node', name: 'Node', plural: 'Nodes', level: 0, inView: 500, inSource: 500, contains: [], containedBy: [], root: true }],
    hierarchy: { chains: [] },
    connections: [{ id: 'RELATED', name: 'RELATED', class: 'lineage', category: null, description: null, from: ['Node'], to: ['Node'], count: 1240 }],
    contents: {
        entities: 500, complete: true,
        properties: [
            { key: 'name', count: 500, coverage: 1, kinds: ['string'] },
            { key: 'kind', count: 500, coverage: 1, kinds: ['string'] },
            { key: 'owner_team', count: 430, coverage: 0.86, kinds: ['string'] },
            { key: 'cron', count: 20, coverage: 0.04, kinds: ['string'] },
        ],
        propertiesNotShown: 0, tags: [],
    },
    typeProperty: {
        status: 'suggested', on: 'Node', key: 'kind',
        values: [{ value: 'table', count: 300 }, { value: 'column', count: 150 }, { value: 'dashboard', count: 30 }, { value: 'job', count: 20 }],
        alternatives: [{ key: 'owner_team', coverage: 0.86, distinct: 6 }],
    },
    caveats: [
        { code: 'few_types', action: 'confirm_type',
            text: 'Everything here is a ‘Node’ (500). What kind each one is looks like it’s in kind: table 300 · column 150 · dashboard 30 · job 20.' },
        { code: 'no_containment', text: 'Nothing here sits inside anything else, so there is no hierarchy to browse or roll up.' },
        { code: 'lineage_by_default', text: 'No semantic layer is assigned, so every connection is read as lineage. An administrator can assign one under Semantic layers.' },
    ],
    notes: [],
}

export const WORKSPACE_BRIEF: ContextBrief = {
    kind: 'workspace',
    about: {
        name: 'Operations', description: 'Supply chain, logistics and inventory — the ops team’s data and the views they run the week on.',
        owner: 'Ana Ruiz', updatedAt: ago(26 * HOUR), tags: ['ops'], workspaceId: 'ws',
    },
    dataSources: [
        { id: 'ds', name: 'Snowflake prod', semanticLayer: 'Supply chain v3' },
        { id: 'ds2', name: 'Carrier events (Kafka)', semanticLayer: null },
        { id: 'ds3', name: 'dbt Cloud', semanticLayer: 'Analytics core' },
    ],
    caveats: [],
    notes: ['14 views in this workspace; the most used is Supply chain.'],
}

const TYPE_CLARIFY: Clarification = {
    id: 'clr_type',
    question: 'Everything here is a ‘Node’. Which property says what kind of thing each one is?',
    concept: 'entity type',
    options: [
        { id: 'opt_kind', label: 'kind', description: 'table 300 · column 150 · dashboard 30 · job 20', count: 500 },
        { id: 'opt_owner', label: 'owner_team', description: '6 values: data-platform, sales-analytics, finance…', count: 430 },
    ],
    allowRemember: true,
    allowOther: true,
}

export const AI_FIXTURES: Record<string, AiFixture> = {
    empty: { note: 'the welcome, on a view with two entities selected', selected: ['urn:col:first_name', 'urn:tbl:customers'] },
    emptyApp: { note: 'the welcome, with nothing selected' },
    helpEmpty: { note: 'the Help welcome', persona: 'help' },
    notConfigured: { note: 'no AI model connected yet', status: { configured: false, personas: { data: true, help: true } } },

    impact: {
        note: 'the flagship impact report: what breaks if first_name is dropped',
        selected: ['urn:col:first_name'],
        question: 'What breaks if first_name is dropped?',
        frames: [
            meta(),
            step('s1', 'Finding first_name', 'running'),
            step('s1', 'Finding first_name', 'done', '1 column, in Snowflake › sales › customers'),
            step('s2', 'Walking its downstream lineage', 'running'),
            step('s2', 'Walking its downstream lineage', 'done', '47 entities, up to 6 hops away'),
            step('s3', 'Finding owners and schedules', 'running'),
            step('s3', 'Finding owners and schedules', 'done', '2 owning teams · 1 scheduled job'),
            ...words('Dropping **first_name** would break **3 dashboards** — Customer 360, Churn watch and the CRM contact list — '
                + 'through 31 columns in 9 tables. Tell **data-platform-team** first: they own most of the tables in between. '
                + 'The first job to fail would be `nightly_customers`, tonight at 04:00 UTC.'),
            block(IMPACT_BLOCK),
            { event: 'followups', data: ['Which of these dashboards are used most?', 'Is there a column that could replace it?'] },
            { event: 'usage', data: { inputTokens: 4200, outputTokens: 310, model: 'gpt-4.1' } },
            done(),
        ],
    },

    upstream: {
        note: 'provenance: where a dashboard metric comes from (sources, no "what breaks")',
        question: 'Where does Customer 360 come from?',
        frames: [
            meta(),
            step('s1', 'Walking its upstream lineage', 'running'),
            step('s1', 'Walking its upstream lineage', 'done', '23 entities, 5 hops'),
            ...words('Customer 360 is fed by **23 upstream entities**, starting from two sources: the CRM export and the web events stream.'),
            block({ id: 'blk_up', type: 'impact', data: {
                ...(IMPACT_BLOCK.data as Extract<Block, { type: 'impact' }>['data']),
                direction: 'upstream', target: c360, change: null, severity: 'medium',
                severityReasons: ['2 original sources', 'Rolled up through 3 tables'],
                summary: 'Customer 360 is fed by 23 upstream entities, from 2 original sources.',
                totals: { entities: 23, exact: false, byType: [
                    { type: 'schemaField', label: 'Column', count: 14 }, { type: 'dataset', label: 'Table', count: 7 }, { type: 'dataJob', label: 'Job', count: 2 }] },
                consumers: [{ ...e('urn:src:crm', 'crm_export', 'dataset', ['S3', 'landing']), hops: 5 }, { ...e('urn:src:web', 'web_events', 'dataset', ['Kafka']), hops: 4 }],
                owners: [], timing: null, grain: 'coarse', truncated: true,
                notes: ['No owner property is set on these assets.'],
                paths: [{ nodes: [e('urn:src:crm', 'crm_export', 'dataset', ['S3', 'landing']), customers, dimCustomer, c360],
                    edges: [{ type: 'PRODUCES', detail: 'nightly load' }, { type: 'TRANSFORMS', detail: null }, { type: 'CONSUMES', detail: null }] }],
                trace: { urn: c360.urn, direction: 'upstream', depth: 10 },
            } }),
            done(),
        ],
    },

    pii: {
        note: 'a clarification: there is no property called PII',
        question: 'Which tables hold PII, and were any updated last week?',
        frames: [
            meta(),
            step('s1', 'Looking for “PII” in this data source', 'running'),
            step('s1', 'Looking for “PII” in this data source', 'done', 'No property by that name — 3 likely meanings'),
            { event: 'clarify', data: PII_CLARIFY },
            done('clarify'),
        ],
        afterClarify: RESULTS_FRAMES,
    },

    results: {
        note: 'a search answer: the count, by type, where, the first of them',
        question: 'Which PII columns were updated in the last 7 days?',
        frames: [meta(), step('s1', 'Reading “PII” as the tag pii', 'done', 'You chose this before, for this data source'), ...RESULTS_FRAMES],
    },

    help: {
        note: 'the Help persona: an answer from the guide, with its sources',
        persona: 'help',
        question: 'How do I share a view?',
        frames: [
            meta('help'),
            step('s1', 'Searching the user guide', 'running'),
            step('s1', 'Searching the user guide', 'done', '3 passages'),
            ...words('Open the view, then choose **Share** in its header [1]. You can invite people by name or copy a link — '
                + 'anyone the view is shared with can open it, whatever workspace they are in [1]. To let others change it, '
                + 'make them a **co-owner** [2]. Your company’s policy asks that views holding customer data are only shared inside your team [3].'),
            block({ id: 'blk_cite', type: 'citations', data: { items: [
                { n: 1, title: 'Managing & Sharing Views', section: 'Share a View with people or groups', href: '/guide/managing-views#share-a-view-with-people-or-groups',
                    snippet: 'Choose Share in the view header. Invite people by name, or copy the view’s link…', source: 'guide', trust: 'product' },
                { n: 2, title: 'Managing & Sharing Views', section: 'Owners and co-owners', href: '/guide/managing-views#owners-and-co-owners',
                    snippet: 'Viewers can open a view; co-owners can change its layers, layout and who it is shared with…', source: 'guide', trust: 'product' },
                { n: 3, title: 'Data handling policy', section: 'Customer data', href: 'https://wiki.example.com/policy/data',
                    snippet: 'Views that hold customer personal data are shared within the owning team only…', source: 'Confluence', trust: 'external' },
            ] } }),
            { event: 'followups', data: ['How do I give someone edit rights?', 'Can I share with people outside my workspace?'] },
            done(),
        ],
    },

    views: {
        note: 'views that answer the question',
        question: 'Do we have views about supply-chain failures?',
        frames: [
            meta(),
            step('s1', 'Searching the views catalogue', 'done', '3 views match'),
            ...words('Yes — three views are about supply-chain failures. **Supplier risk** is the closest match.'),
            block({ id: 'blk_views', type: 'views', data: { items: [
                { id: 'v-sr', name: 'Supplier risk', description: 'Late and failed supplier deliveries, by region, with the jobs that load them.',
                    workspaceName: 'Operations', dataSourceName: 'Snowflake', tags: ['supply-chain', 'risk'], reason: 'matches “supplier failures”', updatedAt: '2026-11-18T10:00:00Z' },
                { id: 'v-lt', name: 'Logistics lead times', description: 'Where shipment delays start, from the carrier feeds to the ops dashboards.',
                    workspaceName: 'Operations', dataSourceName: 'Snowflake', tags: ['logistics'], reason: 'about delays in the supply chain', updatedAt: '2026-11-02T10:00:00Z' },
                { id: 'v-inv', name: 'Inventory stock-outs', workspaceName: 'Retail', dataSourceName: 'BigQuery', tags: [], reason: 'mentions “stock-out failures”', updatedAt: null },
            ] } }),
            done(),
        ],
    },

    query: {
        note: 'queries the assistant wrote: a search, and Cypher to run yourself',
        question: 'Write a query for PII datasets that feed a dashboard',
        frames: [
            meta(),
            step('s1', 'Drafting the search', 'done', 'Checked: 31 matches'),
            ...words('Here is the search, and the same thing as Cypher if you would rather run it yourself.'),
            block({ id: 'blk_q1', type: 'query', data: {
                language: 'search', predicate: { kind: 'group', op: 'and', children: [
                    { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'tag', op: 'hasAny', values: ['pii'] }] },
                explanation: 'Tables tagged pii that feed a dashboard, within 3 hops.', assumptions: ['“PII” read as the tag pii'],
                count: 31, countExact: true, viewId: HARNESS_VIEW_ID,
            } }),
            block({ id: 'blk_q2', type: 'query', data: {
                language: 'cypher', cypher: "MATCH (d:Dataset)-[:TRANSFORMS*1..3]->(:Dashboard)\nWHERE 'pii' IN d.tags\nRETURN DISTINCT d LIMIT 100",
                explanation: 'The same question, as Cypher.', assumptions: [], guard: { ok: true }, viewId: HARNESS_VIEW_ID,
            } }),
            done(),
        ],
    },

    error: {
        note: 'a turn that failed, said plainly, with Try again',
        question: 'What feeds the revenue dashboard?',
        frames: [
            meta(),
            step('s1', 'Finding the revenue dashboard', 'done', '1 match'),
            step('s2', 'Walking its upstream lineage', 'error', 'The graph didn’t answer in time'),
            { event: 'error', data: { code: 'platform_error', message: 'The lineage read timed out.' } },
            done('error'),
        ],
    },

    thinking: {
        note: 'still working: the live steps, and the shimmer where the answer will be',
        question: 'What breaks if first_name is dropped?',
        frames: [meta(), step('s1', 'Finding first_name', 'done', '1 column'), step('s2', 'Walking its downstream lineage', 'running')],
        holdAfter: 3,
    },

    contextCard: { note: 'the “What I know” card, open over the context chip', brief: VIEW_BRIEF, openContext: true },
    contextBlock: {
        note: 'what it knows, as a card in an answer',
        brief: VIEW_BRIEF,
        question: 'What do you know about this view?',
        frames: [
            meta(),
            step('s1', 'Reading what I know about Supply chain', 'done', '9 types · 4 layers · 5 kinds of connection'),
            ...words('**Supply chain** follows data from the **Sources** layer to **Reports**: platforms hold schemas, schemas hold '
                + 'tables and tables hold columns, and 1,773 entities are on it. Lineage runs mostly column to column (2,380 links); '
                + 'jobs write the tables, and dashboards and charts read them.'),
            block({ id: 'blk_ctx', type: 'context', data: VIEW_BRIEF }),
            { event: 'followups', data: ['How does data flow from Sources to Reports?', 'Which columns hold PII?'] },
            done(),
        ],
    },
    genericWelcome: { note: 'the welcome on a generic schema: one Node type, kinds in a property', brief: GENERIC_BRIEF, viewName: 'Estate graph' },
    genericCard: {
        note: 'the card on a generic schema, with its heads-up and the kinds it guessed',
        brief: GENERIC_BRIEF, viewName: 'Estate graph', openContext: true,
    },
    typeConfirm: {
        note: 'confirming the property that says what kind of thing each one is',
        brief: GENERIC_BRIEF, viewName: 'Estate graph',
        question: 'Which property says what kind of thing each one is?',
        frames: [
            meta(),
            step('s1', 'Looking for what kind each Node is', 'running'),
            step('s1', 'Looking for what kind each Node is', 'done', '2 properties could say'),
            { event: 'clarify', data: TYPE_CLARIFY },
            done('clarify'),
        ],
        afterClarify: [
            ...words('Got it — from now on a **table** here is a Node whose `kind` is table, and the same for column, dashboard and job.'),
            done(),
        ],
    },
    workspaceWelcome: {
        note: 'the welcome on a workspace page',
        route: '/workspaces/ws', page: { kind: 'workspace', id: 'ws', title: 'Operations' }, brief: WORKSPACE_BRIEF,
    },
    docHelp: {
        note: 'a guide page: Help, about the page being read',
        route: '/guide/ai-assistant', page: { kind: 'doc', id: '/guide/ai-assistant', title: 'The AI assistant', persona: 'help' },
    },
    launcher: { note: 'the launcher, rail folded away', railClosed: true },
    launcherPill: { note: 'the launcher focused: its pill and tip', railClosed: true, focusLauncher: true },
    launcherUnread: { note: 'the launcher with an answer waiting', railClosed: true, unread: true },
    launcherStreaming: {
        note: 'the launcher while an answer is still being written',
        railClosed: true, question: 'What breaks if first_name is dropped?',
        frames: [meta(), step('s1', 'Finding first_name', 'done', '1 column'), step('s2', 'Walking its downstream lineage', 'running')],
        holdAfter: 3,
    },
    launcherDock: {
        note: 'the corner’s stacking: canvas dock, then the launcher, then a notification',
        railClosed: true, dock: true, notify: 'Opened “Supply chain” · 1,773 entities',
    },
    launcherChecklist: { note: 'the corner on a blank model: dock, launcher, First steps', railClosed: true, dock: true, checklist: true },

    streaming: {
        note: 'words arriving: the typing caret',
        question: 'What breaks if first_name is dropped?',
        frames: [
            meta(), step('s1', 'Finding first_name', 'done'), step('s2', 'Walking its downstream lineage', 'done', '47 entities'),
            ...words('Dropping **first_name** would break **3 dashboards** — Customer 360, Churn watch and'),
        ],
        holdAfter: 99,
    },
}

export const DEFAULT_STATUS = CONFIGURED
