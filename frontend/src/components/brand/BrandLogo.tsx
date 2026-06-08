/**
 * BrandLogo — the deployment's logo mark.
 *
 * Renders the configured logo image (URL or uploaded data URI) when set,
 * otherwise the stock gradient pyramid mark. Used anywhere the old inline
 * logo SVG was hardcoded (TopBar, auth pages, …) so a single branding
 * change updates every mark.
 */
import { useBrand } from '@/store/branding'
import { cn } from '@/lib/utils'

interface BrandLogoProps {
    /** Tailwind size classes for the mark container (e.g. ``w-8 h-8``). */
    className?: string
    /** Tailwind size classes for the inner glyph when falling back to the
     *  default mark (e.g. ``w-5 h-5``). */
    glyphClassName?: string
}

export function BrandLogo({
    className = 'w-8 h-8',
    glyphClassName = 'w-5 h-5',
}: BrandLogoProps) {
    const { logoUrl, appName } = useBrand()

    if (logoUrl) {
        return (
            <img
                src={logoUrl}
                alt={`${appName} logo`}
                className={cn('object-contain rounded-lg', className)}
            />
        )
    }

    // Stock mark: gradient tile + pyramid glyph (the original TopBar logo).
    return (
        <div
            className={cn(
                'rounded-lg flex items-center justify-center',
                'bg-gradient-to-br from-accent-lineage to-accent-business',
                className,
            )}
        >
            <svg
                viewBox="0 0 24 24"
                className={cn('text-white', glyphClassName)}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
            >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
            </svg>
        </div>
    )
}
