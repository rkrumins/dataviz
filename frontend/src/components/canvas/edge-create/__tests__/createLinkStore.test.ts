/**
 * createLinkStore.open() opens the popover only once a draft is active: when no draft can be opened
 * (editing is paused, no :manage, version control off) a link staged there would land on main.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: vi.fn(),
}))
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { useCreateLinkStore } from '../createLinkStore'

const opts = { sourceUrn: 'urn:a', anchor: { x: 1, y: 2 } }
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('useCreateLinkStore', () => {
  beforeEach(() => useCreateLinkStore.getState().close())

  it('opens once a draft is active', async () => {
    vi.mocked(ensureDraftOpen).mockResolvedValue('branch-1')
    useCreateLinkStore.getState().open(opts)
    await settle()
    expect(useCreateLinkStore.getState().isOpen).toBe(true)
    expect(useCreateLinkStore.getState().sourceUrn).toBe('urn:a')
  })

  it('stays closed when no draft can be opened', async () => {
    vi.mocked(ensureDraftOpen).mockResolvedValue(null)
    useCreateLinkStore.getState().open(opts)
    await settle()
    expect(useCreateLinkStore.getState().isOpen).toBe(false)
  })
})
