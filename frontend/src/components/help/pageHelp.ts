import { matchPath } from 'react-router-dom'

/**
 * The guide articles Help offers under "For this page", by route.
 *
 * Patterns are matched whole (`/workspaces/:wsId` does not match its
 * `/reviews` child), so order does not matter. Every signed-in page must
 * appear: `pageHelp.test.ts` checks this list against `routes.tsx`, so a new
 * page cannot ship without help. Name params exactly as the router does.
 */
export const PAGE_HELP: ReadonlyArray<{ path: string; slugs: readonly string[] }> = [
  { path: '/dashboard', slugs: ['quick-start', 'welcome'] },
  { path: '/explorer', slugs: ['browsing-views', 'creating-views', 'managing-views'] },
  { path: '/views/:viewId', slugs: ['exploring-graph', 'reading-lineage', 'lineage-lens', 'editing-in-a-draft'] },
  { path: '/workspaces', slugs: ['workspace-admin', 'admin-setup'] },
  { path: '/workspaces/:wsId', slugs: ['workspace-admin', 'data-freshness'] },
  { path: '/workspaces/:wsId/reviews', slugs: ['review-center', 'versioning-change-control'] },
  { path: '/ingestion', slugs: ['data-freshness', 'admin-setup'] },
  { path: '/datasources/:catalogId', slugs: ['data-freshness'] },
  { path: '/analytics', slugs: ['analytics'] },
  { path: '/schema', slugs: ['semantic-layer'] },
  { path: '/schema/:ontologyId', slugs: ['semantic-layer'] },
  { path: '/my/access', slugs: ['requesting-access', 'users-access'] },
  { path: '/me/account', slugs: ['users-access', 'sso-operations'] },
  { path: '/me/identities', slugs: ['sso-operations'] },
  { path: '/admin/overview', slugs: ['governance-ops', 'admin-setup'] },
  { path: '/admin/infrastructure', slugs: ['governance-ops', 'rollup-capacity'] },
  { path: '/admin/redis', slugs: ['governance-ops'] },
  { path: '/admin/graph-store', slugs: ['graph-store-topology', 'rollup-capacity'] },
  { path: '/admin/branding', slugs: ['governance-ops'] },
  { path: '/admin/features', slugs: ['feature-switches'] },
  { path: '/admin/users', slugs: ['users-access'] },
  { path: '/admin/groups', slugs: ['users-access'] },
  { path: '/admin/permissions', slugs: ['users-access'] },
  { path: '/admin/telemetry', slugs: ['governance-ops'] },
  { path: '/admin/announcements', slugs: ['governance-ops'] },
  { path: '/admin/sso', slugs: ['sso-setup', 'sso-operations'] },
  { path: '/admin/audit', slugs: ['governance-ops'] },
]

/** The guide slugs for the page at `pathname`, most relevant first. */
export function helpSlugsFor(pathname: string): readonly string[] {
  return PAGE_HELP.find((h) => matchPath(h.path, pathname))?.slugs ?? []
}
