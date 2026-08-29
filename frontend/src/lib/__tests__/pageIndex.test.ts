/**
 * The palette's catalogue of destinations, and the gate that decides who
 * may see each one.
 *
 * Two failures this pins:
 *
 *   * **A page nobody can find.** `routes.tsx` is the only list of what
 *     exists; the index is hand-written beside it and would rot silently.
 *     So the coverage test reads the router source and insists every
 *     non-param authenticated route is indexed — and, the other way
 *     round, that nothing indexed points at a route that isn't there.
 *   * **A destination that 403s.** The palette must resolve access
 *     exactly as `RequireNav` does, from the same catalogue specs and
 *     the same pure `checkNavPermission`, or it will offer people doors
 *     that slam — and for a nested route like `/admin/:section` that
 *     means every guard on the way in, not just the innermost one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    PAGE_INDEX,
    pageAllowed,
    type PageAccessContext,
    type PageEntry,
} from '../pageIndex'
import {
    DEFAULT_ADMIN_SECTION_PERMISSIONS,
    DEFAULT_SIDEBAR_PERMISSIONS,
} from '@/lib/navPermissions'
import type { PermissionClaims } from '@/store/auth'

// ── Route coverage ───────────────────────────────────────────────────

const ROUTES_SRC = readFileSync(join(__dirname, '..', '..', 'routes.tsx'), 'utf8')

/** Every `path: '…'` literal in the router, in source order. */
function routePaths(): string[] {
    return [...ROUTES_SRC.matchAll(/\bpath: '([^']*)'/g)].map((m) => m[1])
}

/** Signed-out doors. The palette only ever renders for a signed-in user. */
const UNAUTHENTICATED = new Set([
    '/login',
    '/signup',
    '/invite/accept',
    '/forgot-password',
    '/reset-password',
    '/password-change-required',
    '/dev-login',
    '/portal-login',
])

/** Routes with no page of their own — they only redirect or wrap. */
const NOT_A_DESTINATION = new Set([
    '/', // index-redirects to /dashboard
    'admin', // layout route; index-redirects to /admin/overview
])

/** Routes the index is expected to carry. */
function indexableRoutePaths(): string[] {
    return routePaths().filter(
        (p) =>
            !p.includes(':') &&
            p !== '*' &&
            !UNAUTHENTICATED.has(p) &&
            !NOT_A_DESTINATION.has(p),
    )
}

/** An entry's path without its `?tab=` deep link. */
function basePath(entry: PageEntry): string {
    return entry.path.split('?')[0]
}

/**
 * Router paths are relative to their parent (`'overview'` under
 * `'admin'`), so an entry covers a route when its path ends on that
 * route's own segment(s).
 */
function covers(entryPath: string, routePath: string): boolean {
    return entryPath === routePath || entryPath.endsWith(`/${routePath}`)
}

function entry(path: string): PageEntry {
    const found = PAGE_INDEX.find((e) => e.path === path)
    if (!found) throw new Error(`no PAGE_INDEX entry for ${path}`)
    return found
}

describe('PAGE_INDEX', () => {
    it('indexes every non-param authenticated route in routes.tsx', () => {
        const missing = indexableRoutePaths().filter(
            (route) => !PAGE_INDEX.some((e) => covers(basePath(e), route)),
        )

        expect(missing).toEqual([])
    })

    it('points at nothing that is not a route', () => {
        const routes = routePaths()
        const stray = PAGE_INDEX.filter(
            (e) => !routes.some((route) => covers(basePath(e), route)),
        ).map((e) => e.path)

        expect(stray).toEqual([])
    })

    it('has unique ids', () => {
        const ids = PAGE_INDEX.map((e) => e.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('has unique paths', () => {
        const paths = PAGE_INDEX.map((e) => e.path)
        expect(new Set(paths).size).toBe(paths.length)
    })

    it('categorises account and admin destinations as settings', () => {
        expect(entry('/me/account').category).toBe('Setting')
        expect(entry('/admin/audit').category).toBe('Setting')
        expect(entry('/dashboard').category).toBe('Page')
    })
})

// ── Permission gate ──────────────────────────────────────────────────

function ctx(
    claims: Partial<PermissionClaims>,
    analyticsAllowed = false,
): PageAccessContext {
    return {
        claims: { sid: 's1', global: [], ws: {}, ...claims },
        sidebar: DEFAULT_SIDEBAR_PERMISSIONS,
        adminSections: DEFAULT_ADMIN_SECTION_PERMISSIONS,
        analyticsAllowed,
    }
}

describe('pageAllowed', () => {
    it('opens an always-gated page to a user holding nothing', () => {
        expect(pageAllowed(entry('/dashboard'), ctx({}))).toBe(true)
        expect(pageAllowed(entry('/me/account'), ctx({}))).toBe(true)
        expect(pageAllowed(entry('/docs/faq'), ctx({}))).toBe(true)
    })

    it('hides the audit log from a user holding nothing', () => {
        expect(pageAllowed(entry('/admin/audit'), ctx({}))).toBe(false)
    })

    it('needs BOTH gates for an admin section', () => {
        // `/admin` is a nested route with a guard at each level, so the
        // section spec on its own is not the door.
        //
        // The auditor case is not hypothetical: the seeded `org_auditor`
        // role (`backend/app/config/rbac_seed.py`) holds
        // `system:audit:read` and nothing in the parent's anyPerm list,
        // so it is refused at `/admin` before the audit section is ever
        // consulted. The palette has to say the same thing.
        const auditorOnly = ctx({ global: ['system:audit:read'] })
        const groupsOnly = ctx({ global: ['system:groups:manage'] })
        const both = ctx({ global: ['system:groups:manage', 'system:audit:read'] })

        expect(pageAllowed(entry('/admin/audit'), auditorOnly)).toBe(false) // parent gate
        expect(pageAllowed(entry('/admin/audit'), groupsOnly)).toBe(false) // section gate
        expect(pageAllowed(entry('/admin/audit'), both)).toBe(true)
    })

    it('keeps a groups-only admin out of user management', () => {
        const groupsAdmin = ctx({ global: ['system:groups:manage'] })
        expect(pageAllowed(entry('/admin/users'), groupsAdmin)).toBe(false)
        expect(pageAllowed(entry('/admin/groups'), groupsAdmin)).toBe(true)
    })

    it('opens Ingestion to a workspace-scoped provider reader', () => {
        // `anyPerm` satisfies workspace-prefixed perms from ANY bucket.
        const reader = ctx({ ws: { w1: ['workspace:provider:read'] } })
        expect(pageAllowed(entry('/ingestion'), reader)).toBe(true)
        expect(pageAllowed(entry('/ingestion?tab=jobs'), reader)).toBe(true)
        expect(pageAllowed(entry('/ingestion'), ctx({}))).toBe(false)
    })

    it('fails closed on a section key the catalogue does not carry', () => {
        // Claims that satisfy the parent `/admin` gate, so the unknown
        // key is the only thing left that can deny — otherwise this
        // would pass for the wrong reason.
        const holder = ctx({ global: ['system:groups:manage'] })
        const unknownAdmin: PageEntry = {
            ...entry('/admin/audit'),
            gate: { kind: 'admin', key: 'no-such-section' },
        }
        const unknownSidebar: PageEntry = {
            ...entry('/ingestion'),
            gate: { kind: 'sidebar', key: 'no-such-tab' as never },
        }

        expect(pageAllowed(unknownAdmin, holder)).toBe(false)
        expect(pageAllowed(unknownSidebar, holder)).toBe(false)
    })

    it('follows analyticsAllowed for Analytics and its tabs', () => {
        // The flag half of the door: no permission at all, but the
        // section is public on this deployment.
        expect(pageAllowed(entry('/analytics'), ctx({}, true))).toBe(true)
        expect(pageAllowed(entry('/analytics?tab=growth'), ctx({}, true))).toBe(true)

        // And the reverse: an analytics-privileged reader is still hidden
        // when the caller says no, because the caller is the hook that
        // already OR-ed the two halves together.
        const privileged = ctx({ global: ['system:analytics:read'] }, false)
        expect(pageAllowed(entry('/analytics'), privileged)).toBe(false)
    })
})
