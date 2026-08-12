/**
 * Fixtures for the visual harness. Each one reproduces a real reported
 * shape, so a screenshot is a diagnosis rather than a demo.
 */
import type { LineageEdge, LineageNode } from '@/store/canvas'

const node = (id: string, type = 'dataset', label = id): LineageNode => ({
  id, type: 'generic',
  position: { x: 0, y: 0 },
  data: { label, urn: id, type },
} as unknown as LineageNode)

const edge = (id: string, source: string, target: string, edgeType = 'DERIVES_FROM'): LineageEdge => ({
  id, source, target, data: { edgeType },
} as unknown as LineageEdge)

const contains = (id: string, source: string, target: string): LineageEdge =>
  edge(id, source, target, 'CONTAINS')

export interface Fixture {
  title: string
  focal: string
  nodes: LineageNode[]
  edges: LineageEdge[]
  isCoarser?: (t: string | undefined, base: string) => boolean
  canContain?: (t: string | undefined) => boolean
  over?: Record<string, unknown>
}

const COARSE = new Set(['CONTAINER', 'DATAPLATFORM', 'DATADOMAIN', 'dataset'])
const isCoarser = (t: string | undefined) => COARSE.has(t ?? '')
const canContain = (t: string | undefined) => t !== 'schemaField'

/**
 * The reported shape: a column focal, its own table upstream, EIGHT of
 * that table's columns also upstream, and the same connections restated
 * at container / platform / dataset grain. This is the picture that
 * rendered as one table card plus eight loose columns each captioned
 * `int_clean_order…`.
 */
const columns = (): Fixture => {
  const nodes = [
    node('F', 'schemaField', 'net_revenue'),
    node('T1', 'dataset', 'int_clean_orders_t1'),
    node('T2', 'dataset', 'int_clean_orders_t2'),
    node('CTR', 'CONTAINER', 'INTERMEDIATE_T1'),
    node('PLAT', 'DATAPLATFORM', 'Snowflake'),
    node('OUT', 'dataset', 'fact_orders'),
  ]
  const edges = [
    contains('k-plat', 'PLAT', 'CTR'),
    contains('k-ctr1', 'CTR', 'T1'),
    contains('k-ctr2', 'CTR', 'T2'),
    contains('k-f', 'T2', 'F'),
    // The focal's own table, and the coarser restatements of the same fact.
    edge('u-t1', 'T1', 'F'),
    edge('u-ctr', 'CTR', 'F'),
    edge('u-plat', 'PLAT', 'F'),
  ]
  const cols = ['subtotal', 'discount', 'tax_amt', 'shipping', 'gross_revenue', 'refund_amt', 'fx_rate', 'net_revenue']
  cols.forEach((c, i) => {
    nodes.push(node(`c${i}`, 'schemaField', c))
    edges.push(contains(`k-c${i}`, 'T1', `c${i}`))
    edges.push(edge(`u-c${i}`, `c${i}`, 'F'))
  })
  // Downstream: nine columns of one consumer table.
  nodes.push(node('OUT', 'dataset', 'fact_orders'))
  const outCols = ['order_id', 'net_revenue', 'net_revenue_usd', 'margin', 'margin_pct', 'is_refunded']
  outCols.forEach((c, i) => {
    nodes.push(node(`d${i}`, 'schemaField', c))
    edges.push(contains(`k-d${i}`, 'OUT', `d${i}`))
    edges.push(edge(`d-e${i}`, 'F', `d${i}`))
  })
  return { title: 'Column focal, table upstream, columns both sides', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** A six-level chain, to check the breadcrumb rather than nesting. */
const deep = (): Fixture => {
  const nodes = [
    node('DOM', 'DATADOMAIN', 'Sales'),
    node('PLAT', 'DATAPLATFORM', 'Snowflake'),
    node('APP', 'CONTAINER', 'OrderApp'),
    node('DB', 'CONTAINER', 'PROD'),
    node('T', 'dataset', 'fact_orders'),
    node('F', 'schemaField', 'net_revenue'),
    node('SRC', 'dataset', 'stg_orders_v2_final'),
  ]
  const edges = [
    contains('a', 'DOM', 'PLAT'), contains('b', 'PLAT', 'APP'),
    contains('c', 'APP', 'DB'), contains('d', 'DB', 'T'), contains('e', 'T', 'F'),
    edge('u', 'SRC', 'F'),
  ]
  const cols = ['revenue_raw', 'currency', 'rate']
  cols.forEach((c, i) => {
    nodes.push(node(`s${i}`, 'schemaField', c))
    edges.push(contains(`ks${i}`, 'SRC', `s${i}`))
    edges.push(edge(`us${i}`, `s${i}`, 'F'))
  })
  return { title: 'Six-level hierarchy', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** A wide table, to check the frame pages instead of growing. */
const wide = (): Fixture => {
  const nodes = [node('F', 'schemaField', 'net_revenue'), node('T', 'dataset', 'wide_source_table')]
  const edges: LineageEdge[] = []
  for (let i = 0; i < 40; i++) {
    nodes.push(node(`w${i}`, 'schemaField', `column_${String(i).padStart(2, '0')}_value`))
    edges.push(contains(`kw${i}`, 'T', `w${i}`))
    edges.push(edge(`ew${i}`, `w${i}`, 'F'))
  }
  return { title: '40-column upstream table', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** The tiny answer that used to float in an ocean of dots. */
const small = (): Fixture => ({
  title: 'Three cards',
  focal: 'F',
  nodes: [
    node('F', 'schemaField', 'product_id'),
    node('T', 'dataset', 'int_clean_products_t2'),
    node('U', 'schemaField', 'product_id'),
    node('UT', 'dataset', 'int_clean_products_t1'),
    node('D', 'schemaField', 'product_key'),
    node('DT', 'dataset', 'dim_product'),
    node('D2', 'schemaField', 'product_id'),
  ],
  edges: [
    contains('k1', 'T', 'F'), contains('k2', 'UT', 'U'),
    contains('k3', 'DT', 'D'), contains('k4', 'DT', 'D2'),
    edge('u', 'U', 'F'), edge('d1', 'F', 'D'), edge('d2', 'F', 'D2'),
  ],
  isCoarser,
  canContain,
})

export const FIXTURES: Record<string, Fixture> = {
  columns: columns(),
  deep: deep(),
  wide: wide(),
  small: small(),
}
