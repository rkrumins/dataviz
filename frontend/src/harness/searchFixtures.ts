/**
 * The catalog the search harness answers from: a small but honest data
 * estate — platforms, containers, datasets and their columns, dashboards
 * and charts — with containment, column- and table-level lineage, tags
 * and the properties people search by (owner, description, row counts,
 * data types). Shaped so every search state is reachable: PII columns,
 * a dead end, an orphan, undocumented and unowned datasets, a name that is
 * both a container and a tag ("Finance"), and lineage several hops deep.
 */
import type { Predicate } from '@/types/search'


export interface HarnessEntity {
    urn: string
    displayName: string
    entityType: string
    parent: string | null
    tags: string[]
    description?: string
    layerAssignment?: string
    properties: Record<string, unknown>
}

export interface HarnessEdge {
    source: string
    target: string
    type: string
    properties: Record<string, unknown>
}

export const ENTITY_TYPES: ReadonlyArray<{
    id: string; name: string; pluralName: string; icon: string; color: string
}> = [
    { id: 'dataPlatform', name: 'Platform', pluralName: 'Platforms', icon: 'Database', color: '#6366f1' },
    { id: 'container', name: 'Container', pluralName: 'Containers', icon: 'FolderTree', color: '#8b5cf6' },
    { id: 'dataset', name: 'Dataset', pluralName: 'Datasets', icon: 'Table2', color: '#10b981' },
    { id: 'schemaField', name: 'Column', pluralName: 'Columns', icon: 'Columns3', color: '#0ea5e9' },
    { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards', icon: 'LayoutDashboard', color: '#f59e0b' },
    { id: 'chart', name: 'Chart', pluralName: 'Charts', icon: 'BarChart3', color: '#f97316' },
]

export const LAYERS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'raw', name: 'Raw' },
    { id: 'silver', name: 'Silver' },
    { id: 'gold', name: 'Gold' },
    { id: 'bi', name: 'BI' },
]


const entities: HarnessEntity[] = []
const edges: HarnessEdge[] = []

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

function add(entityType: string, displayName: string, parent: string | null,
    extra: Partial<Omit<HarnessEntity, 'urn' | 'displayName' | 'entityType' | 'parent'>> = {}): string {
    const urn = `urn:li:${entityType}:${parent ? `${parent.split(':').pop()}.` : ''}${slug(displayName)}`
    entities.push({ urn, displayName, entityType, parent, tags: [], properties: {}, ...extra })
    return urn
}

function feeds(source: string, target: string, properties: Record<string, unknown> = {}) {
    edges.push({ source, target, type: 'TRANSFORMS', properties })
}


interface DatasetSpec {
    name: string
    owner?: string
    description?: string
    rowCount: number
    tags?: string[]
    columns: Array<[name: string, dataType: string, tags?: string[]]>
}

/** A dataset and its columns, under ``container`` in ``layer``. */
function dataset(container: string, layer: string, spec: DatasetSpec): Record<string, string> {
    const urn = add('dataset', spec.name, container, {
        tags: spec.tags ?? [],
        description: spec.description,
        layerAssignment: layer,
        properties: {
            ...(spec.owner ? { owner: spec.owner } : {}),
            rowCount: spec.rowCount,
            ...(spec.description ? { description: spec.description } : {}),
        },
    })
    const cols: Record<string, string> = { $: urn }
    for (const [name, dataType, tags] of spec.columns) {
        cols[name] = add('schemaField', name, urn, {
            tags: tags ?? [],
            layerAssignment: layer,
            properties: { dataType, nullable: !name.endsWith('_id') && !name.endsWith('_key') },
        })
    }
    return cols
}


// -- Snowflake ---------------------------------------------------------------
const snowflake = add('dataPlatform', 'Snowflake', null, { properties: { vendor: 'Snowflake' } })
const raw = add('container', 'RAW', snowflake, { layerAssignment: 'raw' })
const silver = add('container', 'SILVER', snowflake, { layerAssignment: 'silver' })
const gold = add('container', 'GOLD', snowflake, { layerAssignment: 'gold' })

const rawOrders = dataset(raw, 'raw', { name: 'raw_orders', owner: 'ingest@corp', rowCount: 4_812_330,
    description: 'Orders as the shop writes them, one row per order.',
    columns: [['order_id', 'bigint'], ['customer_id', 'bigint'], ['amount', 'decimal(15,2)'],
        ['currency', 'string'], ['ordered_at', 'timestamp']] })
const rawCustomers = dataset(raw, 'raw', { name: 'raw_customers', owner: 'ingest@corp', rowCount: 912_004,
    description: 'Customer records from the CRM.',
    columns: [['customer_id', 'bigint'], ['email', 'string', ['PII', 'GDPR']], ['phone', 'string', ['PII', 'GDPR']],
        ['country', 'string'], ['created_at', 'timestamp']] })
const rawPayments = dataset(raw, 'raw', { name: 'raw_payments', rowCount: 4_650_118,
    columns: [['payment_id', 'bigint'], ['order_id', 'bigint'], ['card_last4', 'string', ['PII']],
        ['amount', 'decimal(15,2)']] })
dataset(raw, 'raw', { name: 'legacy_orders_backup', rowCount: 1_204_000, tags: ['Deprecated'],
    columns: [['order_id', 'bigint'], ['payload', 'string']] })

const cleanOrders = dataset(silver, 'silver', { name: 'clean_orders', owner: 'alice@corp', rowCount: 4_790_112,
    description: 'Orders, deduplicated and converted to US dollars.',
    columns: [['order_id', 'bigint'], ['customer_id', 'bigint'], ['amount_usd', 'decimal(15,2)'],
        ['ordered_at', 'timestamp'], ['channel', 'string']] })
const cleanCustomers = dataset(silver, 'silver', { name: 'clean_customers', owner: 'alice@corp', rowCount: 905_773,
    description: 'Customers with one row per person.',
    columns: [['customer_id', 'bigint'], ['email', 'string', ['PII', 'GDPR']], ['country', 'string'],
        ['segment', 'string']] })
const cleanPayments = dataset(silver, 'silver', { name: 'clean_payments', rowCount: 4_640_002, tags: ['Finance'],
    columns: [['payment_id', 'bigint'], ['order_id', 'bigint'], ['amount_usd', 'decimal(15,2)'],
        ['method', 'string']] })

const factOrders = dataset(gold, 'gold', { name: 'fact_orders', owner: 'finance-data@corp', rowCount: 4_788_640,
    tags: ['Finance', 'Certified'], description: 'One row per order, with margin and channel.',
    columns: [['order_key', 'bigint'], ['customer_key', 'bigint'], ['amount_usd', 'decimal(15,2)'],
        ['margin', 'decimal(15,2)'], ['channel', 'string'], ['order_date', 'date']] })
const dimCustomer = dataset(gold, 'gold', { name: 'dim_customer', owner: 'bob@corp', rowCount: 905_612,
    tags: ['Certified'], description: 'The customer dimension.',
    columns: [['customer_key', 'bigint'], ['email_hash', 'string'], ['country', 'string'],
        ['segment', 'string'], ['lifetime_value', 'decimal(15,2)']] })
const revenueDaily = dataset(gold, 'gold', { name: 'revenue_daily', owner: 'finance-data@corp', rowCount: 1_461,
    tags: ['Finance', 'Certified'], description: 'Revenue by day and region.',
    columns: [['day', 'date'], ['revenue_usd', 'decimal(18,2)'], ['orders', 'bigint'], ['region', 'string']] })
const churnScores = dataset(gold, 'gold', { name: 'churn_scores', rowCount: 905_612,
    columns: [['customer_key', 'bigint'], ['churn_probability', 'double'], ['scored_at', 'timestamp']] })

// -- Kafka -------------------------------------------------------------------
const kafka = add('dataPlatform', 'Kafka', null, { properties: { vendor: 'Confluent' } })
const events = add('container', 'EVENTS', kafka, { layerAssignment: 'raw' })
const orderEvents = dataset(events, 'raw', { name: 'order_events', owner: 'ingest@corp', rowCount: 98_330_412,
    description: 'Order lifecycle events.',
    columns: [['event_id', 'string'], ['order_id', 'bigint'], ['event_type', 'string'], ['ts', 'timestamp']] })
const clickEvents = dataset(events, 'raw', { name: 'click_events', rowCount: 812_004_551,
    columns: [['session_id', 'string'], ['user_id', 'string', ['PII']], ['page', 'string'], ['ts', 'timestamp']] })

// -- Tableau -----------------------------------------------------------------
const tableau = add('dataPlatform', 'Tableau', null, { properties: { vendor: 'Salesforce' } })
const financeProject = add('container', 'Finance', tableau, { layerAssignment: 'bi' })
const salesProject = add('container', 'Sales', tableau, { layerAssignment: 'bi' })
const marketingProject = add('container', 'Marketing', tableau, { layerAssignment: 'bi' })

const cfo = add('dashboard', 'CFO Revenue Dashboard', financeProject, { tags: ['Finance', 'Certified'],
    layerAssignment: 'bi', description: 'Revenue, margin and orders for the leadership team.',
    properties: { owner: 'finance-data@corp' } })
const salesPerf = add('dashboard', 'Sales Performance Dashboard', salesProject, { layerAssignment: 'bi',
    properties: { owner: 'sales-ops@corp' } })
const campaigns = add('dashboard', 'Campaign Overview', marketingProject, { layerAssignment: 'bi' })
const revenueByRegion = add('chart', 'Revenue by Region', cfo, { layerAssignment: 'bi' })
const marginTrend = add('chart', 'Margin Trend', cfo, { layerAssignment: 'bi' })
const pipeline = add('chart', 'Pipeline by Industry', salesPerf, { layerAssignment: 'bi' })
const winRate = add('chart', 'Win Rate Trend', salesPerf, { layerAssignment: 'bi' })
const channelMix = add('chart', 'Channel Mix', campaigns, { layerAssignment: 'bi' })

// -- Lineage: tables ---------------------------------------------------------
const batch = { mode: 'batch' }
feeds(rawOrders.$, cleanOrders.$, batch)
feeds(orderEvents.$, cleanOrders.$, { mode: 'stream' })
feeds(rawCustomers.$, cleanCustomers.$, batch)
feeds(rawPayments.$, cleanPayments.$, batch)
feeds(cleanOrders.$, factOrders.$, batch)
feeds(cleanPayments.$, factOrders.$, batch)
feeds(cleanCustomers.$, dimCustomer.$, batch)
feeds(dimCustomer.$, factOrders.$, batch)
feeds(factOrders.$, revenueDaily.$, batch)
feeds(dimCustomer.$, churnScores.$, batch)
feeds(revenueDaily.$, revenueByRegion, { logic: 'Direct Query' })
feeds(factOrders.$, marginTrend, { logic: 'Extract' })
feeds(dimCustomer.$, pipeline, { logic: 'Extract' })
feeds(factOrders.$, winRate, { logic: 'Direct Query' })
feeds(clickEvents.$, channelMix, { logic: 'Extract' })

// -- Lineage: columns --------------------------------------------------------
feeds(rawCustomers.email, cleanCustomers.email)
feeds(cleanCustomers.email, dimCustomer.email_hash)
feeds(rawCustomers.country, cleanCustomers.country)
feeds(cleanCustomers.country, dimCustomer.country)
feeds(rawOrders.amount, cleanOrders.amount_usd)
feeds(cleanOrders.amount_usd, factOrders.amount_usd)
feeds(cleanPayments.amount_usd, factOrders.margin)
feeds(factOrders.amount_usd, revenueDaily.revenue_usd)
feeds(factOrders.order_key, revenueDaily.orders)
feeds(cleanOrders.channel, factOrders.channel)
feeds(dimCustomer.customer_key, churnScores.customer_key)

export const HARNESS_ENTITIES: readonly HarnessEntity[] = entities
export const HARNESS_EDGES: readonly HarnessEdge[] = edges
export const HARNESS_VIEW_ID = 'view-harness'
export const URNS = { snowflake, gold, factOrders: factOrders.$, cfo, revenueDaily: revenueDaily.$ }


/** A named state of the panel, as a screenshot shows it. */
export interface SearchFixture {
    /** What the draft holds when the panel opens. */
    draft?: Predicate | null
    /** The editor the card opens in. */
    editorMode?: string
    note: string
}

const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })

const formDraft: Predicate = {
    kind: 'group', op: 'and', children: [
        type('dataset'),
        { kind: 'related', axis: 'downstream', maxHops: 3,
            where: { kind: 'group', op: 'and', children: [type('chart'),
                { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ path: ['**', 'Finance'] }] } }] } },
    ],
}

export const SEARCH_FIXTURES: Record<string, SearchFixture> = {
    empty: { draft: null, note: 'The empty panel: where everyone starts.' },
    form: {
        editorMode: 'form',
        note: 'Today\'s cards, holding a relationship: datasets that feed a chart in Finance.',
        draft: formDraft,
    },
    sentence: {
        editorMode: 'sentence',
        note: 'The same query as a sentence: datasets that feed a chart in Finance.',
        draft: formDraft,
    },
    sentenceFlat: {
        editorMode: 'sentence',
        note: 'Clauses narrowing the matches: certified datasets with over 100k rows and an owner.',
        draft: { kind: 'group', op: 'and', children: [
            type('dataset'),
            { kind: 'tag', op: 'hasAny', values: ['Certified'] },
            { kind: 'property', key: 'rowCount', op: 'gt', value: 100000 } as Predicate,
            { kind: 'hasProperty', key: 'owner', negate: false },
        ] },
    },
    rescue: {
        editorMode: 'sentence',
        note: 'A query that matches nothing: the line where it runs out, and the fixes that find something.',
        draft: { kind: 'group', op: 'and', children: [
            type('dataset'),
            { kind: 'tag', op: 'hasAny', values: ['Certified'] },
            { kind: 'related', axis: 'downstream', where: type('dashboard') },
        ] },
    },
    sentenceAny: {
        editorMode: 'sentence',
        note: 'Any of several clauses, each counted within the subject: datasets holding PII or read by nothing.',
        draft: { kind: 'group', op: 'and', children: [
            type('dataset'),
            { kind: 'group', op: 'or', children: [
                { kind: 'tag', op: 'hasAny', values: ['PII'] },
                { kind: 'isLeaf' },
            ] },
        ] },
    },
}
