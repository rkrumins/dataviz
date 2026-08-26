/**
 * One user avatar, for every surface that shows a person.
 *
 * Precedence: the provider-supplied image (fetched server-side at SSO
 * sign-in, served from our own origin — see ``lib/avatarImage``) over
 * the picked illustration over initials. The fallback renders as the
 * base layer with the image absolutely positioned on top, so a slow
 * load shows initials rather than a blank circle, and a 404 simply
 * never covers them. Misses are remembered per page load, so a member
 * list does not re-404 every avatar-less row on every mount.
 *
 * The wrapper owns only the circle; size and text scale come from
 * ``className`` (e.g. ``w-8 h-8 text-xs``), which is what lets the
 * existing surfaces keep their exact dimensions.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { AVATARS } from '@/components/layout/avatarIllustrations'
import {
    avatarGradient,
    avatarPaletteFor,
    initialsOf,
} from '@/lib/avatar'
import {
    avatarImageSrc,
    avatarImageState,
    rememberAvatarImage,
} from '@/lib/avatarImage'

export function UserAvatar({
    userId,
    name,
    avatarId,
    className,
    shape = 'gradient',
    fallback,
    alt,
}: {
    /** Enables the image layer; without one only fallbacks render. */
    userId?: string | null
    name: string
    /** The picked illustration id, when the surface knows it. */
    avatarId?: string | null
    /** The circle: size, text scale, rings — e.g. "w-8 h-8 text-xs". */
    className?: string
    /** Which initials family the surface uses today. */
    shape?: 'gradient' | 'palette'
    /** A surface-owned fallback, replacing the shape-derived initials. */
    fallback?: React.ReactNode
    alt?: string
}) {
    const [broken, setBroken] = useState(false)
    const showImage = Boolean(userId)
        && !broken
        && avatarImageState(userId as string) !== 'none'

    const art = avatarId
        ? AVATARS.find((a) => a.id === avatarId)
        : undefined
    const base = art
        ? (
            <span
                className={cn(
                    'flex h-full w-full items-center justify-center',
                    'rounded-full text-ink', art.bg,
                )}
            >
                {art.content('w-2/3 h-2/3')}
            </span>
        )
        : fallback ?? (shape === 'palette'
            ? (
                <span
                    className={cn(
                        'flex h-full w-full items-center justify-center',
                        'rounded-full font-semibold',
                        avatarPaletteFor(userId || name).bg,
                        avatarPaletteFor(userId || name).text,
                    )}
                >
                    {initialsOf(name)}
                </span>
            )
            : (
                <span
                    className={cn(
                        'flex h-full w-full items-center justify-center',
                        'rounded-full bg-gradient-to-br font-semibold text-white',
                        avatarGradient(name || '?'),
                    )}
                >
                    {initialsOf(name)}
                </span>
            ))

    return (
        <span
            className={cn(
                'relative inline-flex shrink-0 overflow-hidden rounded-full',
                className,
            )}
        >
            {base}
            {showImage && (
                <img
                    src={avatarImageSrc(userId as string)}
                    alt={alt ?? ''}
                    className="absolute inset-0 h-full w-full rounded-full object-cover"
                    onLoad={() => rememberAvatarImage(userId as string, 'ok')}
                    onError={() => {
                        rememberAvatarImage(userId as string, 'none')
                        setBroken(true)
                    }}
                />
            )}
        </span>
    )
}
