/**
 * Landing-site brand identity — build-time configurable.
 *
 * The marketing site is a static, decoupled build with no API access, so
 * branding is resolved from Vite env vars (``VITE_BRAND_*``) at build time
 * rather than fetched at runtime. Defaults live in ``landing/.env`` and
 * mirror the backend ``APP_BRAND_*`` defaults; override them per client at
 * build time, e.g. ``VITE_BRAND_NAME="Acme Lineage" npm run build``.
 *
 * The same vars drive the static <title>/OG/JSON-LD tags via Vite's
 * ``%VITE_BRAND_*%`` HTML token replacement in index.html.
 */
const env = import.meta.env

export const BRAND = {
  /** Full product name, e.g. "Nexus Lineage". */
  name: env.VITE_BRAND_NAME ?? 'Nexus Lineage',
  /** Compact variant for tight spaces. */
  shortName: env.VITE_BRAND_SHORT_NAME ?? 'NexusLineage',
  /** One-line tagline. */
  description: env.VITE_BRAND_DESCRIPTION ?? 'Interactive Data Lineage Visualization',
} as const
