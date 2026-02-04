import random
from typing import List, Dict, Any, Tuple
from ..models.graph import GraphNode, GraphEdge, EntityType, EdgeType

# Configuration
DEFAULT_CONFIG = {
    "domainCount": 10, # Reduced for slightly smaller default mock
    "appsPerDomain": 5,
    "assetsPerApp": {"min": 2, "max": 10},
    "columnsPerAsset": {"min": 3, "max": 10},
    "includeDashboards": True,
    "includeGhostNodes": True
}

DOMAIN_NAMES = [
    'Finance', 'Customer', 'Product', 'Operations', 'Marketing',
    'Sales', 'HR', 'Engineering', 'Analytics', 'Security'
]

APP_TYPES = [
    { "type": 'database', "platforms": ['snowflake', 'postgres', 'mysql', 'mongodb', 'redshift'] },
    { "type": 'pipeline', "platforms": ['dbt', 'airflow', 'spark', 'kafka', 'fivetran'] },
    { "type": 'service', "platforms": ['salesforce', 'segment', 'hubspot', 'stripe', 'twilio'] },
    { "type": 'warehouse', "platforms": ['snowflake', 'bigquery', 'databricks', 'redshift'] },
    { "type": 'lake', "platforms": ['s3', 'gcs', 'azure', 'databricks'] },
]

ASSET_TYPES = ['table', 'view', 'stream', 'topic', 'bucket', 'collection']
COLUMN_TYPES = ['BIGINT', 'VARCHAR', 'DECIMAL', 'TIMESTAMP', 'DATE', 'BOOLEAN', 'INTEGER', 'TEXT', 'JSON']

BUSINESS_TERMS = [
    'Revenue', 'Customer', 'Order', 'Product', 'Transaction', 'Event', 'User',
    'Account', 'Payment', 'Invoice', 'Subscription', 'Campaign', 'Lead', 'Contact'
]

TECHNICAL_TERMS = [
    'raw', 'staging', 'analytics', 'core', 'mart', 'warehouse', 'lake',
    'events', 'logs', 'metrics', 'dim', 'fact', 'lookup', 'temp'
]

def generate_urn(type_: str, parts: List[str]) -> str:
    prefix = ""
    if type_ == 'domain': prefix = 'urn:li:domain'
    elif type_ == 'app': prefix = 'urn:li:dataPlatform'
    elif type_ == 'asset': prefix = 'urn:li:dataset'
    elif type_ == 'column': prefix = 'urn:li:column'
    elif type_ == 'dashboard': prefix = 'urn:li:dashboard'
    else: prefix = f'urn:li:{type_}'
    
    return f"{prefix}:{'.'.join(parts)}"

def generate_demo_data(config: Dict[str, Any] = None) -> Tuple[List[GraphNode], List[GraphEdge]]:
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    nodes: List[GraphNode] = []
    edges: List[GraphEdge] = []
    
    # Simple deterministic seed for consistency if needed, but python's random is global
    # We'll rely on pseudo-randomness.
    
    domain_nodes = []
    
    # Generate Domains
    for d in range(cfg["domainCount"]):
        domain_name = DOMAIN_NAMES[d % len(DOMAIN_NAMES)]
        domain_id = f"domain-{domain_name.lower()}"
        
        domain_node = GraphNode(
            urn=generate_urn('domain', [domain_name.lower()]),
            entityType=EntityType.DOMAIN,
            displayName=f"{domain_name} Domain",
            description=f"All {domain_name.lower()} data and business processes",
            childCount=cfg["appsPerDomain"],
            tags=random.choice([['PII'], ['Financial'], ['GDPR'], ['SOX'], []]),
            properties={
                "businessLabel": f"{domain_name} & Business Unit",
                "owners": [f"{domain_name.lower()}-team@company.com"],
            }
        )
        nodes.append(domain_node)
        domain_nodes.append(domain_node)
        
        # Generate Apps
        for a in range(cfg["appsPerDomain"]):
            app_type_def = random.choice(APP_TYPES)
            platform = random.choice(app_type_def["platforms"])
            app_id = f"app-{domain_name.lower()}-{platform}-{a}"
            app_urn = generate_urn('app', [platform, f"{domain_name.lower()}_{a}"])
            
            app_node = GraphNode(
                urn=app_urn,
                entityType=EntityType.APP if app_type_def["type"] != "database" else EntityType.CONTAINER, # Simplify mapping
                displayName=f"{platform} {domain_name}",
                properties={
                    "businessLabel": f"{platform} {domain_name} System",
                    "technicalLabel": f"{platform}.{domain_name.lower()}_{a}",
                    "appType": app_type_def["type"],
                    "assetCount": random.randint(cfg["assetsPerApp"]["min"], cfg["assetsPerApp"]["max"]),
                    "lastUpdated": f"{random.randint(1, 60)}m ago"
                }
            )
            # Use specific types if possible
            if app_type_def["type"] == 'database':
                app_node.entity_type = EntityType.CONTAINER
            else:
                app_node.entity_type = EntityType.DATA_PLATFORM

            nodes.append(app_node)
            
            # Domain -> App (Containment)
            edges.append(GraphEdge(
                id=f"contains-{domain_node.urn}-{app_node.urn}",
                sourceUrn=domain_node.urn,
                targetUrn=app_node.urn,
                edgeType=EdgeType.CONTAINS,
                properties={"relationship": "contains"}
            ))
            
            # Domain -> App (Producing - Logical)
            edges.append(GraphEdge(
                id=f"lineage-{domain_node.urn}-{app_node.urn}",
                sourceUrn=domain_node.urn,
                targetUrn=app_node.urn,
                edgeType=EdgeType.PRODUCES,
                confidence=random.uniform(0.8, 0.95),
                properties={"animated": True}
            ))
            
            # Assets
            asset_count = random.randint(cfg["assetsPerApp"]["min"], cfg["assetsPerApp"]["max"])
            for ast in range(asset_count):
                asset_type = random.choice(ASSET_TYPES)
                business_term = random.choice(BUSINESS_TERMS)
                technical_term = random.choice(TECHNICAL_TERMS)
                asset_name = f"{technical_term}_{business_term.lower()}_{ast}"
                asset_urn = generate_urn('asset', [platform, f"{domain_name.lower()}.{asset_name}", 'PROD'])
                
                asset_node = GraphNode(
                    urn=asset_urn,
                    entityType=EntityType.DATASET,
                    displayName=asset_name,
                    tags=random.choice([['PII'], ['Financial'], ['GDPR'], ['SOX'], ['Sensitive'], []]),
                    properties={
                        "businessLabel": f"{business_term} {asset_type}",
                        "technicalLabel": f"{platform}.{domain_name.lower()}.{asset_name}",
                        "assetType": asset_type,
                        "schema": technical_term,
                        "rowCount": f"{random.uniform(0.1, 100):.1f}{random.choice(['K', 'M', 'B'])}"
                    }
                )
                nodes.append(asset_node)
                
                # App -> Asset (Containment)
                edges.append(GraphEdge(
                    id=f"contains-{app_node.urn}-{asset_node.urn}",
                    sourceUrn=app_node.urn,
                    targetUrn=asset_node.urn,
                    edgeType=EdgeType.CONTAINS
                ))
                
                # App -> Asset (Lineage)
                edges.append(GraphEdge(
                    id=f"lineage-{app_node.urn}-{asset_node.urn}",
                    sourceUrn=app_node.urn,
                    targetUrn=asset_node.urn,
                    edgeType=EdgeType.PRODUCES,
                    confidence=random.uniform(0.75, 0.98),
                    properties={"animated": True}
                ))
                
                # Columns
                column_count = random.randint(cfg["columnsPerAsset"]["min"], cfg["columnsPerAsset"]["max"])
                for col in range(column_count):
                    col_name = f"col_{col}"
                    if col == 0: col_name = "id"
                    elif col == 1: col_name = f"{business_term.lower()}_id"
                    
                    col_urn = generate_urn('column', [asset_name, col_name])
                    data_type = random.choice(COLUMN_TYPES)
                    
                    col_node = GraphNode(
                        urn=col_urn,
                        entityType=EntityType.SCHEMA_FIELD,
                        displayName=col_name,
                        tags=['PK'] if col < 2 else random.choice([['PII'], ['GDPR'], []]),
                        properties={
                            "businessLabel": col_name.replace("_", " ").title(),
                            "technicalLabel": f"{asset_name}.{col_name}",
                            "dataType": data_type,
                            "nullable": col > 1
                        }
                    )
                    nodes.append(col_node)
                    
                    # Asset -> Column (Containment)
                    edges.append(GraphEdge(
                        id=f"contains-{asset_node.urn}-{col_node.urn}",
                        sourceUrn=asset_node.urn,
                        targetUrn=col_node.urn,
                        edgeType=EdgeType.CONTAINS
                    ))

    return nodes, edges
