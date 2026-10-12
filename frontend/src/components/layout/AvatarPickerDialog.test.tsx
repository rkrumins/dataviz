/**
 * The picker's provider-managed state.
 *
 * When a connection maps the avatar, the server refuses the write with
 * a 409 and re-applies its picture at every sign-in — so the picker
 * must say that where the person went looking, instead of offering a
 * save that cannot survive.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AvatarPickerDialog } from './AvatarPickerDialog'

const getProfile = vi.hoisted(() => vi.fn())

vi.mock('@/services/accountService', () => ({
    accountService: { getProfile },
}))

beforeEach(() => {
    vi.clearAllMocks()
})

describe('a provider-managed avatar', () => {
    it('disables the picker and says why', async () => {
        getProfile.mockResolvedValue({
            idpManagedFields: ['avatar'], idpManagedBy: 'idp_corp',
        })
        render(
            <AvatarPickerDialog isOpen onClose={() => {}} initials="AL" />,
        )
        expect(await screen.findByText(
            /identity provider supplies your picture/i,
        )).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
        expect(
            screen.getByRole('button', { name: /use my initials/i }),
        ).toBeDisabled()
    })

    it('stays fully usable for everyone else', async () => {
        getProfile.mockResolvedValue({
            idpManagedFields: ['first_name'], idpManagedBy: 'idp_corp',
        })
        render(
            <AvatarPickerDialog isOpen onClose={() => {}} initials="AL" />,
        )
        await waitFor(() => expect(getProfile).toHaveBeenCalled())
        expect(
            screen.queryByText(/identity provider supplies your picture/i),
        ).not.toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: /^save$/i }),
        ).not.toBeDisabled()
    })

    it('fails open when the profile cannot be read', async () => {
        getProfile.mockRejectedValue(new Error('offline'))
        render(
            <AvatarPickerDialog isOpen onClose={() => {}} initials="AL" />,
        )
        await waitFor(() => expect(getProfile).toHaveBeenCalled())
        expect(
            screen.getByRole('button', { name: /^save$/i }),
        ).not.toBeDisabled()
    })
})
