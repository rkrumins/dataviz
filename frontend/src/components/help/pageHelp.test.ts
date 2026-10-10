import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PAGE_HELP, helpSlugsFor } from './pageHelp'
import { guideEntries } from '@/components/guide/guideConfig'

/**
 * "For this page" in Help is only useful if every page has it. The router is
 * the one list of pages, so this reads `routes.tsx` and insists each
 * signed-in route is covered — a new page cannot ship without help.
 */

const ROUTES_SRC = readFileSync(join(__dirname, '..', '..', 'routes.tsx'), 'utf8')

/** Every `path: '…'` literal in the router (relative to its parent). */
const routePaths = [...ROUTES_SRC.matchAll(/\bpath: '([^']*)'/g)].map((m) => m[1])

/** Pages with no help of their own: signed-out doors, the docs readers, redirects. */
const EXEMPT = new Set([
  '/login', '/signup', '/invite/accept', '/forgot-password', '/reset-password',
  '/password-change-required', '/dev-login', '/portal-login',
  '/docs', '/guide', 'faq', ':slug',
  '/', 'admin', '*',
  'views', // redirects to /explorer
  'workspaces/:workspaceId/views', // redirects to the workspace page
  'datasources/:catalogId/history', // redirects to the data source page
])

/** Router paths are relative to their parent ('overview' under 'admin'). */
const covers = (pattern: string, route: string) => pattern === route || pattern.endsWith(`/${route}`)

describe('PAGE_HELP', () => {
  it('offers help on every signed-in page in routes.tsx', () => {
    const missing = routePaths
      .filter((route) => !EXEMPT.has(route))
      .filter((route) => !PAGE_HELP.some((h) => covers(h.path, route)))
    expect(missing).toEqual([])
  })

  it('points only at registered guide pages', () => {
    const slugs = new Set(guideEntries.map((e) => e.slug))
    const unknown = PAGE_HELP.flatMap((h) => h.slugs.filter((s) => !slugs.has(s)).map((s) => `${h.path} → ${s}`))
    expect(unknown).toEqual([])
  })

  it('matches concrete paths, including ones with ids', () => {
    expect(helpSlugsFor('/views/v-123')[0]).toBe('exploring-graph')
    expect(helpSlugsFor('/workspaces/ws-1/reviews')).toContain('review-center')
    expect(helpSlugsFor('/workspaces/ws-1')).toContain('workspace-admin')
    expect(helpSlugsFor('/admin/features')).toEqual(['feature-switches'])
    expect(helpSlugsFor('/no-such-page')).toEqual([])
  })
})
