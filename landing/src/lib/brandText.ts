/**
 * Brand-token interpolation for static copy.
 *
 * Several landing data arrays (FAQ items, comparison columns, testimonials,
 * feature/benefit descriptions) live at module scope and can't call the
 * `useBrand()` hook. They carry literal `{brand}` / `{brandShort}` tokens
 * instead of a hardcoded product name; components resolve them at render
 * time against the live brand. Mirrors the main app's `lib/brandText.ts`.
 */
import type { ResolvedBrand } from '@/context/BrandContext'

/** Replace `{brand}` → name and `{brandShort}` → shortName. */
export function interpolateBrand(text: string, brand: ResolvedBrand): string {
    return text
        .replaceAll('{brand}', brand.name)
        .replaceAll('{brandShort}', brand.shortName)
}
