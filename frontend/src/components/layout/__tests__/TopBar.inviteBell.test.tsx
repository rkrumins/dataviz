/**
 * TopBar — who sees the invite-activity bell.
 *
 * The bell answers "did the links I sent work?". `GET /users/me/invite-activity`
 * is scoped to the caller's own links, so it is safe for anyone to call — but for
 * anyone who cannot CREATE an invite it returns an empty list forever, which made
 * it a permanently blank third icon in a row of look-alike icons. Creating one
 * needs `system:admin`, or `workspace:admin` on the target workspace (backend
 * `users.py::create_invite`), so that is the gate.
 */
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/store/auth'
import type { PermissionClaims } from '@/store/auth'

vi.mock('@/components/layout/BookmarksPopover', () => ({ BookmarksPopover: () => null }))
vi.mock('@/components/inbox/InboxBell', () => ({ InboxBell: () => null }))
// The real bell fires a request on mount; we only care whether it is rendered.
vi.mock('@/components/layout/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="invite-activity-bell" />,
}))

import { TopBar } from '../TopBar'

function renderWith(claims: PermissionClaims) {
  useAuthStore.setState({ permissions: claims, permissionsStatus: 'ready' })
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <TopBar onOpenCommandPalette={vi.fn()} />
    </MemoryRouter>,
  )
}

const bell = () => screen.queryByTestId('invite-activity-bell')

beforeEach(() => {
  useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} }, permissionsStatus: 'ready' })
})

describe('TopBar invite-activity bell', () => {
  it('is hidden from a user who cannot invite anyone', () => {
    renderWith({ sid: 's', global: [], ws: { w1: ['workspace:view:read'] } })
    expect(bell()).not.toBeInTheDocument()
  })

  it('is shown to a system admin', () => {
    renderWith({ sid: 's', global: ['system:admin'], ws: {} })
    expect(bell()).toBeInTheDocument()
  })

  it('is shown to an org admin', () => {
    renderWith({ sid: 's', global: ['system:org-admin'], ws: {} })
    expect(bell()).toBeInTheDocument()
  })

  it('is shown to an admin of any single workspace', () => {
    renderWith({ sid: 's', global: [], ws: { w1: ['workspace:view:read'], w2: ['workspace:admin'] } })
    expect(bell()).toBeInTheDocument()
  })

  it('stays hidden when the claims have not arrived yet, rather than flashing in', () => {
    useAuthStore.setState({
      permissions: { sid: '', global: [], ws: {} },
      permissionsStatus: 'loading',
    })
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <TopBar onOpenCommandPalette={vi.fn()} />
      </MemoryRouter>,
    )
    expect(bell()).not.toBeInTheDocument()
  })
})
