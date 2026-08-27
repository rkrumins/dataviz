/**
 * The pages the command palette can take you to.
 *
 * Before this catalogue existed, exactly two of the product's ~25 pages
 * were reachable by name from the one box that claims to search the app:
 * Dashboard and Browse Views, hardcoded. Typing "permissions" or "sso"
 * or "audit log" found nothing at all.
 *
 * Two properties are load-bearing: every path must be a real route
 * (a catalogue that rots sends people to a 404), and a page must never
 * be offered to someone who would be denied on arrival.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
    DEFAULT_ADMIN_SECTION_PERMISSIONS,
    DEFAULT_SIDEBAR_PERMISSIONS,
} from '@/lib/navPermissions'
import type { PermissionClaims } from '@/store/auth'

import { APP_DESTINATIONS, searchDestinations } from '../appDestinations'


const SPECS = {
    sidebar: DEFAULT_SIDEBAR_PERMISSIONS as Record<string, never>,
    admin: DEFAULT_ADMIN_SECTION_PERMISSIONS as Record<string, never>,
}

function claims(global: string[] = []): PermissionClaims {
    return { sid: 'test', global, ws: {} }
}

const ADMIN = claims(['system:admin', 'system:audit:read', 'system:groups:manage'])
const PLAIN = claims([])

const labels = (ds: { label: string }[]) => ds.map((d) => d.label)


describe('APP_DESTINATIONS — the catalogue itself', () => {
    it('points every destination at a route that exists', () => {
        // Guards against catalogue rot: a renamed route would otherwise
        // leave the palette offering a 404.
        const routes = readFileSync(
            path.resolve(
                path.dirname(fileURLToPath(import.meta.url)),
                '../../../routes.tsx',
            ),
            'utf8',
        )
        const declared = new Set(
            [...routes.matchAll(/path: '([^']*)'/g)].map((m) => m[1]),
        )
        for (const d of APP_DESTINATIONS) {
            const segments = d.path.replace(/^\//, '')
            // Routes are declared three ways: absolute ('/guide'),
            // whole-relative ('me/account'), or as the last segment of a
            // nested block ('overview' under 'admin').
            const last = segments.split('/').pop() ?? segments
            expect(
                declared.has(d.path) || declared.has(segments) || declared.has(last),
                `${d.path} is not a declared route`,
            ).toBe(true)
        }
    })

    it('carries no parameterised routes — those are entities, not pages', () => {
        for (const d of APP_DESTINATIONS) {
            expect(d.path).not.toContain(':')
        }
    })

    it('uses unique ids', () => {
        const ids = APP_DESTINATIONS.map((d) => d.id)
        expect(new Set(ids).size).toBe(ids.length)
    })
})


describe('searchDestinations — finding a page by name', () => {
    it('finds a page nobody could reach by name before', () => {
        expect(labels(searchDestinations('permissions', ADMIN, SPECS)))
            .toContain('Permissions')
        expect(labels(searchDestinations('audit', ADMIN, SPECS)))
            .toContain('Audit Log')
        expect(labels(searchDestinations('sso', ADMIN, SPECS)))
            .toContain('Single Sign-On')
    })

    it('finds a page by a word that is not in its label', () => {
        // A business user looks for "dark mode", not "Account Settings".
        expect(labels(searchDestinations('dark mode', PLAIN, SPECS)))
            .toContain('Account Settings')
        expect(labels(searchDestinations('ontology', PLAIN, SPECS)))
            .toContain('Semantic Layers')
        expect(labels(searchDestinations('okta', ADMIN, SPECS)))
            .toEqual(expect.arrayContaining(['Single Sign-On']))
    })

    it('ranks the labelled match above the keyword match', () => {
        const hits = labels(searchDestinations('permissions', ADMIN, SPECS))
        expect(hits[0]).toBe('Permissions')
    })

    it('returns nothing for an empty query', () => {
        expect(searchDestinations('', ADMIN, SPECS)).toEqual([])
        expect(searchDestinations('   ', ADMIN, SPECS)).toEqual([])
    })
})


describe('searchDestinations — never offer a page that would deny', () => {
    it('withholds admin pages from a user without the claim', () => {
        // "My Access" — your own entitlements — is ungated and matches
        // "permissions" on purpose; the admin console is what must not
        // appear.
        expect(labels(searchDestinations('permissions', PLAIN, SPECS)))
            .not.toContain('Permissions')
        expect(searchDestinations('audit', PLAIN, SPECS)).toEqual([])
        expect(searchDestinations('sso connections', PLAIN, SPECS)
            .filter((d) => d.path.startsWith('/admin'))).toEqual([])
    })

    it('still offers the ungated pages to that same user', () => {
        expect(labels(searchDestinations('account', PLAIN, SPECS)))
            .toContain('Account Settings')
    })

    it('honours a delegated claim without granting the rest', () => {
        const groupsOnly = claims(['system:groups:manage'])
        expect(labels(searchDestinations('groups', groupsOnly, SPECS)))
            .toContain('Groups')
        expect(labels(searchDestinations('permissions', groupsOnly, SPECS)))
            .not.toContain('Permissions')
    })

    it('fails closed on a spec the catalogue does not know', () => {
        // Mirrors the route guard's HIDDEN_SPEC fallback: offering a page
        // that would deny on arrival is worse than not offering it.
        const empty = { sidebar: {}, admin: {} } as typeof SPECS
        expect(searchDestinations('permissions', ADMIN, empty)
            .filter((d) => d.path.startsWith('/admin'))).toEqual([])
        // …while an ungated page is unaffected.
        expect(labels(searchDestinations('dashboard', ADMIN, empty)))
            .toContain('Dashboard')
    })
})
