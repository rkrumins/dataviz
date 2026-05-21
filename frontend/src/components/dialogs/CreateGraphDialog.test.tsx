import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateGraphDialog } from './CreateGraphDialog'

vi.mock('@/services/versionControlService', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/versionControlService')
  >('@/services/versionControlService')
  return {
    ...actual,
    createGraph: vi.fn(),
  }
})

vi.mock('@/features/ontology/hooks/useOntologies', () => ({
  useOntologies: () => ({
    data: [
      {
        id: 'bp_pubA', name: 'Published A', version: 1,
        isPublished: true, isSystem: false, deletedAt: null,
      },
      {
        id: 'bp_draft', name: 'Draft B', version: 1,
        isPublished: false, isSystem: false, deletedAt: null,
      },
      {
        id: 'bp_basic_lineage', name: 'Basic Lineage', version: 1,
        isPublished: true, isSystem: true, deletedAt: null,
      },
    ],
    isLoading: false,
  }),
}))

import { createGraph } from '@/services/versionControlService'

const mockCreateGraph = createGraph as unknown as ReturnType<typeof vi.fn>

function render_(props?: Partial<React.ComponentProps<typeof CreateGraphDialog>>) {
  return render(
    <CreateGraphDialog
      workspaceId="ws_1"
      isOpen
      onClose={() => undefined}
      onCreated={() => undefined}
      {...props}
    />,
  )
}

describe('CreateGraphDialog', () => {
  beforeEach(() => {
    mockCreateGraph.mockReset()
    mockCreateGraph.mockResolvedValue({
      id: 'g_1', workspace_id: 'ws_1', name: 'G',
      description: null, origin: 'authored',
      schema_mode: 'schemaless', default_branch: 'main',
    })
  })

  it('defaults to schemaless and creates with no ontology', async () => {
    const user = userEvent.setup()
    render_()
    await user.type(screen.getByLabelText('Graph name'), 'Test graph')
    await user.click(screen.getByText('Create graph'))
    await waitFor(() => expect(mockCreateGraph).toHaveBeenCalledTimes(1))
    const [, body] = mockCreateGraph.mock.calls[0]
    expect(body).toMatchObject({
      name: 'Test graph',
      schema_mode: 'schemaless',
      ontology_id: null,
    })
  })

  it('Simple lineage auto-binds the seeded Basic Lineage ontology', async () => {
    const user = userEvent.setup()
    render_()
    await user.type(screen.getByLabelText('Graph name'), 'Lineage')
    await user.click(screen.getByText('Simple lineage'))
    await user.click(screen.getByText('Create graph'))
    await waitFor(() => expect(mockCreateGraph).toHaveBeenCalledTimes(1))
    const [, body] = mockCreateGraph.mock.calls[0]
    expect(body).toMatchObject({
      schema_mode: 'strict',
      ontology_id: 'bp_basic_lineage',
    })
  })

  it('Strict + no ontology selected disables Submit', async () => {
    const user = userEvent.setup()
    render_()
    await user.type(screen.getByLabelText('Graph name'), 'X')
    await user.click(screen.getByText('Strict / pick ontology'))
    const submit = screen.getByText('Create graph')
    expect(submit).toBeDisabled()
  })

  it('Strict + picked ontology submits with that id', async () => {
    const user = userEvent.setup()
    render_()
    await user.type(screen.getByLabelText('Graph name'), 'Strict graph')
    await user.click(screen.getByText('Strict / pick ontology'))
    await user.selectOptions(screen.getByLabelText('Pick ontology'), 'bp_pubA')
    await user.click(screen.getByText('Create graph'))
    await waitFor(() => expect(mockCreateGraph).toHaveBeenCalledTimes(1))
    const [, body] = mockCreateGraph.mock.calls[0]
    expect(body).toMatchObject({
      schema_mode: 'strict',
      ontology_id: 'bp_pubA',
    })
  })

  it('hides unpublished and Basic-Lineage ontologies from the picker', async () => {
    const user = userEvent.setup()
    render_()
    await user.click(screen.getByText('Strict / pick ontology'))
    const select = screen.getByLabelText('Pick ontology') as HTMLSelectElement
    const opts = Array.from(select.options).map((o) => o.value)
    expect(opts).toContain('bp_pubA')
    expect(opts).not.toContain('bp_draft')
    expect(opts).not.toContain('bp_basic_lineage')
  })

  it('empty name disables Submit', () => {
    render_()
    expect(screen.getByText('Create graph')).toBeDisabled()
  })

  it('shows the structured error when the ontology is missing', async () => {
    const user = userEvent.setup()
    const { OntologyMissingError } = await import('@/services/versionControlService')
    mockCreateGraph.mockRejectedValueOnce(new OntologyMissingError('bp_pubA'))
    render_()
    await user.type(screen.getByLabelText('Graph name'), 'X')
    await user.click(screen.getByText('Strict / pick ontology'))
    await user.selectOptions(screen.getByLabelText('Pick ontology'), 'bp_pubA')
    await user.click(screen.getByText('Create graph'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/bp_pubA/),
    )
  })

  it('calls onCreated then onClose on success', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    const onClose = vi.fn()
    render_({ onCreated, onClose })
    await user.type(screen.getByLabelText('Graph name'), 'X')
    await user.click(screen.getByText('Create graph'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
