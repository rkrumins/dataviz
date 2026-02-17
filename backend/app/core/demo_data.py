import random
import json
import os
from typing import List, Dict, Any, Tuple, Optional
from ..models.graph import GraphNode, GraphEdge, EntityType, EdgeType

# Configuration
DEFAULT_CONFIG = {
    "domainCount": 2, 
    "appsPerDomain": 5,
    "schemasPerApp": {"min": 10, "max": 15},
    "assetsPerSchema": {"min": 10, "max": 50},
    "columnsPerAsset": {"min": 10, "max": 100},
    "includeDashboards": True,
    "includeGhostNodes": True,
    "includeColumnLineage": True,
    "columnLineageDensity": 0.3,  # 30% of columns will have lineage
    "columnLineagePatterns": {
        "withinApp": True,
        "crossApp": True,
        "crossDomain": True
    }
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

def _match_columns_for_lineage(
    source_col: GraphNode, 
    target_col: GraphNode, 
    pattern_type: str
) -> Tuple[bool, float, Optional[str]]:
    """
    Match columns for lineage generation.
    
    Returns:
        Tuple of (is_match, confidence, transform_expression)
    """
    source_name = source_col.display_name.lower()
    target_name = target_col.display_name.lower()
    source_type = source_col.properties.get("dataType", "")
    target_type = target_col.properties.get("dataType", "")
    
    # Exact name match - highest confidence
    if source_name == target_name:
        if source_type == target_type:
            return True, 0.95, "direct_copy"
        else:
            return True, 0.85, f"type_cast({source_type} -> {target_type})"
    
    # Pattern matches for common column patterns
    # ID columns
    if ("id" in source_name and "id" in target_name) or \
       (source_name.endswith("_id") and target_name.endswith("_id")):
        if source_type == target_type:
            return True, 0.80, "direct_copy"
        else:
            return True, 0.70, f"type_cast({source_type} -> {target_type})"
    
    # Timestamp columns
    if any(term in source_name for term in ["timestamp", "date", "created_at", "updated_at", "time"]) and \
       any(term in target_name for term in ["timestamp", "date", "created_at", "updated_at", "time"]):
        if source_type == target_type:
            return True, 0.75, "direct_copy"
        else:
            return True, 0.65, f"type_cast({source_type} -> {target_type})"
    
    # Amount/revenue/metric columns
    if any(term in source_name for term in ["amount", "revenue", "price", "cost", "value"]) and \
       any(term in target_name for term in ["amount", "revenue", "price", "cost", "value"]):
        if source_type == target_type:
            return True, 0.75, "direct_copy"
        else:
            return True, 0.65, f"type_cast({source_type} -> {target_type})"
    
    # Status/enum columns
    if "status" in source_name and "status" in target_name:
        if source_type == target_type:
            return True, 0.70, "direct_copy"
        else:
            return True, 0.60, f"type_cast({source_type} -> {target_type})"
    
    # For cross-domain, check if both are PK columns
    if pattern_type == "cross_domain":
        if "PK" in source_col.tags and "PK" in target_col.tags:
            if "id" in source_name or "id" in target_name:
                return True, 0.60, "key_mapping"
    
    return False, 0.0, None

def generate_demo_data(config: Dict[str, Any] = None) -> Tuple[List[GraphNode], List[GraphEdge]]:
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    nodes: List[GraphNode] = []
    edges: List[GraphEdge] = []
    
    # Simple deterministic seed for consistency if needed, but python's random is global
    # We'll rely on pseudo-randomness.
    
    
    domain_nodes = []
    datasets_by_domain: Dict[str, List[GraphNode]] = {} # domain_urn -> list[asset_nodes]
    
    # Column tracking structures for lineage generation
    columns_by_app: Dict[str, List[GraphNode]] = {}  # app_urn -> list[column_nodes]
    columns_by_domain: Dict[str, Dict[str, List[GraphNode]]] = {}  # domain_urn -> {app_urn -> list[column_nodes]}
    columns_by_schema: Dict[str, List[GraphNode]] = {}  # schema_urn -> list[column_nodes]
    columns_by_asset: Dict[str, List[GraphNode]] = {}  # asset_urn -> list[column_nodes]
    
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
                        
                        # Track columns for lineage generation
                        if cfg.get("includeColumnLineage", False):
                            # Track by app
                            if app_urn not in columns_by_app:
                                columns_by_app[app_urn] = []
                            columns_by_app[app_urn].append(col_node)
                            
                            # Track by domain
                            if domain_node.urn not in columns_by_domain:
                                columns_by_domain[domain_node.urn] = {}
                            if app_urn not in columns_by_domain[domain_node.urn]:
                                columns_by_domain[domain_node.urn][app_urn] = []
                            columns_by_domain[domain_node.urn][app_urn].append(col_node)
                            
                            # Track by schema
                            if schema_urn not in columns_by_schema:
                                columns_by_schema[schema_urn] = []
                            columns_by_schema[schema_urn].append(col_node)
                            
                            # Track by asset
                            if asset_urn not in columns_by_asset:
                                columns_by_asset[asset_urn] = []
                            columns_by_asset[asset_urn].append(col_node)
                        
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

    # Generate Column-to-Column Lineage
    if cfg.get("includeColumnLineage", False):
        column_lineage_edges = _generate_column_lineage(
            columns_by_app,
            columns_by_domain,
            columns_by_schema,
            columns_by_asset,
            nodes,
            cfg
        )
        edges.extend(column_lineage_edges)
    
    # Save to file if column lineage is enabled
    if cfg.get("includeColumnLineage", False):
        save_demo_data_to_file(nodes, edges)

    return nodes, edges

def save_demo_data_to_file(nodes: List[GraphNode], edges: List[GraphEdge], filepath: str = None) -> bool:
    """
    Save demo data (nodes and edges) to a JSON file.
    
    Args:
        nodes: List of graph nodes
        edges: List of graph edges
        filepath: Optional file path. Defaults to backend/data/demo_graph_with_lineage.json
    
    Returns:
        True if successful, False otherwise
    """
    if filepath is None:
        # Get the backend directory (parent of app/core)
        current_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir = os.path.dirname(os.path.dirname(current_dir))
        data_dir = os.path.join(backend_dir, "data")
        filepath = os.path.join(data_dir, "demo_graph_with_lineage.json")
    
    # Create directory if it doesn't exist
    data_dir = os.path.dirname(filepath)
    os.makedirs(data_dir, exist_ok=True)
    
    try:
        # Serialize nodes and edges to dictionaries
        data = {
            "nodes": [node.dict(by_alias=True) for node in nodes],
            "edges": [edge.dict(by_alias=True) for edge in edges]
        }
        
        # Write to file
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)
        
        print(f"Saved {len(nodes)} nodes and {len(edges)} edges to {filepath}")
        return True
    except Exception as e:
        print(f"Error saving demo data to file: {e}")
        return False

def _generate_column_lineage(
    columns_by_app: Dict[str, List[GraphNode]],
    columns_by_domain: Dict[str, Dict[str, List[GraphNode]]],
    columns_by_schema: Dict[str, List[GraphNode]],
    columns_by_asset: Dict[str, List[GraphNode]],
    all_nodes: List[GraphNode],
    cfg: Dict[str, Any]
) -> List[GraphEdge]:
    """
    Generate column-to-column lineage edges following data mesh patterns.
    """
    edges: List[GraphEdge] = []
    edge_ids: set = set()  # Track edge IDs to avoid duplicates
    patterns = cfg.get("columnLineagePatterns", {})
    density = cfg.get("columnLineageDensity", 0.3)
    
    # Create a map of schema_urn -> schema_name for pattern matching
    schema_name_map: Dict[str, str] = {}
    for node in all_nodes:
        if node.entity_type == EntityType.CONTAINER and node.urn in columns_by_schema:
            schema_name_map[node.urn] = node.display_name
    
    # Create schema_urn -> app_urn mapping by finding which app's columns reference each schema
    schema_to_app: Dict[str, str] = {}
    for schema_urn in columns_by_schema.keys():
        # Find which app this schema belongs to by checking which app has columns from this schema
        for domain_urn, apps_dict in columns_by_domain.items():
            for app_urn, cols in apps_dict.items():
                # Check if any column from this app belongs to this schema
                for col in cols:
                    # Column URN format: urn:li:schemaField:platform.domain.schema.asset.column
                    # Schema URN format: urn:li:container:platform.domain.schema
                    col_parts = col.urn.split(":")
                    schema_parts = schema_urn.split(":")
                    if len(col_parts) >= 4 and len(schema_parts) >= 4:
                        col_path = col_parts[-1].split(".")
                        schema_path = schema_parts[-1].split(".")
                        # Match if platform, domain, and schema name match
                        if len(col_path) >= 3 and len(schema_path) >= 3:
                            if col_path[0] == schema_path[0] and col_path[1] == schema_path[1] and col_path[2] == schema_path[2]:
                                schema_to_app[schema_urn] = app_urn
                                break
                if schema_urn in schema_to_app:
                    break
            if schema_urn in schema_to_app:
                break
    
    # Pattern 1: Within-App Lineage (raw → staging → analytics)
    if patterns.get("withinApp", True):
        # Group schemas by app
        schemas_by_app: Dict[str, List[str]] = {}
        for schema_urn, app_urn in schema_to_app.items():
            if app_urn not in schemas_by_app:
                schemas_by_app[app_urn] = []
            schemas_by_app[app_urn].append(schema_urn)
        
        for app_urn, schema_urns in schemas_by_app.items():
            if len(schema_urns) < 2:
                continue
            
            # Identify schema patterns (raw, staging, analytics)
            schema_groups: Dict[str, List[str]] = {"raw": [], "staging": [], "analytics": []}
            for schema_urn in schema_urns:
                schema_name = schema_name_map.get(schema_urn, "").lower()
                if "raw" in schema_name:
                    schema_groups["raw"].append(schema_urn)
                elif "staging" in schema_name:
                    schema_groups["staging"].append(schema_urn)
                elif any(term in schema_name for term in ["analytics", "mart", "core"]):
                    schema_groups["analytics"].append(schema_urn)
            
            # Create lineage: raw → staging → analytics
            for source_group, target_group in [("raw", "staging"), ("staging", "analytics"), ("raw", "analytics")]:
                for source_schema_urn in schema_groups[source_group]:
                    for target_schema_urn in schema_groups[target_group]:
                        if source_schema_urn == target_schema_urn:
                            continue
                        source_cols = columns_by_schema.get(source_schema_urn, [])
                        target_cols = columns_by_schema.get(target_schema_urn, [])
                        
                        # Match columns and create edges
                        for source_col in source_cols:
                            if random.random() > density:
                                continue
                            for target_col in target_cols:
                                is_match, confidence, transform = _match_columns_for_lineage(
                                    source_col, target_col, "within_app"
                                )
                                if is_match:
                                    edge_id = f"col-lineage-{source_col.urn}-{target_col.urn}"
                                    if edge_id not in edge_ids:
                                        edge_ids.add(edge_id)
                                        edges.append(GraphEdge(
                                            id=edge_id,
                                            sourceUrn=source_col.urn,
                                            targetUrn=target_col.urn,
                                            edgeType=EdgeType.PRODUCES,
                                            confidence=confidence,
                                            properties={
                                                "animated": True,
                                                "transformExpression": transform,
                                                "lineageType": "within_app",
                                                "description": f"Column lineage within {app_urn}"
                                            }
                                        ))
                                    break  # One match per source column
    
    # Pattern 2: Cross-App Lineage (Same Domain)
    if patterns.get("crossApp", True):
        for domain_urn, apps_dict in columns_by_domain.items():
            app_urns = list(apps_dict.keys())
            if len(app_urns) < 2:
                continue
            
            # Identify source apps (service types) and target apps (warehouse/lake types)
            source_apps = []
            target_apps = []
            
            # Get app nodes to determine types
            app_nodes_by_urn: Dict[str, GraphNode] = {}
            for node in all_nodes:
                if node.urn in app_urns:
                    app_nodes_by_urn[node.urn] = node
            
            for app_urn in app_urns:
                app_node = app_nodes_by_urn.get(app_urn)
                if app_node:
                    app_type = app_node.properties.get("appType", "")
                    if app_type == "service":
                        source_apps.append(app_urn)
                    elif app_type in ["warehouse", "lake", "database"]:
                        target_apps.append(app_urn)
            
            # Create cross-app lineage
            for source_app_urn in source_apps:
                for target_app_urn in target_apps:
                    if source_app_urn == target_app_urn:
                        continue
                    
                    source_cols = apps_dict.get(source_app_urn, [])
                    target_cols = apps_dict.get(target_app_urn, [])
                    
                    for source_col in source_cols:
                        if random.random() > density:
                            continue
                        for target_col in target_cols:
                            is_match, confidence, transform = _match_columns_for_lineage(
                                source_col, target_col, "cross_app"
                            )
                            if is_match:
                                edge_id = f"col-lineage-{source_col.urn}-{target_col.urn}"
                                if edge_id not in edge_ids:
                                    edge_ids.add(edge_id)
                                    edges.append(GraphEdge(
                                        id=edge_id,
                                        sourceUrn=source_col.urn,
                                        targetUrn=target_col.urn,
                                        edgeType=EdgeType.PRODUCES,
                                        confidence=confidence * 0.9,  # Slightly lower for cross-app
                                        properties={
                                            "animated": True,
                                            "transformExpression": transform,
                                            "lineageType": "cross_app",
                                            "description": f"Column lineage from {source_app_urn} to {target_app_urn}"
                                        }
                                    ))
                                break
    
    # Pattern 3: Cross-Domain Lineage
    if patterns.get("crossDomain", True):
        domain_urns = list(columns_by_domain.keys())
        if len(domain_urns) < 2:
            return edges
        
        # Collect key columns from each domain (IDs, timestamps, amounts)
        key_columns_by_domain: Dict[str, List[GraphNode]] = {}
        for domain_urn, apps_dict in columns_by_domain.items():
            key_cols = []
            for app_urn, cols in apps_dict.items():
                for col in cols:
                    col_name = col.display_name.lower()
                    # Select key columns: IDs, timestamps, amounts
                    if ("id" in col_name and col_name.endswith("_id")) or \
                       any(term in col_name for term in ["timestamp", "date", "created_at"]) or \
                       any(term in col_name for term in ["amount", "revenue", "price"]) or \
                       "PK" in col.tags:
                        key_cols.append(col)
            key_columns_by_domain[domain_urn] = key_cols
        
        # Create cross-domain lineage
        for i, source_domain in enumerate(domain_urns):
            for target_domain in domain_urns[i+1:]:
                source_cols = key_columns_by_domain.get(source_domain, [])
                target_cols = key_columns_by_domain.get(target_domain, [])
                
                # Limit the number of cross-domain edges to avoid explosion
                max_edges = min(50, len(source_cols) * len(target_cols) // 10)
                edge_count = 0
                
                for source_col in source_cols:
                    if random.random() > density * 0.5:  # Lower density for cross-domain
                        continue
                    if edge_count >= max_edges:
                        break
                    for target_col in target_cols:
                        if edge_count >= max_edges:
                            break
                        is_match, confidence, transform = _match_columns_for_lineage(
                            source_col, target_col, "cross_domain"
                        )
                        if is_match:
                            edge_id = f"col-lineage-{source_col.urn}-{target_col.urn}"
                            if edge_id not in edge_ids:
                                edge_ids.add(edge_id)
                                edges.append(GraphEdge(
                                    id=edge_id,
                                    sourceUrn=source_col.urn,
                                    targetUrn=target_col.urn,
                                    edgeType=EdgeType.PRODUCES,
                                    confidence=confidence * 0.8,  # Lower confidence for cross-domain
                                    properties={
                                        "animated": True,
                                        "transformExpression": transform,
                                        "lineageType": "cross_domain",
                                        "description": f"Cross-domain column lineage from {source_domain} to {target_domain}"
                                    }
                                ))
                                edge_count += 1
                            break
    
    return edges
