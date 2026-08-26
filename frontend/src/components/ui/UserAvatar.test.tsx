/**
 * One avatar component, three layers.
 *
 * The provider-supplied image is optimistic: most users have none, so
 * the img 404s and MUST fall back to what the surface rendered before
 * this component existed — and must not re-404 the same user on every
 * row of every list, which is what the per-page-load miss cache is for.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { UserAvatar } from './UserAvatar'
import { resetAvatarImageCacheForTests } from '@/lib/avatarImage'

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
