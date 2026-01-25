import urllib.request
import urllib.parse
import json
import time
import sys

BASE_URL = "http://localhost:8001/api/v1"

def do_request(url, method="GET", data=None):
    try:
        req = urllib.request.Request(url, method=method)
        req.add_header('Content-Type', 'application/json')
        if data:
            json_data = json.dumps(data).encode('utf-8')
            req.data = json_data
        
        with urllib.request.urlopen(req) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        print(f"Request failed: {e}")
        return 0, str(e)

def test_health():
    url = "http://localhost:8001/health"
    status, data = do_request(url)
    print(f"Health Check: {status} {data}")
    return status == 200

def find_dataset_urn():
    payload = {"query": "urn:li:dataset", "limit": 1}
    status, data = do_request(f"{BASE_URL}/search", "POST", payload)
    if status == 200 and len(data) > 0:
        return data[0]['urn']
    return None

def test_pagination():
    print("\n--- Testing Pagination ---")
    
    # 1. Search Pagination
    # Search "schemaField" usually returns many
    payload_p1 = {"query": "schemaField", "limit": 5, "offset": 0}
    status_p1, data_p1 = do_request(f"{BASE_URL}/search", "POST", payload_p1)
    
    payload_p2 = {"query": "schemaField", "limit": 5, "offset": 5}
    status_p2, data_p2 = do_request(f"{BASE_URL}/search", "POST", payload_p2)
    
    if status_p1 == 200 and status_p2 == 200:
        print(f"Page 1 Count: {len(data_p1)}")
        print(f"Page 2 Count: {len(data_p2)}")
        
        ids_p1 = set(n['urn'] for n in data_p1)
        ids_p2 = set(n['urn'] for n in data_p2)
        
        if len(ids_p1.intersection(ids_p2)) == 0:
            print("Success: Pages contain distinct items.")
        else:
            print("Failed: Overlap between pages.")
            
    # 2. Edge Pagination
    url_e1 = f"{BASE_URL}/edges?limit=5&offset=0"
    _, edges_1 = do_request(url_e1)
    url_e2 = f"{BASE_URL}/edges?limit=5&offset=5"
    _, edges_2 = do_request(url_e2)
    
    if len(edges_1) == 5 and len(edges_2) == 5:
        print(f"Edge Page 1: {len(edges_1)}, Edge Page 2: {len(edges_2)}")
        e_ids_1 = set(e['id'] for e in edges_1)
        e_ids_2 = set(e['id'] for e in edges_2)
        if len(e_ids_1.intersection(e_ids_2)) == 0:
            print("Success: Edge pages distinct.")
        else:
            print("Failed: Edge overlap.")

def test_trace_lineage(urn):
    if not urn: return False
    print(f"\n--- Testing Trace Lineage for {urn} ---")
    payload = {
        "urn": urn,
        "direction": "both",
        "depth": 3,
        "granularity": "table",
        "aggregate_edges": True
    }
    
    start = time.time()
    status, data = do_request(f"{BASE_URL}/trace", "POST", payload)
    duration = time.time() - start
    
    if status == 200:
        print(f"Success! Time: {duration:.3f}s")
        print(f"Nodes: {len(data['nodes'])}")
        print(f"Edges: {len(data['edges'])}")
        agg_edges = data.get('aggregatedEdges') or {}
        print(f"Aggregated Edges: {len(agg_edges)}")
        if agg_edges:
             print("Sample Aggregated Edge:", list(agg_edges.values())[0]['id'])
        return True
    else:
        print(f"Failed: {status} {data}")
        return False

def test_trace_lineage_column(urn):
    if not urn: return False
    print(f"\n--- Testing Trace Lineage (Column Level) for {urn} ---")
    payload = {
        "urn": urn,
        "granularity": "column",
        "aggregate_edges": False
    }
    
    status, data = do_request(f"{BASE_URL}/trace", "POST", payload)
    if status == 200:
        print(f"Success! Nodes: {len(data['nodes'])}")
        cols = [n for n in data['nodes'] if n['entityType'] == 'schemaField']
        print(f"Columns Found: {len(cols)}")
        return True
    else:
        print(f"Failed: {status} {data}")
        return False

def test_edges(urn):
    print("\n--- Testing Edge Query ---")
    # Test edges connected to this URN
    url = f"{BASE_URL}/edges?sourceUrn={urn}"
    status, data = do_request(url)
    if status == 200:
        print(f"Edges produced by {urn}: {len(data)}")
        if data:
            print(f"Sample Edge: {data[0]['edgeType']} -> {data[0]['targetUrn']}")
        return True
    else:
        print(f"Failed: {status} {data}")
        return False

def test_neighborhood(urn):
    print(f"\n--- Testing Neighborhood Map for {urn} ---")
    url = f"{BASE_URL}/map/{urn}"
    status, data = do_request(url)
    if status == 200:
        print(f"Node: {data['node']['displayName']}")
        print(f"Edges: {len(data['edges'])}")
        print(f"Neighbors: {len(data['neighbors'])}")
        return True
    else:
        print(f"Failed: {status} {data}")
        return False

def test_get_node():
    print("\n--- Testing Get Node ---")
    urn = "urn:li:domain:finance"
    status, data = do_request(f"{BASE_URL}/nodes/{urn}")
    if status == 200:
        print(f"Success: {data['displayName']}")
        return True
    else:
        print(f"Failed: {status}")
        return False

def test_search():
    print("\n--- Testing Search ---")
    payload = {"query": "domain", "limit": 5}
    status, data = do_request(f"{BASE_URL}/search", "POST", payload)
    if status == 200:
        print(f"Found: {len(data)}")
        for n in data:
            print(f" - {n['displayName']} ({n['entityType']})")
        return True
    else:
        print(f"Failed: {status}")
        return False

def test_stats():
    print("\n--- Testing Stats ---")
    status, data = do_request(f"{BASE_URL}/stats")
    if status == 200:
        print(json.dumps(data, indent=2))
        return True
    else:
        print(f"Failed: {status}")
        return False

def test_generic_nodes():
    print("\n--- Testing Generic Node Query ---")
    # Query for all datasets
    payload = {"entityType": "dataset", "limit": 5}
    # GET with query params
    params = urllib.parse.urlencode(payload)
    status, data = do_request(f"{BASE_URL}/nodes?{params}")
    if status == 200:
        print(f"Datasets Found: {len(data)}")
        if len(data) > 0:
            print(f"Sample: {data[0]['displayName']}")
        return True
    else:
        print(f"Failed: {status} {data}")
        return False

def test_bulk_fetch(urns):
    print("\n--- Testing Bulk Node Fetch ---")
    if not urns: return False
    payload = {"query": {"urns": urns}} # NodeQuery wrapped in 'query' due to embed=True?
    # Wait, graph.py says: query: NodeQuery = Body(..., embed=True)
    # So JSON body should be {"query": {"urns": [...]}}
    
    status, data = do_request(f"{BASE_URL}/nodes/query", "POST", payload)
    if status == 200:
        print(f"Bulk Fetch ({len(urns)} URNs): Found {len(data)}")
        found_urns = set(n['urn'] for n in data)
        missing = set(urns) - found_urns
        if not missing:
            print("Success: All requested URNs found.")
        else:
            print(f"Partial Success: Missing {missing}")
        return True
    else:
        print(f"Bulk Fetch Failed: {status} {data}")
        return False

def test_ancestors_descendants(urn):
    # Test Ancestors
    print(f"\n--- Testing Ancestors for {urn} ---")
    status, data = do_request(f"{BASE_URL}/nodes/{urn}/ancestors")
    if status == 200:
        print(f"Ancestors: {len(data)}")
        for n in data: print(f" ^ {n['displayName']} ({n['entityType']})")
    else:
        print(f"Ancestors Failed: {status} {data}")

    # Test Descendants
    domain_urn = "urn:li:domain:finance"
    print(f"\n--- Testing Descendants for {domain_urn} ---")
    status, data = do_request(f"{BASE_URL}/nodes/{domain_urn}/descendants?depth=2&limit=5")
    if status == 200:
        print(f"Descendants (depth 2): {len(data)}")
        for n in data: print(f" v {n['displayName']} ({n['entityType']})")
    else:
        print(f"Descendants Failed: {status} {data}")

def test_filters():
    # Test Tag Filter (Mock data assigns random tags)
    print("\n--- Testing Tag Filter ---")
    tag = "PII"
    status, data = do_request(f"{BASE_URL}/nodes/by-tag/{tag}?limit=5")
    if status == 200:
        print(f"Nodes with tag '{tag}': {len(data)}")
    else:
        print(f"Tag Filter Failed: {status}")

if __name__ == "__main__":
    if not test_health():
        print("Server not running or unhealthy. Exiting.")
        sys.exit(1)
        
    test_stats()
    test_search()
    test_get_node()
    test_pagination()
    test_generic_nodes()
    test_filters()
    
    urn = find_dataset_urn()
    if urn:
        test_trace_lineage(urn)
        test_trace_lineage_column(urn)
        test_edges(urn)
        test_neighborhood(urn)
        test_ancestors_descendants(urn)
        # Test bulk fetch with the urn found + the finance domain
        test_bulk_fetch([urn, "urn:li:domain:finance"])
    else:
        print("Could not find a valid dataset URN to test lineage.")
