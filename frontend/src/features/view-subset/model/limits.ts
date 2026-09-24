/**
 * Limits the client shares with the server. Each mirrors a bound the API
 * enforces (backend/common/models/graph.py), so a request the client builds
 * is never one the server would refuse.
 */

/** The most members one virtual-hop request may carry
 *  (LINEAGE_BRIDGES_MAX_MEMBERS). A view holding more draws direct lines only. */
export const BRIDGE_MEMBERS_MAX = 2000

/** How far a virtual hop reaches, in raw lineage steps, when a view names no
 *  reach of its own (the API's default `maxHops`). */
export const DEFAULT_MAX_HOPS = 10
