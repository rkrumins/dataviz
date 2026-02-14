import random
from typing import List, Dict, Any, Tuple
from ..models.graph import GraphNode, GraphEdge, EntityType, EdgeType

# Configuration
DEFAULT_CONFIG = {
    "domainCount": 3, 
    "appsPerDomain": 11,
    "schemasPerApp": {"min": 10, "max": 15},
    "assetsPerSchema": {"min": 10, "max": 50},
    "columnsPerAsset": {"min": 10, "max": 100},
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
    elif type_ == 'container': prefix = 'urn:li:container' # Added container prefix
    elif type_ == 'asset': prefix = 'urn:li:dataset'
    elif type_ == 'column': prefix = 'urn:li:schemaField' # Changed to standard schemaField
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
    datasets_by_domain: Dict[str, List[GraphNode]] = {} # domain_urn -> list[asset_nodes]
    
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
            
            # Pre-calculate schema count
            schema_count = random.randint(cfg["schemasPerApp"]["min"], cfg["schemasPerApp"]["max"])
            
            app_node = GraphNode(
                urn=app_urn,
                entityType=EntityType.APP if app_type_def["type"] != "database" else EntityType.CONTAINER, # Simplify mapping
                displayName=f"{platform} {domain_name}",
                childCount=schema_count, # Child count matches schemas
                properties={
                    "businessLabel": f"{platform} {domain_name} System",
                    "technicalLabel": f"{platform}.{domain_name.lower()}_{a}",
                    "appType": app_type_def["type"],
                    "schemaCount": schema_count,
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

            # Generate Schemas/Containers
            for s in range(schema_count):
                schema_name = random.choice(TECHNICAL_TERMS) + f"_{s}"
                schema_urn = generate_urn('container', [platform, f"{domain_name.lower()}", schema_name])
                
                # Pre-calculate asset count
                asset_count = random.randint(cfg["assetsPerSchema"]["min"], cfg["assetsPerSchema"]["max"])
                if domain_node.urn not in datasets_by_domain:
                    datasets_by_domain[domain_node.urn] = []


                schema_node = GraphNode(
                    urn=schema_urn,
                    entityType=EntityType.CONTAINER,
                    displayName=schema_name,
                    childCount=asset_count,
                    properties={
                        "businessLabel": f"{schema_name} Schema",
                        "technicalLabel": f"{platform}.{domain_name}.{schema_name}",
                        "assetCount": asset_count
                    }
                )
                nodes.append(schema_node)

                # App -> Schema (Containment)
                edges.append(GraphEdge(
                    id=f"contains-{app_node.urn}-{schema_node.urn}",
                    sourceUrn=app_node.urn,
                    targetUrn=schema_node.urn,
                    edgeType=EdgeType.CONTAINS,
                    properties={"relationship": "contains"}
                ))

                # Assets
                for ast in range(asset_count):
                    asset_type = random.choice(ASSET_TYPES)
                    business_term = random.choice(BUSINESS_TERMS)
                    # technical_term = random.choice(TECHNICAL_TERMS) 
                    asset_name = f"{business_term.lower()}_{ast}"
                    asset_urn = generate_urn('asset', [platform, f"{domain_name.lower()}.{schema_name}.{asset_name}", 'PROD'])
                    
                    # Pre-calculate column count
                    column_count = random.randint(cfg["columnsPerAsset"]["min"], cfg["columnsPerAsset"]["max"])
                    
                    asset_node = GraphNode(
                        urn=asset_urn,
                        entityType=EntityType.DATASET,
                        displayName=asset_name,
                        childCount=column_count, # Populate childCount
                        tags=random.choice([['PII'], ['Financial'], ['GDPR'], ['SOX'], ['Sensitive'], []]),
                        properties={
                            "businessLabel": f"{business_term} {asset_type}",
                            "technicalLabel": f"{platform}.{domain_name.lower()}.{schema_name}.{asset_name}",
                            "assetType": asset_type,
                            "schema": schema_name,
                            "rowCount": f"{random.uniform(0.1, 100):.1f}{random.choice(['K', 'M', 'B'])}"
                        }
                    )
                    nodes.append(asset_node)
                    datasets_by_domain[domain_node.urn].append(asset_node)
                    
                    # Schema -> Asset (Containment)
                    edges.append(GraphEdge(
                        id=f"contains-{schema_node.urn}-{asset_node.urn}",
                        sourceUrn=schema_node.urn,
                        targetUrn=asset_node.urn,
                        edgeType=EdgeType.CONTAINS
                    ))
                    
                    # Schema -> Asset (Lineage) - Optional, maybe not needed for Schema
                    # App -> Asset (Direct Lineage for logic flow?) -> Maybe keep App->Asset lineage for simplicity in graph view?
                    # Let's add Schema -> Asset lineage just in case
                    edges.append(GraphEdge(
                        id=f"lineage-{schema_node.urn}-{asset_node.urn}",
                        sourceUrn=schema_node.urn,
                        targetUrn=asset_node.urn,
                        edgeType=EdgeType.PRODUCES,
                        confidence=random.uniform(0.75, 0.98),
                        properties={"animated": True}
                    ))
                    
                    # Columns
                    for col in range(column_count):
                        col_name = f"col_{col}"
                        if col == 0: col_name = "id"
                        elif col == 1: col_name = f"{business_term.lower()}_id"
                        

                        # Construct a unique column URN using the full hierarchy
                        # Format: platform.domain.schema.asset.column
                        col_urn = generate_urn('column', [platform, f"{domain_name.lower()}", schema_name, asset_name, col_name])
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

    # Generate Domain-to-Domain Lineage (Inter-domain movement)
    for i in range(len(domain_nodes)):
        # Randomly connect to 1-3 other domains
        num_connections = random.randint(1, 3)
        targets = random.sample([d for d in domain_nodes if d != domain_nodes[i]], min(num_connections, len(domain_nodes)-1))
        
        for target_domain in targets:
            edges.append(GraphEdge(
                id=f"lineage-{domain_nodes[i].urn}-{target_domain.urn}",
                sourceUrn=domain_nodes[i].urn,
                targetUrn=target_domain.urn,
                edgeType=EdgeType.PRODUCES,
                confidence=random.uniform(0.5, 0.9),
                properties={
                    "animated": True,
                    "description": "Cross-domain data flow"
                }
            ))

    # Generate Cross-Domain Dataset Lineage
    # Pick random source domain, random target domain, ensure they are different
    # Pick random assets from each and link them
    total_cross_edges = 50000 # Adjust number of edges to generate
    
    domain_urns = list(datasets_by_domain.keys())
    if len(domain_urns) > 1:
        for _ in range(total_cross_edges):
            source_domain = random.choice(domain_urns)
            target_domain = random.choice(domain_urns)
            
            # Retry if same domain
            while target_domain == source_domain:
                target_domain = random.choice(domain_urns)
                
            source_assets = datasets_by_domain.get(source_domain, [])
            target_assets = datasets_by_domain.get(target_domain, [])
            
            if source_assets and target_assets:
                source_asset = random.choice(source_assets)
                target_asset = random.choice(target_assets)
                
                edges.append(GraphEdge(
                    id=f"lineage-{source_asset.urn}-{target_asset.urn}",
                    sourceUrn=source_asset.urn,
                    targetUrn=target_asset.urn,
                    edgeType=EdgeType.PRODUCES,
                    confidence=random.uniform(0.6, 0.95),
                    properties={
                        "animated": True,
                        "description": "Cross-domain dependency"
                    }
                ))



    return nodes, edges
