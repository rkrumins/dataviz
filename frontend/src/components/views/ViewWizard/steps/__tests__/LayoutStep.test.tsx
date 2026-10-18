/**
 * LayoutStep — the template library on the wizard's Layout step.
 *
 * Applying a template is a client-side copy of layer STRUCTURE only: it never
 * carries assignments into formData.assignments (a fresh create or template
 * switch always resets them to {}), every layer gets a fresh id, and a library
 * template is recorded as where the view started. Its entity types resolve
 * against THIS data's semantic layer, and what doesn't match is said, not
 * silently dropped.
 */
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

// The data source's ontology, as useDataSourceSchema reports it — mutable so a
// case can give the source an ontology, or hold it loading.
const ds = vi.hoisted(() => ({ entityTypes: [] as unknown[], isLoading: false }))
const lib = vi.hoisted(() => ({ templates: [] as unknown[], isLoading: false }))

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({ entityTypes: ds.entityTypes, isLoading: ds.isLoading, isError: false }),
}))

vi.mock('@/hooks/useLayoutTemplates', () => ({
  useLayoutTemplates: () => ({ templates: lib.templates, isLoading: lib.isLoading, error: null }),
  useLayoutTemplate: () => ({ data: undefined }),
  useInvalidateLayoutTemplates: () => () => undefined,
}))

// The workspaces store transitively imports @/main (createRoot) — mock it so the module graph
// stays test-safe (mirrors ViewWizard.test.tsx). The save-as dialog's audience picker reads it.
vi.mock('@/store/workspaces', () => {
  const state = { activeWorkspaceId: 'ws1', workspaces: [] }
  const useWorkspacesStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useWorkspacesStore }
})

import { LayoutStep } from '../LayoutStep'
import type { WizardFormData } from '../../ViewWizard'

const layoutTypes = [
  { id: 'graph' as const, label: 'Graph', icon: null, description: '', features: [] },
  { id: 'hierarchy' as const, label: 'Hierarchy', icon: null, description: '', features: [] },
  { id: 'reference' as const, label: 'Context View', icon: null, description: '', features: [] },
]

function template(over: Partial<LayoutTemplate>): LayoutTemplate {
  return {
    id: 'tpl', name: 'Template', description: '', category: null, visibility: 'enterprise',
    builtIn: true, hidden: false, workspaceId: null, workspaceName: null, layers: [],
    createdBy: null, createdAt: '', updatedAt: '', usageCount: 0, grantCount: null, version: 1,
    access: { via: 'builtin', canEdit: false, canDelete: false, canShare: false, canHide: false },
    ...over,
  }
}

const MEDALLION = template({
  id: 'tpl_medallion', name: 'Medallion',
  layers: [
    { id: 'bronze', name: 'Bronze', color: '#cd7f32', entityTypes: [], order: 0 },
    { id: 'silver', name: 'Silver', color: '#c0c0c0', entityTypes: [], order: 1, showUnassigned: true },
    { id: 'gold', name: 'Gold', color: '#ffd700', entityTypes: [], order: 2 },
  ],
})

const DATA_MESH = template({
  id: 'tpl_mesh', name: 'Data Mesh',
  layers: [
    { id: 'domain', name: 'Domain', entityTypes: ['domain', 'bounded-context'], order: 0 },
    { id: 'product', name: 'Data Product', entityTypes: ['data-product', 'dataset', 'DATASET', 'table'], order: 1 },
  ],
})

function makeFormData(overrides: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'Test view',
    description: '',
    icon: 'Layout',
    visibility: 'private',
    tags: [],
    layoutType: 'reference',
    layers: [],
    assignments: { 'urn:stale': { layerId: 'stale-layer', inheritsChildren: true } },
    visibleEntityTypes: [],
    visibleRelationshipTypes: [],
    advancedFilters: [],
    isValid: true,
    ...overrides,
  }
}

/** The step with real form state, so what it applies is what it then renders. */
function Harness({ spy, ...props }: { spy: (u: Partial<WizardFormData>) => void } & Partial<Parameters<typeof LayoutStep>[0]>) {
  const [formData, setFormData] = useState(makeFormData())
  return (
    <MemoryRouter>
      <LayoutStep
        formData={formData}
        updateFormData={u => { spy(u); setFormData(f => ({ ...f, ...u })) }}
        layoutTypes={layoutTypes}
        {...props}
      />
    </MemoryRouter>
  )
}

afterEach(() => {
  ds.entityTypes = []
  ds.isLoading = false
  lib.templates = []
  lib.isLoading = false
})

describe('LayoutStep — the template library', () => {
  it('applying a library template copies structure, never assignments, and records it', () => {
    lib.templates = [MEDALLION]
    const spy = vi.fn()
    render(<Harness spy={spy} />)

    fireEvent.click(screen.getByText('Medallion'))

    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Bronze', 'Silver', 'Gold'])
    // Every structural field survives; the ids are the new view's own.
    expect(call.layers[1].showUnassigned).toBe(true)
    expect(call.layers.map((l: { id: string }) => l.id)).not.toContain('bronze')
    expect(call.assignments).toEqual({})
    expect(call.contextModelId).toBe('tpl_medallion')
    expect(call.contextModelVersion).toBe(1)
    expect(call.layoutTemplateId).toBe('tpl_medallion')
    // Each column remembers the template layer it came from, for later versions.
    expect(call.layers.map((l: { templateLayerId: string }) => l.templateLayerId)).toEqual(['bronze', 'silver', 'gold'])
  })

  it("resolves a template's types against the data source and names what didn't match", () => {
    ds.entityTypes = [
      { id: 'Dataset', name: 'Dataset', pluralName: 'Datasets', hierarchy: { level: 0, canContain: [] } },
      { id: 'System', name: 'System', pluralName: 'Systems', hierarchy: { level: 0, canContain: [] } },
    ]
    lib.templates = [DATA_MESH]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    // The card says how well it fits before anyone applies it.
    expect(screen.getByText('Matches 1 of 2 layers')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Data Mesh'))

    const call = spy.mock.calls[0][0]
    // A layer whose types the ontology lacks survives, empty; a declared type
    // takes the ontology's spelling, once.
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Domain', 'Data Product'])
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([[], ['Dataset']])
    expect(screen.getByRole('status')).toHaveTextContent('matches 1 of 2 layers')
    expect(screen.getByRole('status')).toHaveTextContent('bounded-context, data-product, domain, table')
  })

  it('waits for the ontology before a template can be applied', () => {
    ds.isLoading = true
    lib.templates = [MEDALLION]
    render(<Harness spy={vi.fn()} dataSourceId="ds1" />)
    expect(screen.queryByText('Medallion')).not.toBeInTheDocument()
  })

  it('applies the template it was opened from, once', () => {
    lib.templates = [MEDALLION, DATA_MESH]
    const spy = vi.fn()
    render(<Harness spy={spy} initialTemplateId="tpl_medallion" />)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].contextModelId).toBe('tpl_medallion')
    expect(screen.getByRole('status')).toHaveTextContent('Started from "Medallion"')
  })

  it("starts from the workspace's default, with one click back to an empty canvas", () => {
    lib.templates = [MEDALLION]
    const spy = vi.fn()
    const applied = vi.fn()
    render(
      <Harness
        spy={spy}
        initialTemplateId="tpl_medallion"
        onInitialTemplateApplied={applied}
        workspaceDefault={{ templateId: 'tpl_medallion', workspaceName: 'Finance' }}
      />,
    )
    expect(applied).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/start from this layout/).closest('[role="status"]'))
      .toHaveTextContent('New views in Finance start from this layout.')

    fireEvent.click(screen.getByRole('button', { name: 'Start empty instead' }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ layers: [], contextModelId: undefined }))
    expect(screen.queryByText(/start from this layout/)).not.toBeInTheDocument()
    expect(screen.getByText('Choose a starting template')).toBeInTheDocument()
  })

  it('a suggestion from the data itself is not recorded as a library template', () => {
    lib.templates = [MEDALLION]
    ds.entityTypes = [
      { id: 'Domain', name: 'Domain', pluralName: 'Domains', hierarchy: { level: 0, canContain: [] }, visual: { color: '#000' } },
    ]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    fireEvent.click(screen.getByText('From your schema'))
    expect(spy.mock.calls[0][0].contextModelId).toBeUndefined()
    expect(spy.mock.calls[0][0].contextModelVersion).toBeUndefined()
    expect(spy.mock.calls[0][0].assignments).toEqual({})
  })
})
