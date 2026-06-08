/**
 * Brand-token interpolation for static copy (docs, guide).
 *
 * Config files and markdown carry literal ``{brand}`` / ``{brandShort}``
 * tokens instead of a hardcoded product name; consuming components resolve
 * them at render time against the live brand store (``useBrand()``), so a
 * rebrand flows into the docs/guide without touching the content.
 */
import type { Branding } from '@/services/brandingService'

/** Replace ``{brand}`` → appName and ``{brandShort}`` → shortName. */
export function interpolateBrand(text: string, brand: Branding): string {
    return text
        .replaceAll('{brand}', brand.appName)
        .replaceAll('{brandShort}', brand.shortName)
}
