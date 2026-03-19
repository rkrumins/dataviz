#!/usr/bin/env python3
"""
Docker-aware demo data seeder.

Waits for FalkorDB to become healthy, then seeds enterprise demo scenarios
into the graph database. Designed to run as a one-shot container in
docker-compose (exits 0 on success).

Usage (standalone):
    python -m backend.scripts.docker_seed --scenarios all --scale 1

Usage (docker-compose):
    Runs automatically via the `seed` service profile.
"""

import argparse
import asyncio
import logging
import os
import sys
import time

# Ensure project root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.scripts.seed_falkordb import EnterpriseDataGenerator, seed_falkordb

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("docker_seed")


def wait_for_falkordb(host: str, port: int, timeout: int = 60) -> bool:
    """Block until FalkorDB responds to PING, or timeout."""
    import socket

    deadline = time.time() + timeout
    logger.info("Waiting for FalkorDB at %s:%d (timeout %ds)...", host, port, timeout)

    while time.time() < deadline:
        try:
            sock = socket.create_connection((host, port), timeout=2)
            sock.sendall(b"PING\r\n")
            data = sock.recv(64)
            sock.close()
            if b"PONG" in data:
                logger.info("FalkorDB is ready.")
                return True
        except (ConnectionRefusedError, OSError, socket.timeout):
            pass
        time.sleep(1)

    logger.error("FalkorDB did not become ready within %ds.", timeout)
    return False


async def check_already_seeded(host: str, port: int, graph_name: str) -> bool:
    """Return True if the graph already has data (skip re-seeding)."""
    try:
        from backend.app.providers.falkordb_provider import FalkorDBProvider

        provider = FalkorDBProvider(host=host, port=port, graph_name=graph_name)
        await provider._ensure_connected()
        stats = await provider.get_stats()
        node_count = getattr(stats, "total_nodes", 0) or 0
        if node_count > 0:
            logger.info(
                "Graph '%s' already has %d nodes — skipping seed.", graph_name, node_count
            )
            return True
    except Exception as exc:
        logger.warning("Could not check existing data (proceeding with seed): %s", exc)
    return False


async def main():
    parser = argparse.ArgumentParser(description="Docker-aware demo data seeder")
    parser.add_argument(
        "--scenarios",
        type=str,
        default=os.getenv("SEED_SCENARIOS", "finance,ecommerce"),
        help="Comma-separated scenario names, or 'all'",
    )
    parser.add_argument(
        "--scale",
        type=int,
        default=int(os.getenv("SEED_SCALE", "1")),
        help="Scale factor (1 = ~1k nodes per scenario)",
    )
    parser.add_argument(
        "--breadth",
        type=int,
        default=int(os.getenv("SEED_BREADTH", "1")),
        help="Parallel system breadth multiplier",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=int(os.getenv("SEED_DEPTH", "1")),
        help="Transformation layer depth",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        default=os.getenv("SEED_FORCE", "").lower() in ("1", "true", "yes"),
        help="Force re-seed even if data exists",
    )
    args = parser.parse_args()

    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    graph_name = os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage")

    # 1. Wait for FalkorDB
    if not wait_for_falkordb(host, port, timeout=90):
        sys.exit(1)

    # 2. Check if already seeded (skip unless --force)
    if not args.force and await check_already_seeded(host, port, graph_name):
        logger.info("Seed skipped (use --force or SEED_FORCE=true to re-seed).")
        return

    # 3. Generate and seed
    from backend.scripts.seed_falkordb import SCENARIOS

    scenario_list = args.scenarios.split(",")
    if "all" in scenario_list:
        scenario_list = list(SCENARIOS.keys())

    logger.info(
        "Seeding scenarios=%s, scale=%d, breadth=%d, depth=%d",
        scenario_list,
        args.scale,
        args.breadth,
        args.depth,
    )

    gen = EnterpriseDataGenerator(
        scenarios=scenario_list,
        scale=args.scale,
        breadth=args.breadth,
        depth=args.depth,
    )
    gen.generate()
    await seed_falkordb(gen)

    logger.info("Demo data seeding complete!")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.warning("Interrupted.")
    except Exception as e:
        logger.error("Seeding failed: %s", e)
        import traceback

        traceback.print_exc()
        sys.exit(1)
