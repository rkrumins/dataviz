import type { LineageNode, LineageEdge } from '@/store/canvas'

/**
 * Configuration for demo data generation
 */
export interface DemoDataConfig {
  domainCount?: number
  appsPerDomain?: number
  assetsPerApp?: { min: number; max: number }
  columnsPerAsset?: { min: number; max: number }
  includeDashboards?: boolean
  includeGhostNodes?: boolean
}

const DEFAULT_CONFIG: Required<DemoDataConfig> = {
  domainCount: 1,
  appsPerDomain: 3,
  assetsPerApp: { min: 1, max: 2 },
  columnsPerAsset: { min: 5, max: 10 },
  includeDashboards: true,
  includeGhostNodes: true,
}

/**
 * Utility functions for generating realistic data
 */
const domainNames = [
  'Finance', 'Customer', 'Product', 'Operations', 'Marketing',
  'Sales', 'HR', 'Engineering', 'Analytics', 'Security'
]

const appTypes = [
  { type: 'database', platforms: ['snowflake', 'postgres', 'mysql', 'mongodb', 'redshift'] },
  { type: 'pipeline', platforms: ['dbt', 'airflow', 'spark', 'kafka', 'fivetran'] },
  { type: 'service', platforms: ['salesforce', 'segment', 'hubspot', 'stripe', 'twilio'] },
  { type: 'warehouse', platforms: ['snowflake', 'bigquery', 'databricks', 'redshift'] },
  { type: 'lake', platforms: ['s3', 'gcs', 'azure', 'databricks'] },
]

const assetTypes = ['table', 'view', 'stream', 'topic', 'bucket', 'collection']
const columnTypes = ['BIGINT', 'VARCHAR', 'DECIMAL', 'TIMESTAMP', 'DATE', 'BOOLEAN', 'INTEGER', 'TEXT', 'JSON']

const businessTerms = [
  'Revenue', 'Customer', 'Order', 'Product', 'Transaction', 'Event', 'User',
  'Account', 'Payment', 'Invoice', 'Subscription', 'Campaign', 'Lead', 'Contact'
]

const technicalTerms = [
  'raw', 'staging', 'analytics', 'core', 'mart', 'warehouse', 'lake',
  'events', 'logs', 'metrics', 'dim', 'fact', 'lookup', 'temp'
]

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function generateUrn(type: string, parts: string[]): string {
  const prefix = type === 'domain' ? 'urn:li:domain' :
    type === 'app' ? 'urn:li:dataPlatform' :
      type === 'asset' ? 'urn:li:dataset' :
        'urn:li:column'
  return `${prefix}:${parts.join('.')}`
}


/**
 * Generate demo data programmatically
 * 
 * Creates a hierarchical data lineage graph with:
 * - Domains (top level)
 * - Applications (within domains)
 * - Assets (within applications)
 * - Columns (within assets)
 * - Dashboards (downstream consumers)
 * - Ghost nodes (pagination indicators)
 * 
 * With default config (5 domains, 10 apps, 5-15 assets, 10-100 columns):
 * - ~5 domains
 * - ~50 applications
 * - ~250-750 assets
 * - ~2,500-75,000 columns
 * - Total: ~2,800-76,000+ nodes
 * 
 * All relationships (containment and lineage) are automatically generated.
 */
export function generateDemoData(config: DemoDataConfig = {}): {
  nodes: LineageNode[]
  edges: LineageEdge[]
} {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []

  let xPosition = 0
  const domainYPositions: number[] = []

  // Generate domains
  for (let d = 0; d < cfg.domainCount; d++) {
    const domainName = domainNames[d % domainNames.length]
    const domainId = `domain-${domainName.toLowerCase()}`
    const domainY = d * 400 + 200
    domainYPositions.push(domainY)

    const domainNode: LineageNode = {
      id: domainId,
      type: 'domain',
      position: { x: xPosition, y: domainY },
      data: {
        label: `${domainName} Domain`,
        businessLabel: `${domainName} & Business Unit`,
        technicalLabel: `${domainName.toLowerCase()}_domain`,
        urn: generateUrn('domain', [domainName.toLowerCase()]),
        type: 'domain',
        lensId: d === 0 ? `${domainName.toLowerCase()}-ontology` : undefined,
        classifications: randomChoice([['PII'], ['Financial'], ['GDPR'], ['SOX'], []]),
        metadata: {
          owners: [`${domainName.toLowerCase()}-team@company.com`],
          childCount: cfg.appsPerDomain,
          description: `All ${domainName.toLowerCase()} data and business processes`,
        },
      },
    }
    nodes.push(domainNode)

    // Generate applications for this domain (Mapped to 'system' in schema)
    const appX = xPosition + 350
    const appsPerRow = Math.ceil(Math.sqrt(cfg.appsPerDomain))
    let appIndex = 0

    for (let a = 0; a < cfg.appsPerDomain; a++) {
      const appType = randomChoice(appTypes)
      const platform = randomChoice(appType.platforms)
      const appId = `app-${domainName.toLowerCase()}-${platform}-${a}`
      const appY = domainY + (appIndex % appsPerRow) * 150 - 100

      const appNode: LineageNode = {
        id: appId,
        type: 'system',
        position: { x: appX, y: appY },
        data: {
          label: `${platform} ${domainName}`,
          businessLabel: `${platform} ${domainName} System`,
          technicalLabel: `${platform}.${domainName.toLowerCase()}_${a}`,
          urn: generateUrn('app', [platform, `${domainName.toLowerCase()}_${a}`]),
          type: 'system', // SCHEMA TYPE: system
          confidence: randomFloat(0.75, 0.98),
          metadata: {
            appType: appType.type,
            assetCount: randomInt(cfg.assetsPerApp.min, cfg.assetsPerApp.max),
            lastUpdated: `${randomInt(1, 60)}m ago`,
          },
        },
      }
      nodes.push(appNode)

      // Containment edge: domain → system
      edges.push({
        id: `contains-${domainId}-${appId}`,
        source: domainId,
        target: appId,
        type: 'lineage',
        data: { relationship: 'contains', edgeType: 'contains', animated: false },
      })

      // Lineage edge: domain → system (data flow)
      edges.push({
        id: `edge-${domainId}-${appId}`,
        source: domainId,
        target: appId,
        type: 'lineage',
        data: {
          confidence: randomFloat(0.8, 0.95),
          edgeType: 'produces',
          animated: true,
        },
      })

      // Generate assets for this application (Mapped to 'dataset' in schema)
      const assetCount = randomInt(cfg.assetsPerApp.min, cfg.assetsPerApp.max)
      const assetX = appX + 350
      let assetY = appY - 50

      for (let ast = 0; ast < assetCount; ast++) {
        const assetType = randomChoice(assetTypes)
        const businessTerm = randomChoice(businessTerms)
        const technicalTerm = randomChoice(technicalTerms)
        const assetName = `${technicalTerm}_${businessTerm.toLowerCase()}_${ast}`
        const assetId = `asset-${appId}-${ast}`

        const assetNode: LineageNode = {
          id: assetId,
          type: 'dataset',
          position: { x: assetX, y: assetY },
          data: {
            label: assetName,
            businessLabel: `${businessTerm} ${assetType === 'table' ? 'Table' : assetType}`,
            technicalLabel: `${platform}.${domainName.toLowerCase()}.${assetName}`,
            urn: generateUrn('asset', [platform, `${domainName.toLowerCase()}.${assetName}`, 'PROD']),
            type: 'dataset', // SCHEMA TYPE: dataset
            classifications: randomChoice([
              ['PII'], ['Financial'], ['GDPR'], ['SOX'], ['Sensitive'], []
            ]),
            confidence: randomFloat(0.7, 0.98),
            metadata: {
              assetType,
              schema: technicalTerm,
              rowCount: `${(randomFloat(0.1, 100)).toFixed(1)}${randomChoice(['K', 'M', 'B'])}`,
            },
          },
        }
        nodes.push(assetNode)

        // Containment edge: app → asset
        edges.push({
          id: `contains-${appId}-${assetId}`,
          source: appId,
          target: assetId,
          type: 'lineage',
          data: { relationship: 'contains', edgeType: 'contains', animated: false },
        })

        // Lineage edge: app → asset
        edges.push({
          id: `edge-${appId}-${assetId}`,
          source: appId,
          target: assetId,
          type: 'lineage',
          data: {
            confidence: randomFloat(0.75, 0.98),
            edgeType: 'produces',
            animated: true,
          },
        })

        // Generate columns for this asset
        const columnCount = randomInt(cfg.columnsPerAsset.min, cfg.columnsPerAsset.max)
        const columnX = assetX + 200
        let columnY = assetY - 20

        for (let col = 0; col < columnCount; col++) {
          const columnName = col === 0 ? 'id' :
            col === 1 ? `${businessTerm.toLowerCase()}_id` :
              col === 2 ? 'created_at' :
                col === 3 ? 'updated_at' :
                  `${randomChoice(businessTerms).toLowerCase()}_${col}`
          const columnId = `col-${assetId}-${col}`
          const dataType = randomChoice(columnTypes)

          const columnNode: LineageNode = {
            id: columnId,
            type: 'asset',
            position: { x: columnX, y: columnY },
            data: {
              label: columnName,
              businessLabel: columnName.split('_').map(w =>
                w.charAt(0).toUpperCase() + w.slice(1)
              ).join(' '),
              technicalLabel: `${assetName}.${columnName}`,
              urn: generateUrn('column', [assetName, columnName]),
              type: 'column',
              classifications: col < 2 ? ['PK'] :
                columnName.includes('id') ? ['FK'] :
                  randomChoice([['PII'], ['GDPR'], ['Financial'], []]),
              metadata: {
                dataType: dataType + (dataType.includes('VARCHAR') ? `(${randomInt(50, 500)})` : ''),
                nullable: col > 1 && Math.random() > 0.7,
              },
            },
          }
          nodes.push(columnNode)

          // Containment edge: asset → column
          edges.push({
            id: `contains-${assetId}-${columnId}`,
            source: assetId,
            target: columnId,
            type: 'lineage',
            data: { relationship: 'contains', edgeType: 'contains', animated: false },
          })

          columnY += 30
        }

        // Add some cross-asset lineage relationships (20% chance)
        if (ast > 0 && Math.random() < 0.2) {
          const prevAssetId = `asset-${appId}-${ast - 1}`
          edges.push({
            id: `edge-${prevAssetId}-${assetId}`,
            source: prevAssetId,
            target: assetId,
            type: 'lineage',
            data: {
              confidence: randomFloat(0.7, 0.9),
              edgeType: 'transforms',
              animated: true,
            },
          })
        }

        assetY += 100
      }

      appIndex++
    }

    xPosition += 50 // Slight offset for next domain's apps
  }

  // Add dashboards (downstream consumers)
  if (cfg.includeDashboards) {
    const dashboardX = xPosition + 500
    const dashboardPlatforms = ['looker', 'tableau', 'powerbi', 'metabase']

    for (let d = 0; d < cfg.domainCount; d++) {
      const domainName = domainNames[d % domainNames.length]
      const dashboardCount = randomInt(2, 5)

      for (let dash = 0; dash < dashboardCount; dash++) {
        const platform = randomChoice(dashboardPlatforms)
        const dashboardId = `asset-${domainName.toLowerCase()}-dashboard-${dash}`
        const dashboardY = domainYPositions[d] + (dash - 1) * 150

        const dashboardNode: LineageNode = {
          id: dashboardId,
          type: 'asset',
          position: { x: dashboardX, y: dashboardY },
          data: {
            label: `${domainName} Dashboard ${dash + 1}`,
            businessLabel: `${domainName} Executive Dashboard`,
            technicalLabel: `${platform}.dashboards.${domainName.toLowerCase()}_${dash}`,
            urn: `urn:li:dashboard:(urn:li:dataPlatform:${platform},${domainName.toLowerCase()}_${dash})`,
            type: 'asset',
            confidence: randomFloat(0.8, 0.95),
            metadata: {
              assetType: 'dashboard',
              viewers: randomInt(10, 200),
              lastViewed: `${randomInt(1, 120)}m ago`,
            },
          },
        }
        nodes.push(dashboardNode)

        // Connect to some assets in this domain (non-dashboard assets)
        const domainApps = nodes.filter(n =>
          n.id.startsWith(`app-${domainName.toLowerCase()}-`) && (n.data.type === 'system' || n.data.type === 'app')
        )
        const domainAssets = nodes.filter(n =>
          domainApps.some(app => n.id.startsWith(`asset-${app.id}-`)) &&
          (n.data.type === 'dataset' || n.data.type === 'asset') &&
          n.data.metadata?.assetType !== 'dashboard'
        )

        // Connect to 1-3 random assets
        if (domainAssets.length > 0) {
          const connectedAssets = domainAssets
            .sort(() => Math.random() - 0.5)
            .slice(0, Math.min(randomInt(1, 3), domainAssets.length))

          connectedAssets.forEach(asset => {
            edges.push({
              id: `edge-${asset.id}-${dashboardId}`,
              source: asset.id,
              target: dashboardId,
              type: 'lineage',
              data: {
                confidence: randomFloat(0.75, 0.9),
                edgeType: 'consumes',
                animated: true,
              },
            })
          })
        }
      }
    }
  }

  // Add ghost nodes
  if (cfg.includeGhostNodes) {
    const firstDomainY = domainYPositions[0]
    const lastDomainY = domainYPositions[domainYPositions.length - 1]
    const midY = (firstDomainY + lastDomainY) / 2

    const ghostUpstream: LineageNode = {
      id: 'ghost-upstream',
      type: 'ghost',
      position: { x: -200, y: midY },
      data: {
        label: 'More Sources',
        urn: '',
        type: 'ghost',
        metadata: {
          nodeCount: randomInt(10, 50),
          direction: 'upstream',
          isLoading: false,
        },
      },
    }
    nodes.push(ghostUpstream)

    const ghostDownstream: LineageNode = {
      id: 'ghost-downstream',
      type: 'ghost',
      position: { x: xPosition + 800, y: midY },
      data: {
        label: 'More Consumers',
        urn: '',
        type: 'ghost',
        metadata: {
          nodeCount: randomInt(5, 30),
          direction: 'downstream',
          isLoading: false,
        },
      },
    }
    nodes.push(ghostDownstream)

    // Connect ghost nodes
    const firstDomain = nodes.find(n => n.type === 'domain')
    const lastDashboard = nodes.filter(n => n.data.metadata?.assetType === 'dashboard').pop()

    if (firstDomain) {
      edges.push({
        id: 'edge-ghost-upstream',
        source: 'ghost-upstream',
        target: firstDomain.id,
        type: 'lineage',
        data: { confidence: 0.5, edgeType: 'produces', animated: false },
      })
    }

    if (lastDashboard) {
      edges.push({
        id: 'edge-ghost-downstream',
        source: lastDashboard.id,
        target: 'ghost-downstream',
        type: 'lineage',
        data: { confidence: 0.5, edgeType: 'consumes', animated: false },
      })
    }
  }

  return { nodes, edges }
}

/**
 * Legacy demo data (kept for backward compatibility)
 * Use generateDemoData() for new code
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
    type: 'system',
    position: { x: 350, y: 100 },
    data: {
      label: 'Finance Warehouse',
      businessLabel: 'Finance Data Warehouse',
      technicalLabel: 'snowflake.finance_db',
      urn: 'urn:li:dataPlatform:snowflake.finance_db',
      type: 'system',
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
    type: 'system',
    position: { x: 350, y: 250 },
    data: {
      label: 'Finance dbt',
      businessLabel: 'Finance Transformations',
      technicalLabel: 'dbt.finance_transforms',
      urn: 'urn:li:dataPlatform:dbt.finance_transforms',
      type: 'system',
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
    type: 'system',
    position: { x: 350, y: 400 },
    data: {
      label: 'Salesforce',
      businessLabel: 'Salesforce CRM',
      technicalLabel: 'salesforce.production',
      urn: 'urn:li:dataPlatform:salesforce.prod',
      type: 'system',
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
    type: 'system',
    position: { x: 350, y: 550 },
    data: {
      label: 'Segment',
      businessLabel: 'Customer Data Platform',
      technicalLabel: 'segment.workspace',
      urn: 'urn:li:dataPlatform:segment',
      type: 'system',
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
    type: 'dataset',
    position: { x: 700, y: 50 },
    data: {
      label: 'revenue_monthly',
      businessLabel: 'Monthly Revenue',
      technicalLabel: 'finance_db.analytics.revenue_monthly',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,finance_db.analytics.revenue_monthly,PROD)',
      type: 'dataset',
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
    type: 'dataset',
    position: { x: 700, y: 150 },
    data: {
      label: 'orders',
      businessLabel: 'Order Transactions',
      technicalLabel: 'finance_db.raw.orders',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,finance_db.raw.orders,PROD)',
      type: 'dataset',
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
    type: 'dataset',
    position: { x: 700, y: 350 },
    data: {
      label: 'customers',
      businessLabel: 'Customer Master',
      technicalLabel: 'customer_db.core.customers',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,customer_db.core.customers,PROD)',
      type: 'dataset',
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
    type: 'dataset',
    position: { x: 700, y: 500 },
    data: {
      label: 'user_events',
      businessLabel: 'User Events',
      technicalLabel: 'segment.events.user_events',
      urn: 'urn:li:dataset:(urn:li:dataPlatform:segment,events.user_events,PROD)',
      type: 'dataset',
      confidence: 0.72,
      metadata: {
        assetType: 'table',
        schema: 'events',
        rowCount: '1.2B',
      },
    },
  },

  // ============================================
  // Columns (Level 4) - for hierarchy roll-up demo
  // ============================================

  // Revenue table columns
  {
    id: 'col-revenue-month',
    type: 'asset',
    position: { x: 900, y: 30 },
    data: {
      label: 'month',
      businessLabel: 'Month',
      technicalLabel: 'revenue_monthly.month',
      urn: 'urn:li:column:revenue_monthly.month',
      type: 'column',
      metadata: { dataType: 'DATE', nullable: false },
    },
  },
  {
    id: 'col-revenue-amount',
    type: 'asset',
    position: { x: 900, y: 60 },
    data: {
      label: 'revenue_amount',
      businessLabel: 'Revenue Amount',
      technicalLabel: 'revenue_monthly.revenue_amount',
      urn: 'urn:li:column:revenue_monthly.revenue_amount',
      type: 'column',
      classifications: ['Financial'],
      metadata: { dataType: 'DECIMAL(18,2)', nullable: false },
    },
  },
  {
    id: 'col-revenue-currency',
    type: 'asset',
    position: { x: 900, y: 90 },
    data: {
      label: 'currency',
      businessLabel: 'Currency Code',
      technicalLabel: 'revenue_monthly.currency',
      urn: 'urn:li:column:revenue_monthly.currency',
      type: 'column',
      metadata: { dataType: 'VARCHAR(3)', nullable: false },
    },
  },

  // Orders table columns
  {
    id: 'col-orders-id',
    type: 'asset',
    position: { x: 900, y: 130 },
    data: {
      label: 'order_id',
      businessLabel: 'Order ID',
      technicalLabel: 'orders.order_id',
      urn: 'urn:li:column:orders.order_id',
      type: 'column',
      classifications: ['PK'],
      metadata: { dataType: 'BIGINT', nullable: false },
    },
  },
  {
    id: 'col-orders-customer',
    type: 'asset',
    position: { x: 900, y: 160 },
    data: {
      label: 'customer_id',
      businessLabel: 'Customer ID',
      technicalLabel: 'orders.customer_id',
      urn: 'urn:li:column:orders.customer_id',
      type: 'column',
      classifications: ['FK', 'PII'],
      metadata: { dataType: 'BIGINT', nullable: false },
    },
  },
  {
    id: 'col-orders-total',
    type: 'asset',
    position: { x: 900, y: 190 },
    data: {
      label: 'order_total',
      businessLabel: 'Order Total',
      technicalLabel: 'orders.order_total',
      urn: 'urn:li:column:orders.order_total',
      type: 'column',
      classifications: ['Financial'],
      metadata: { dataType: 'DECIMAL(18,2)', nullable: false },
    },
  },
  {
    id: 'col-orders-date',
    type: 'asset',
    position: { x: 900, y: 220 },
    data: {
      label: 'order_date',
      businessLabel: 'Order Date',
      technicalLabel: 'orders.order_date',
      urn: 'urn:li:column:orders.order_date',
      type: 'column',
      metadata: { dataType: 'TIMESTAMP', nullable: false },
    },
  },

  // Customers table columns
  {
    id: 'col-customers-id',
    type: 'asset',
    position: { x: 900, y: 330 },
    data: {
      label: 'customer_id',
      businessLabel: 'Customer ID',
      technicalLabel: 'customers.customer_id',
      urn: 'urn:li:column:customers.customer_id',
      type: 'column',
      classifications: ['PK', 'PII'],
      metadata: { dataType: 'BIGINT', nullable: false },
    },
  },
  {
    id: 'col-customers-email',
    type: 'asset',
    position: { x: 900, y: 360 },
    data: {
      label: 'email',
      businessLabel: 'Email Address',
      technicalLabel: 'customers.email',
      urn: 'urn:li:column:customers.email',
      type: 'column',
      classifications: ['PII', 'GDPR'],
      metadata: { dataType: 'VARCHAR(255)', nullable: false },
    },
  },
  {
    id: 'col-customers-name',
    type: 'asset',
    position: { x: 900, y: 390 },
    data: {
      label: 'full_name',
      businessLabel: 'Full Name',
      technicalLabel: 'customers.full_name',
      urn: 'urn:li:column:customers.full_name',
      type: 'column',
      classifications: ['PII', 'GDPR'],
      metadata: { dataType: 'VARCHAR(200)', nullable: true },
    },
  },
  {
    id: 'col-customers-created',
    type: 'asset',
    position: { x: 900, y: 420 },
    data: {
      label: 'created_at',
      businessLabel: 'Created At',
      technicalLabel: 'customers.created_at',
      urn: 'urn:li:column:customers.created_at',
      type: 'column',
      metadata: { dataType: 'TIMESTAMP', nullable: false },
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
  // ============================================
  // CONTAINMENT EDGES (for hierarchy view)
  // Domain → System containment
  // ============================================
  {
    id: 'contains-finance-snowflake',
    source: 'domain-finance',
    target: 'app-snowflake-finance',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-finance-dbt',
    source: 'domain-finance',
    target: 'app-dbt-finance',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-customer-salesforce',
    source: 'domain-customer',
    target: 'app-salesforce',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-customer-segment',
    source: 'domain-customer',
    target: 'app-segment',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },

  // System → Dataset containment
  {
    id: 'contains-snowflake-revenue',
    source: 'app-snowflake-finance',
    target: 'asset-revenue-table',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-snowflake-orders',
    source: 'app-snowflake-finance',
    target: 'asset-orders-table',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-salesforce-customers',
    source: 'app-salesforce',
    target: 'asset-customers-table',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-segment-events',
    source: 'app-segment',
    target: 'asset-events-table',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },

  // Dataset → Column containment (for hierarchy roll-up)
  // Revenue table columns
  {
    id: 'contains-revenue-month',
    source: 'asset-revenue-table',
    target: 'col-revenue-month',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-revenue-amount',
    source: 'asset-revenue-table',
    target: 'col-revenue-amount',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-revenue-currency',
    source: 'asset-revenue-table',
    target: 'col-revenue-currency',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },

  // Orders table columns
  {
    id: 'contains-orders-id',
    source: 'asset-orders-table',
    target: 'col-orders-id',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-orders-customer',
    source: 'asset-orders-table',
    target: 'col-orders-customer',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-orders-total',
    source: 'asset-orders-table',
    target: 'col-orders-total',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-orders-date',
    source: 'asset-orders-table',
    target: 'col-orders-date',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },

  // Customers table columns
  {
    id: 'contains-customers-id',
    source: 'asset-customers-table',
    target: 'col-customers-id',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-customers-email',
    source: 'asset-customers-table',
    target: 'col-customers-email',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-customers-name',
    source: 'asset-customers-table',
    target: 'col-customers-name',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },
  {
    id: 'contains-customers-created',
    source: 'asset-customers-table',
    target: 'col-customers-created',
    type: 'lineage',
    data: { relationship: 'contains', edgeType: 'contains', animated: false },
  },

  // ============================================
  // LINEAGE EDGES (data flow)
  // ============================================

  // Domain to App connections (data flow)
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

  // Cross-domain relationships (table level)
  {
    id: 'edge-customers-orders',
    source: 'asset-customers-table',
    target: 'asset-orders-table',
    type: 'lineage',
    data: { confidence: 0.93, edgeType: 'transforms', label: 'customer_id join' },
  },

  // ============================================
  // COLUMN-LEVEL LINEAGE (data transformations)
  // ============================================

  // Orders table columns derive from Customers columns (FK relationship data flow)
  {
    id: 'col-edge-customer-to-orders',
    source: 'col-customers-id',
    target: 'col-orders-customer',
    type: 'lineage',
    data: { confidence: 0.98, edgeType: 'derives_from', animated: true, label: 'FK reference' },
  },

  // Revenue columns aggregate from Orders columns
  {
    id: 'col-edge-orders-total-revenue',
    source: 'col-orders-total',
    target: 'col-revenue-amount',
    type: 'lineage',
    data: { confidence: 0.95, edgeType: 'transforms', animated: true, label: 'SUM aggregation' },
  },
  {
    id: 'col-edge-orders-date-revenue-month',
    source: 'col-orders-date',
    target: 'col-revenue-month',
    type: 'lineage',
    data: { confidence: 0.92, edgeType: 'transforms', animated: true, label: 'DATE_TRUNC(month)' },
  },

  // Email used for customer matching
  {
    id: 'col-edge-email-lookup',
    source: 'col-customers-email',
    target: 'col-orders-customer',
    type: 'lineage',
    data: { confidence: 0.75, edgeType: 'transforms', animated: true, label: 'email lookup' },
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
 * @param useGenerator - If true, uses generateDemoData() instead of static demo data
 * @param config - Optional configuration for data generation
 */
export function initializeDemoData(
  setNodes: (nodes: LineageNode[]) => void,
  setEdges: (edges: LineageEdge[]) => void,
  setActiveLens: (lensId: string | null) => void,
  useGenerator: boolean = false,
  config?: DemoDataConfig
) {
  if (useGenerator) {
    const { nodes, edges } = generateDemoData(config)
    setNodes(nodes)
    setEdges(edges)
    // Set active lens to first domain's ontology if available
    const firstDomain = nodes.find(n => n.type === 'domain')
    if (firstDomain?.data.lensId) {
      setActiveLens(firstDomain.data.lensId)
    } else {
      setActiveLens(null)
    }
  } else {
    // Use legacy static demo data
    setNodes(demoNodes)
    setEdges(demoEdges)
    setActiveLens('finance-ontology')
  }
}

