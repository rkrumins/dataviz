import type { LineageNode, LineageEdge } from '@/store/canvas'

/**
 * Demo data for NexusLineage
 * Represents a realistic data lineage scenario
 */

export const demoNodes: LineageNode[] = [
  // Domains (Level 1)
  {
    id: 'domain-finance',
    type: 'domain',
    position: { x: 0, y: 200 },
    data: {
      label: 'Finance Domain',
      businessLabel: 'Finance & Revenue',
      technicalLabel: 'finance_domain',
      urn: 'urn:li:domain:finance',
      type: 'domain',
      classifications: ['PII', 'Financial', 'SOX'],
      metadata: {
        owners: ['cfo@company.com', 'finance-team@company.com'],
        childCount: 4,
        description: 'All financial data and revenue reporting',
      },
    },
  },
  {
    id: 'domain-customer',
    type: 'domain',
    position: { x: 0, y: 500 },
    data: {
      label: 'Customer Domain',
      businessLabel: 'Customer 360',
      technicalLabel: 'customer_domain',
      urn: 'urn:li:domain:customer',
      type: 'domain',
      classifications: ['PII', 'GDPR'],
      metadata: {
        owners: ['customer-success@company.com'],
        childCount: 3,
      },
    },
  },

  // Applications (Level 2)
  {
    id: 'app-snowflake-finance',
    type: 'app',
    position: { x: 350, y: 100 },
    data: {
      label: 'Finance Warehouse',
      businessLabel: 'Finance Data Warehouse',
      technicalLabel: 'snowflake.finance_db',
      urn: 'urn:li:dataPlatform:snowflake.finance_db',
      type: 'app',
      lensId: 'finance-ontology',
      confidence: 0.95,
      metadata: {
        appType: 'database',
        assetCount: 47,
        lastUpdated: '2h ago',
      },
    },
  },
  {
    id: 'app-dbt-finance',
    type: 'app',
    position: { x: 350, y: 250 },
    data: {
      label: 'Finance dbt',
      businessLabel: 'Finance Transformations',
      technicalLabel: 'dbt.finance_transforms',
      urn: 'urn:li:dataPlatform:dbt.finance_transforms',
      type: 'app',
      confidence: 0.88,
      metadata: {
        appType: 'pipeline',
        assetCount: 23,
        lastUpdated: '1h ago',
      },
    },
  },
  {
    id: 'app-salesforce',
    type: 'app',
    position: { x: 350, y: 400 },
    data: {
      label: 'Salesforce',
      businessLabel: 'Salesforce CRM',
      technicalLabel: 'salesforce.production',
      urn: 'urn:li:dataPlatform:salesforce.prod',
      type: 'app',
      confidence: 0.92,
      metadata: {
        appType: 'service',
        assetCount: 156,
        lastUpdated: '5m ago',
      },
    },
  },
  {
    id: 'app-segment',
    type: 'app',
    position: { x: 350, y: 550 },
    data: {
      label: 'Segment',
      businessLabel: 'Customer Data Platform',
      technicalLabel: 'segment.workspace',
      urn: 'urn:li:dataPlatform:segment',
      type: 'app',
      confidence: 0.85,
      metadata: {
        appType: 'service',
        assetCount: 89,
        lastUpdated: '10m ago',
      },
    },
  },

  // Assets (Level 3)
  {
    id: 'asset-revenue-table',
    type: 'asset',
    position: { x: 700, y: 50 },
    data: {
      label: 'revenue_monthly',
      businessLabel: 'Monthly Revenue',
      technicalLabel: 'finance_db.analytics.revenue_monthly',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,finance_db.analytics.revenue_monthly,PROD)',
      type: 'asset',
      classifications: ['Financial', 'SOX'],
      confidence: 0.98,
      metadata: {
        assetType: 'table',
        schema: 'analytics',
        rowCount: '2.4M',
      },
    },
  },
  {
    id: 'asset-orders-table',
    type: 'asset',
    position: { x: 700, y: 150 },
    data: {
      label: 'orders',
      businessLabel: 'Order Transactions',
      technicalLabel: 'finance_db.raw.orders',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,finance_db.raw.orders,PROD)',
      type: 'asset',
      classifications: ['PII', 'Financial'],
      confidence: 0.94,
      metadata: {
        assetType: 'table',
        schema: 'raw',
        rowCount: '15.7M',
      },
    },
  },
  {
    id: 'asset-customers-table',
    type: 'asset',
    position: { x: 700, y: 350 },
    data: {
      label: 'customers',
      businessLabel: 'Customer Master',
      technicalLabel: 'customer_db.core.customers',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,customer_db.core.customers,PROD)',
      type: 'asset',
      classifications: ['PII', 'GDPR'],
      confidence: 0.91,
      metadata: {
        assetType: 'table',
        schema: 'core',
        rowCount: '890K',
      },
    },
  },
  {
    id: 'asset-events-table',
    type: 'asset',
    position: { x: 700, y: 500 },
    data: {
      label: 'user_events',
      businessLabel: 'User Events',
      technicalLabel: 'segment.events.user_events',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:segment,events.user_events,PROD)',
      type: 'asset',
      confidence: 0.72,
      metadata: {
        assetType: 'table',
        schema: 'events',
        rowCount: '1.2B',
      },
    },
  },

  // Downstream - Dashboards & Reports
  {
    id: 'asset-revenue-dashboard',
    type: 'asset',
    position: { x: 1050, y: 100 },
    data: {
      label: 'Revenue Dashboard',
      businessLabel: 'Executive Revenue Dashboard',
      technicalLabel: 'looker.dashboards.revenue_exec',
      urn: 'urn:li:dashboard:(urn:li:dataPlatform:looker,revenue_exec)',
      type: 'asset',
      confidence: 0.89,
      metadata: {
        assetType: 'dashboard',
        viewers: 45,
        lastViewed: '1h ago',
      },
    },
  },
  {
    id: 'asset-customer-360',
    type: 'asset',
    position: { x: 1050, y: 400 },
    data: {
      label: 'Customer 360 View',
      businessLabel: 'Customer 360 Dashboard',
      technicalLabel: 'looker.dashboards.customer_360',
      urn: 'urn:li:dashboard:(urn:li:dataPlatform:looker,customer_360)',
      type: 'asset',
      confidence: 0.86,
      metadata: {
        assetType: 'dashboard',
        viewers: 120,
        lastViewed: '15m ago',
      },
    },
  },

  // Ghost nodes (pagination indicators)
  {
    id: 'ghost-upstream',
    type: 'ghost',
    position: { x: -200, y: 350 },
    data: {
      label: 'More Sources',
      urn: '',
      type: 'ghost',
      metadata: {
        nodeCount: 12,
        direction: 'upstream',
        isLoading: false,
      },
    },
  },
  {
    id: 'ghost-downstream',
    type: 'ghost',
    position: { x: 1300, y: 250 },
    data: {
      label: 'More Consumers',
      urn: '',
      type: 'ghost',
      metadata: {
        nodeCount: 8,
        direction: 'downstream',
        isLoading: false,
      },
    },
  },
]

export const demoEdges: LineageEdge[] = [
  // Domain to App connections
  {
    id: 'edge-finance-snowflake',
    source: 'domain-finance',
    target: 'app-snowflake-finance',
    type: 'lineage',
    data: { confidence: 0.95, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-finance-dbt',
    source: 'domain-finance',
    target: 'app-dbt-finance',
    type: 'lineage',
    data: { confidence: 0.88, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-customer-salesforce',
    source: 'domain-customer',
    target: 'app-salesforce',
    type: 'lineage',
    data: { confidence: 0.92, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-customer-segment',
    source: 'domain-customer',
    target: 'app-segment',
    type: 'lineage',
    data: { confidence: 0.85, edgeType: 'produces', animated: true },
  },

  // App to Asset connections
  {
    id: 'edge-snowflake-revenue',
    source: 'app-snowflake-finance',
    target: 'asset-revenue-table',
    type: 'lineage',
    data: { confidence: 0.98, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-snowflake-orders',
    source: 'app-snowflake-finance',
    target: 'asset-orders-table',
    type: 'lineage',
    data: { confidence: 0.94, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-dbt-revenue',
    source: 'app-dbt-finance',
    target: 'asset-revenue-table',
    type: 'lineage',
    data: { confidence: 0.88, edgeType: 'transforms', animated: true },
  },
  {
    id: 'edge-salesforce-customers',
    source: 'app-salesforce',
    target: 'asset-customers-table',
    type: 'lineage',
    data: { confidence: 0.91, edgeType: 'produces', animated: true },
  },
  {
    id: 'edge-segment-events',
    source: 'app-segment',
    target: 'asset-events-table',
    type: 'lineage',
    data: { confidence: 0.72, edgeType: 'produces', animated: true },
  },

  // Asset to Dashboard connections
  {
    id: 'edge-revenue-dashboard',
    source: 'asset-revenue-table',
    target: 'asset-revenue-dashboard',
    type: 'lineage',
    data: { confidence: 0.89, edgeType: 'consumes', animated: true },
  },
  {
    id: 'edge-orders-dashboard',
    source: 'asset-orders-table',
    target: 'asset-revenue-dashboard',
    type: 'lineage',
    data: { confidence: 0.85, edgeType: 'consumes', animated: true },
  },
  {
    id: 'edge-customers-360',
    source: 'asset-customers-table',
    target: 'asset-customer-360',
    type: 'lineage',
    data: { confidence: 0.86, edgeType: 'consumes', animated: true },
  },
  {
    id: 'edge-events-360',
    source: 'asset-events-table',
    target: 'asset-customer-360',
    type: 'lineage',
    data: { confidence: 0.78, edgeType: 'consumes', animated: true },
  },

  // Cross-domain relationships
  {
    id: 'edge-customers-orders',
    source: 'asset-customers-table',
    target: 'asset-orders-table',
    type: 'lineage',
    data: { confidence: 0.93, edgeType: 'transforms', label: 'customer_id join' },
  },

  // Ghost connections
  {
    id: 'edge-ghost-upstream',
    source: 'ghost-upstream',
    target: 'domain-finance',
    type: 'lineage',
    data: { confidence: 0.5, edgeType: 'produces', animated: false },
  },
  {
    id: 'edge-ghost-downstream',
    source: 'asset-revenue-dashboard',
    target: 'ghost-downstream',
    type: 'lineage',
    data: { confidence: 0.5, edgeType: 'consumes', animated: false },
  },
]

/**
 * Initialize demo data in the canvas store
 */
export function initializeDemoData(
  setNodes: (nodes: LineageNode[]) => void,
  setEdges: (edges: LineageEdge[]) => void,
  setActiveLens: (lensId: string | null) => void
) {
  setNodes(demoNodes)
  setEdges(demoEdges)
  setActiveLens('finance-ontology')
}

