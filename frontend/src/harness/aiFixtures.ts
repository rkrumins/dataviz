/**
 * The AI harness's scripted answers: what the in-memory service (`aiBackend.ts`) streams for each
 * named state of the assistant rail. Each is a question and the frames of its answer, in the
 * contract's order (meta, steps, text, blocks, follow-ups, done); `holdAfter` leaves the stream
 * open part-way, to look at an answer still being worked out.
 */
import type { AiStatus, Block, Clarification, Entity } from '../features/ai-assistant/api/types'

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
    knowledge: { docs: 'ready', views: 'ready' }, dataPolicy: { sendDescriptions: true, sendPropertyValues: false },
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
        summary: 'Dropping first_name breaks 3 dashboards and 12 columns in 4 tables.',
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
                + 'through 12 columns in 4 tables. Tell **data-platform-team** first: they own most of the tables in between. '
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
                + 'give them **Can edit** [2]. Your company’s policy asks that views holding customer data are only shared inside your team [3].'),
            block({ id: 'blk_cite', type: 'citations', data: { items: [
                { n: 1, title: 'Sharing a view', section: 'Share with people', href: '/guide/managing-views#share-with-people',
                    snippet: 'Choose Share in the view header. Invite people by name, or copy the view’s link…', source: 'guide', trust: 'product' },
                { n: 2, title: 'Roles and permissions', section: 'View roles', href: '/guide/rbac#view-roles',
                    snippet: 'Viewers can open a view; editors can change its layers and layout…', source: 'guide', trust: 'product' },
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
