/**
 * NewSourceTargetPanel — a package's new data source as the Target step describes it. Pinned here:
 * the label and graph name start as the package's (the wizard marks the graph name as its copy:
 * `lineage_copy`), the name checked on the connection chosen (and moved to a free one if that's taken); both are
 * the person's to change; and someone who may not create data sources in the workspace is told.
 */
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkMock = vi.fn()
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  checkBlankGraphName: (...a: unknown[]) => checkMock(...a),
}))

import { NewSourceTargetPanel, type NewSourceDraft } from '../NewSourceTargetPanel'

let latest: NewSourceDraft = {}

function Panel({ providerId = 'p1', allowed = true }: { providerId?: string | null; allowed?: boolean }) {
  const [value, setValue] = useState<NewSourceDraft>({})
  latest = value
  return (
    <NewSourceTargetPanel value={value} onChange={(patch) => setValue(prev => ({ ...prev, ...patch }))}
      workspaceId="ws1" providerId={providerId} providerName="Falkor prod"
      defaults={{ label: 'Lineage', graphName: 'lineage_copy' }} allowed={allowed} />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  latest = {}
})

describe('NewSourceTargetPanel', () => {
  it('starts from the package’s label and graph name, as its copy', async () => {
    checkMock.mockResolvedValue({ available: true, normalized: 'lineage_copy' })
    render(<Panel />)
    expect(screen.getByLabelText('Label of the new data source')).toHaveValue('Lineage')
    expect(screen.getByLabelText('Graph name of the new data source')).toHaveValue('lineage_copy')
    expect(screen.getByText('on Falkor prod')).toBeInTheDocument()
    await waitFor(() => expect(latest).toMatchObject({ graphName: 'lineage_copy', graphNameAvailable: true }))
    expect(checkMock).toHaveBeenCalledWith('ws1', 'p1', 'lineage_copy')
  })

  it('checks nothing until a connection is chosen', async () => {
    render(<Panel providerId={null} />)
    expect(screen.getByText(/Choose a connection below to check it’s free there/)).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 450))
    expect(checkMock).not.toHaveBeenCalled()
  })

  it('moves to a free name when its copy’s name is taken, and says so', async () => {
    checkMock.mockImplementation(async (_ws: string, _p: string, name: string) => (name === 'lineage_copy'
      ? { available: false, normalized: name, reason: 'Taken', suggestion: 'lineage_copy_2' }
      : { available: true, normalized: name }))
    render(<Panel />)
    expect(await screen.findByText(/is already taken on this connection, so we picked/)).toBeInTheDocument()
    expect(screen.getByLabelText('Graph name of the new data source')).toHaveValue('lineage_copy_2')
  })

  it('offers the free name for a typed one that is taken, and keeps the label typed', async () => {
    checkMock.mockImplementation(async (_ws: string, _p: string, name: string) => (name === 'finance'
      ? { available: false, normalized: name, reason: 'This name is taken.', suggestion: 'finance_2' }
      : { available: true, normalized: name }))
    render(<Panel />)
    fireEvent.change(screen.getByLabelText('Label of the new data source'), { target: { value: 'Finance copy' } })
    fireEvent.change(screen.getByLabelText('Graph name of the new data source'), { target: { value: 'finance' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Use finance_2' }))
    await waitFor(() => expect(latest).toMatchObject({ label: 'Finance copy', graphName: 'finance_2', graphNameAvailable: true }))
  })

  it('asks for a label', () => {
    render(<Panel providerId={null} />)
    fireEvent.change(screen.getByLabelText('Label of the new data source'), { target: { value: '  ' } })
    expect(screen.getByText('Give it a label.')).toBeInTheDocument()
  })

  it('says when the person may not create data sources in the workspace', () => {
    render(<Panel providerId={null} allowed={false} />)
    expect(screen.getByText(/needs permission to manage its data sources/)).toBeInTheDocument()
  })
})
