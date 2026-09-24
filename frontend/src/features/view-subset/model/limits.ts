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

/** The most entities one subset may hold (VIEW_SUBSET_MAX_MEMBERS). */
export const SUBSET_MEMBERS_MAX = 1000

/** The reach a subset's virtual hops may be given (ViewConnectivity.maxHops). */
export const MAX_HOPS_CAP = 20

/** A grow that would add more than this many entities asks first. */
export const GROW_REVIEW_ABOVE = 50

/** Subsets a view's Details › About lists before "the newest N". */
export const SUBSET_FAMILY_PAGE = 20
