/**
 * One avatar component, three layers.
 *
 * The provider-supplied image is optimistic: most users have none, so
 * the img 404s and MUST fall back to what the surface rendered before
 * this component existed — and must not re-404 the same user on every
 * row of every list, which is what the per-page-load miss cache is for.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserAvatar } from './UserAvatar'
import {
    bumpAvatarCache,
    rememberAvatarImage,
    resetAvatarImageCacheForTests,
} from '@/lib/avatarImage'

beforeEach(() => { resetAvatarImageCacheForTests() })

describe('UserAvatar', () => {
    it('points the image at the same-origin avatar endpoint', () => {
        const { container } = render(
            <UserAvatar userId="usr_1" name="Ada Lovelace" />,
        )
        const img = container.querySelector('img')
        expect(img).not.toBeNull()
        expect(img!.getAttribute('src')).toBe('/api/v1/users/usr_1/avatar')
        // The initials sit underneath, so a slow load is never a blank
        // circle.
        expect(screen.getByText('AL')).toBeInTheDocument()
    })

    it('falls back to initials on error, and remembers the miss', () => {
        const first = render(
            <UserAvatar userId="usr_2" name="Ada Lovelace" />,
        )
        const img = first.container.querySelector('img')!
        fireEvent.error(img)
        expect(first.container.querySelector('img')).toBeNull()
        expect(screen.getByText('AL')).toBeInTheDocument()

        // A second mount of the same user skips the request entirely.
        const second = render(
            <UserAvatar userId="usr_2" name="Ada Lovelace" />,
        )
        expect(second.container.querySelector('img')).toBeNull()
    })

    it('renders the picked illustration when there is no image', () => {
        const { container } = render(
            <UserAvatar name="Ada Lovelace" avatarId="cat" />,
        )
        expect(container.querySelector('img')).toBeNull()
        expect(container.querySelector('svg')).not.toBeNull()
    })

    it('renders plain initials with no userId and no illustration', () => {
        const { container } = render(<UserAvatar name="Grace Hopper" />)
        expect(container.querySelector('img')).toBeNull()
        expect(screen.getByText('GH')).toBeInTheDocument()
    })

    it('honours a surface-owned fallback', () => {
        render(
            <UserAvatar
                name="Ada Lovelace"
                fallback={<span data-testid="custom">A.</span>}
            />,
        )
        expect(screen.getByTestId('custom')).toBeInTheDocument()
    })

    it('keeps the palette family for chip-style surfaces', () => {
        const { container } = render(
            <UserAvatar name="Ada Lovelace" shape="palette" />,
        )
        expect(container.innerHTML).not.toContain('bg-gradient-to-br')
    })
})

describe('appearing without a hard refresh', () => {
    afterEach(() => { vi.useRealTimers() })

    it('a sign-in bump forgets the miss and versions the URL', () => {
        // The exact case that used to need a hard refresh: the picture
        // was stored at sign-in, but the SPA remembered the earlier 404
        // for the rest of the page load.
        rememberAvatarImage('usr_5', 'none')
        const first = render(<UserAvatar userId="usr_5" name="Ada L" />)
        expect(first.container.querySelector('img')).toBeNull()

        bumpAvatarCache()
        const second = render(<UserAvatar userId="usr_5" name="Ada L" />)
        const img = second.container.querySelector('img')
        expect(img).not.toBeNull()
        // The version is what gets past the browser's cached 404 too.
        expect(img!.getAttribute('src')).toBe('/api/v1/users/usr_5/avatar?v=1')
    })

    it('a bump retries a failed image in the same mounted component', () => {
        const { container, rerender } = render(
            <UserAvatar userId="usr_6" name="Ada L" />,
        )
        fireEvent.error(container.querySelector('img')!)
        expect(container.querySelector('img')).toBeNull()

        bumpAvatarCache()
        rerender(<UserAvatar userId="usr_6" name="Ada L" />)
        expect(container.querySelector('img')).not.toBeNull()
    })

    it('a remembered miss expires on its own', () => {
        // Freshly mounted surfaces retry after the endpoint's own 404
        // cache window, so a mid-session picture is at most a minute
        // from appearing even with no sign-in event.
        vi.useFakeTimers()
        rememberAvatarImage('usr_7', 'none')
        const before = render(<UserAvatar userId="usr_7" name="Ada L" />)
        expect(before.container.querySelector('img')).toBeNull()

        vi.advanceTimersByTime(61_000)
        const after = render(<UserAvatar userId="usr_7" name="Ada L" />)
        expect(after.container.querySelector('img')).not.toBeNull()
    })
})
