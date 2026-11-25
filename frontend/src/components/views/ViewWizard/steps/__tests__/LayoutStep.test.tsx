/**
 * LayoutStep — the template library on the wizard's Layout step.
 *
 * Applying a template is a client-side copy of layer STRUCTURE only: it never
 * carries assignments into formData.assignments (a fresh create or template
 * switch always resets them to {}), every layer gets a fresh id, and a library
 * template is recorded as where the view started. It is FITTED to this data:
 * each layer is filled with the data's own types — suggested, for the person to
 * keep or change in place — and a layer nothing fits invites them to fill it.
 * Nothing says a template "doesn't match".
 */
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

// The data source's ontology, as useDataSourceSchema reports it — mutable so a
// case can give the source an ontology, or hold it loading.
const ds = vi.hoisted(() => ({ entityTypes: [] as unknown[], rootEntityTypes: [] as string[], isLoading: false }))
const lib = vi.hoisted(() => ({ templates: [] as unknown[], isLoading: false, enabled: true }))

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: ds.entityTypes, relationshipTypes: [], rootEntityTypes: ds.rootEntityTypes, containmentEdgeTypes: [],
    isLoading: ds.isLoading, isError: false,
  }),
}))

vi.mock('@/hooks/useLayoutTemplates', () => ({
  useLayoutTemplates: () => ({ templates: lib.templates, isLoading: lib.isLoading, error: null }),
  useLayoutTemplate: () => ({ data: undefined }),
  useInvalidateLayoutTemplates: () => () => undefined,
  useLayoutTemplatesEnabled: () => lib.enabled,
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

import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'
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

/** The built-in "Analytics Pipeline" (backend/app/db/seed_templates.py): stages, not containment. */
const ANALYTICS = template({
  id: 'tpl_analytics', name: 'Analytics Pipeline',
  layers: [
    { id: 'raw', name: 'Raw', entityTypes: ['raw', 'source', 'extract'], order: 0 },
    { id: 'curated', name: 'Curated', entityTypes: ['curated', 'clean', 'validated'], order: 1 },
    { id: 'aggregated', name: 'Aggregated', entityTypes: ['aggregated', 'summary', 'metric'], order: 2 },
    { id: 'dashboard', name: 'Dashboard', entityTypes: ['dashboard', 'report', 'visualization'], order: 3 },
  ],
})

/** Domain contains System contains Dataset. */
const DSD = [
  { id: 'Domain', name: 'Domain', pluralName: 'Domains', hierarchy: { level: 0, canContain: ['System'] }, visual: { color: '#7c3aed' } },
  { id: 'System', name: 'System', pluralName: 'Systems', hierarchy: { level: 1, canContain: ['Dataset'] }, visual: { color: '#2563eb' } },
  { id: 'Dataset', name: 'Dataset', pluralName: 'Datasets', hierarchy: { level: 2, canContain: [] }, visual: { color: '#059669' } },
]

/** The layer editor's row for a layer. */
const layerRow = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement
const SUGGESTED = 'Suggested from your data'
const TO_FILL = 'Choose what fills this layer — or place entities in it by hand'

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
  ds.rootEntityTypes = []
  useSchemaStore.setState({ schema: null })
  ds.isLoading = false
  lib.templates = []
  lib.isLoading = false
  lib.enabled = true
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

  it('shows on each card how the template will look on this data, never how far it falls short', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS, MEDALLION]
    render(<Harness spy={vi.fn()} dataSourceId="ds1" />)

    const analytics = screen.getByText('Analytics Pipeline').closest('button')!
    expect(analytics).toHaveTextContent('Domains · Systems · Datasets')
    expect(analytics).toHaveTextContent('1 by hand')
    expect(screen.getByText('Medallion').closest('button')).toHaveTextContent('Filled by hand')
    expect(screen.queryByText(/Matches \d+ of|Fits your data/)).not.toBeInTheDocument()
  })

  it('applying a template fills each layer from the data, suggested for the person to keep', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    fireEvent.click(screen.getByText('Analytics Pipeline'))

    const call = spy.mock.calls[0][0]
    // Every layer stays; its stages take the hierarchy's levels in order.
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Raw', 'Curated', 'Aggregated', 'Dashboard'])
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([['Domain'], ['System'], ['Dataset'], []])
    expect(call.entityScope).toBe('all')

    expect(within(layerRow('Raw')).getByText('Domains')).toBeInTheDocument()
    expect(within(layerRow('Raw')).getByText(SUGGESTED)).toBeInTheDocument()
    expect(within(layerRow('Aggregated')).getByText(SUGGESTED)).toBeInTheDocument()
    // The one nothing fits invites filling — not a warning.
    expect(within(layerRow('Dashboard')).getByText(TO_FILL)).toBeInTheDocument()
    expect(within(layerRow('Dashboard')).queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/matches \d+ of \d+ layers/i)).not.toBeInTheDocument()
    expect(screen.getByText('Started from “Analytics Pipeline”. Refine its layers below.')).toBeInTheDocument()
  })

  it('what each layer shows follows its current types: kept, changed in place, or filled', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)
    fireEvent.click(screen.getByText('Analytics Pipeline'))

    // Kept: the types stay, the suggestion is settled.
    fireEvent.click(within(layerRow('Raw')).getByRole('button', { name: 'Keep' }))
    expect(within(layerRow('Raw')).queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(within(layerRow('Raw')).getByText('Domains')).toBeInTheDocument()
    expect(within(layerRow('Curated')).getByText(SUGGESTED)).toBeInTheDocument()

    // Changed in place: it is the person's choice now.
    fireEvent.click(within(layerRow('Curated')).getByRole('button', { name: 'Change' }))
    fireEvent.click(within(layerRow('Curated')).getByRole('button', { name: 'Domain' }))
    expect(within(layerRow('Curated')).queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(spy.mock.calls.at(-1)![0].layers[1].entityTypes).toEqual(['System', 'Domain'])

    // Filled: the invitation gives way to what fills it.
    fireEvent.click(within(layerRow('Dashboard')).getByRole('button', { name: new RegExp(TO_FILL) }))
    fireEvent.click(within(layerRow('Dashboard')).getByRole('button', { name: 'Dataset' }))
    expect(within(layerRow('Dashboard')).queryByText(TO_FILL)).not.toBeInTheDocument()
    expect(within(layerRow('Dashboard')).getByText('Datasets')).toBeInTheDocument()
  })

  it('switching templates fits the new one afresh', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS, DATA_MESH]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)
    fireEvent.click(screen.getByText('Analytics Pipeline'))

    fireEvent.click(screen.getByRole('button', { name: 'Switch template' }))
    fireEvent.click(screen.getByText('Data Mesh'))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([['Domain'], ['Dataset']])
    expect(Object.keys(call.suggestedFills)).toEqual(call.layers.map((l: { id: string }) => l.id))
    expect(within(layerRow('Data Product')).getByText(SUGGESTED)).toBeInTheDocument()
    expect(screen.queryByText('Raw', { selector: 'span' })).not.toBeInTheDocument()
    confirm.mockRestore()
  })

  it("keeps a template's types as written when the data declares none, and claims nothing", () => {
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    expect(screen.getByText('Analytics Pipeline').closest('button')).not.toHaveTextContent('by hand')
    fireEvent.click(screen.getByText('Analytics Pipeline'))

    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual(ANALYTICS.layers.map(l => l.entityTypes))
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(screen.queryByText(TO_FILL)).not.toBeInTheDocument()
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
    expect(screen.getByText('Started from “Medallion”. Refine its layers below.')).toBeInTheDocument()
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

  it('offers only what the data suggests while an admin has templates off', () => {
    lib.enabled = false
    lib.templates = [MEDALLION]
    ds.entityTypes = [
      { id: 'Domain', name: 'Domain', pluralName: 'Domains', hierarchy: { level: 0, canContain: [] }, visual: { color: '#000' } },
    ]
    render(<Harness spy={vi.fn()} dataSourceId="ds1" />)
    expect(screen.getByText('Suggested for your data')).toBeInTheDocument()
    expect(screen.queryByText('Template library')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('From your schema'))
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
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

describe('LayoutStep — a brand-new model', () => {
  it('offers one layer per top-level type, matching the roots in any case', () => {
    useSchemaStore.setState({
      schema: {
        id: 'ont', name: 'Ontology', version: '1', views: [], defaultViewId: '',
        entityTypes: DSD, relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [],
        // Spelled otherwise than the type it names: still that type.
        rootEntityTypes: ['domain'],
      } as unknown as WorkspaceSchema,
    })
    const spy = vi.fn()
    render(<Harness spy={spy} blank />)

    expect(screen.getByText('From your ontology')).toBeInTheDocument()
    expect(screen.getByText('Start empty')).toBeInTheDocument()
    fireEvent.click(screen.getByText('One layer per top-level type'))

    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Domains'])
    expect(call.layers[0].entityTypes).toEqual(['Domain'])
    expect(call.layoutTemplateId).toBe('per-root-type')
    // Its layers place by rule, which resolves only in open scope.
    expect(call.entityScope).toBe('all')
  })
})
