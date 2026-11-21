/**
 * ReviewStep — Save for reuse: the change under review kept in the view's library, named inline, for
 * people who can edit the library. A change aimed at entities picked by id can't be kept, and the
 * button says why.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ put: vi.fn() }))
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
  putReusableChange: api.put,
}))

import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { OpDraft, ScopeMode, TargetPreset } from '../opModel'
import { ReviewStep } from '../ReviewStep'

const op: OpDraft = { kind: 'set', key: 'owner', to: '', value: 'data-team', onConflict: 'skip' }

function review(preset: TargetPreset, scopeMode: ScopeMode = 'view') {
  render(
    <ReviewStep op={op} preset={preset} scopeMode={scopeMode} counts={null} impact={null} exact={false}
      preview={null} previewLoading={false} sample={null} sampleLoading={false} stagedCount={0} />,
  )
}
const saveButton = () => screen.getByRole('button', { name: /Save for reuse/ })

beforeEach(() => {
  api.put.mockReset().mockImplementation(async (_view: string, id: string, body: object) => ({ id, ...body }))
  useViewLibraryStore.setState({ viewId: 'v1', branchId: null, status: 'ready', canEdit: true, reusableChanges: [] })
})

describe('Save for reuse', () => {
  it('keeps the change and where it reaches, named inline', async () => {
    const user = userEvent.setup()
    review({ kind: 'hasKey', key: 'owner' }, 'data_source')
    await user.click(saveButton())
    const name = screen.getByRole('textbox', { name: 'Name' })
    // Named after the change until it is named otherwise.
    expect(name).toHaveValue('Set owner')
    await user.clear(name)
    await user.type(name, 'Own every entity')
    await user.type(screen.getByRole('textbox', { name: /Description/ }), 'After each import')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.put).toHaveBeenCalledWith('v1', expect.stringMatching(/^change/), {
      name: 'Own every entity', description: 'After each import',
      op: { kind: 'set', key: 'owner', value: 'data-team' },
      target: { kind: 'hasKey', key: 'owner', scopeMode: 'data_source' },
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Kept for reuse as “Own every entity”')
    expect(useViewLibraryStore.getState().reusableChanges.map((r) => r.name)).toEqual(['Own every entity'])
  })

  it('keeps a layer by its name', async () => {
    const user = userEvent.setup()
    review({ kind: 'layer', layerId: 'L2', name: 'Silver' })
    await user.click(saveButton())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.put.mock.calls[0][2].target).toEqual({ kind: 'layer', layerName: 'Silver', scopeMode: 'view' })
  })

  it('is off for a selection, and says why', async () => {
    const user = userEvent.setup()
    review({ kind: 'selection', ids: ['u1', 'u2'] })
    expect(saveButton()).toBeDisabled()
    await user.hover(saveButton().parentElement!)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Can’t keep this for reuse')
    expect(tip).toHaveTextContent(/A selection is the entities picked now/)
  })

  it('is off for picked relationships, and says why', async () => {
    const user = userEvent.setup()
    review({ kind: 'relationships', ids: ['e1'] })
    expect(saveButton()).toBeDisabled()
    await user.hover(saveButton().parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Use a Connections search/)
  })

  it('says what went wrong, and keeps the form to change the name', async () => {
    const user = userEvent.setup()
    api.put.mockRejectedValueOnce(new Error("A reusable change named 'Set owner' is already saved in this view."))
    review({ kind: 'view' })
    await user.click(saveButton())
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/already saved in this view — change the name, or try again/)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
  })

  it('is not offered to someone who can’t edit the view’s library', () => {
    useViewLibraryStore.setState({ canEdit: false })
    review({ kind: 'view' })
    expect(screen.queryByRole('button', { name: /Save for reuse/ })).not.toBeInTheDocument()
  })
})
