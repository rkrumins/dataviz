/**
 * Where a finding leads — the chart that explains it, and the screen that
 * fixes it.
 *
 * Keyed by the server's stable insight key, and owned HERE rather than on the
 * server: a destination is a route, and the door to it is a nav permission
 * spec. Both live on the client, next to the router and the nav catalogue that
 * already maintain them. A server hardcoding `/ingestion?tab=freshness` would
 * be a server with an opinion about a router it cannot see.
 *
 * Two fields, and they answer different questions:
 *
 *   * `anchor` — the chart on the insight's own tab that shows the working.
 *     Clicking a finding should land ON it, not merely on the tab that
 *     contains it and leave the reader to hunt.
 *   * `action` — the screen where something can be DONE about it. An
 *     observation is half a dashboard: "7 access requests pending" is a fact,
 *     "Open workspaces →" is the next step, and the difference between them is
 *     whether anyone does anything about it.
 *
 * A rule with no honest destination gets none. A vague link is worse than a
 * plain statement, because it spends the reader's trust and returns nothing.
 */
import type { NavPermissionSpec } from '@/lib/navPermissions'

export interface InsightAction {
    label: string
    href: string
    /**
     * What it takes to get in — the SAME spec the sidebar evaluates, so an
     * action can never appear for someone the route will then refuse. Offering
     * a door that turns you away reads as a broken product rather than a
     * scoped one.
     */
    requires: NavPermissionSpec
}

/** Reachable by anyone signed in. */
const ANYONE: NavPermissionSpec = { kind: 'always' }

/** Mirrors `nav_catalogue._SIDEBAR["ingestion"]`. */
const INGESTION: NavPermissionSpec = {
    kind: 'anyPerm',
    perms: ['system:admin', 'system:org-admin', 'workspace:provider:read', 'workspace:datasource:manage'],
}

/** Mirrors `nav_catalogue._SIDEBAR["schema"]`. */
const SEMANTIC: NavPermissionSpec = {
    kind: 'anyPerm',
    perms: ['system:admin', 'system:org-admin', 'workspace:ontology:read'],
}

/** Mirrors `nav_catalogue._ADMIN["users"]`. */
const USER_ADMIN: NavPermissionSpec = { kind: 'perm', perm: 'system:admin' }

const FRESHNESS: InsightAction = {
    label: 'Check source freshness',
    href: '/ingestion?tab=freshness',
    requires: INGESTION,
}

const CATALOGUE: InsightAction = {
    label: 'Browse the view catalogue',
    href: '/views',
    requires: ANYONE,
}

export const INSIGHT_TARGETS: Record<string, { anchor?: string; action?: InsightAction }> = {
    // ── Growth ──────────────────────────────────────────────────────
    signups: { anchor: 'chart-new-accounts' },
    'signup-mix': { anchor: 'chart-signup-source' },
    'access-backlog': {
        action: {
            // Approvals live on each workspace rather than in one queue, so
            // this goes to the list and says so, instead of promising a screen
            // that does not exist.
            label: 'Open workspaces',
            href: '/workspaces',
            requires: ANYONE,
        },
    },
    'invite-acceptance': {
        action: {
            label: 'Review users and invitations',
            href: '/admin/users',
            requires: USER_ADMIN,
        },
    },
    // Growth accounting lives on GROWTH, which is where the server now sends
    // this one too.
    dormancy: { anchor: 'chart-growth-accounting' },

    // ── Engagement ──────────────────────────────────────────────────
    active: { anchor: 'chart-active-users' },
    stickiness: { anchor: 'chart-active-users' },
    'funnel-leak': { anchor: 'chart-activation-funnel' },
    'trace-empty': { anchor: 'chart-value-moments' },
    'search-miss': { anchor: 'chart-value-moments' },

    // ── Content ─────────────────────────────────────────────────────
    views: { anchor: 'chart-views-created' },
    concentration: { anchor: 'chart-popular-views', action: CATALOGUE },
    'views-not-opened': { anchor: 'chart-popular-views', action: CATALOGUE },
    'semantic-coverage': {
        action: {
            label: 'Open the semantic layer',
            href: '/schema',
            requires: SEMANTIC,
        },
    },

    // ── Platform health ─────────────────────────────────────────────
    'refresh-failures': { action: FRESHNESS },
    'stale-sources': { action: FRESHNESS },
}

/**
 * Scroll a chart into view and mark it, once the tab holding it has rendered.
 *
 * Done to the DOM rather than through state because the target lives inside
 * whichever tab just mounted — threading a "flash this one" flag down through
 * six tab components to reach one `<section>` would put the plumbing in five
 * files that do not care.
 *
 * Two frames of grace: the first lets the new tab commit, the second lets
 * layout settle so `scrollIntoView` measures the real position.
 */
export function revealChart(anchor: string) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.getElementById(anchor)
        if (!el) return
        // jsdom has no scroller; the marking below is the part worth testing
        // and should not be lost to a missing DOM method.
        el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        el.setAttribute('data-revealed', 'true')
        // Long enough to notice, short enough that it is gone before it can be
        // mistaken for a permanent state.
        window.setTimeout(() => el.removeAttribute('data-revealed'), 1600)
    }))
}
