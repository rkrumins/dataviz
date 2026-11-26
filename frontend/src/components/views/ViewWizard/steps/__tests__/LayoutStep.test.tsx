/**
 * LayoutStep — the template library on the wizard's Layout step.
 *
 * Applying a template is a client-side copy of layer STRUCTURE only: it never
 * carries assignments into formData.assignments (a fresh create or template
 * switch always resets them to {}), every layer gets a fresh id, and a library
 * template is recorded as where the view started. It comes in as AUTHORED;
 * filling its open layers from the graph is an offer the person takes — all at
 * once from the header, or one layer at a time — and keeps or changes in place.
 * Nothing says a template "doesn't match", and cards make no claim about data.
 */
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

// The data source's ontology, as useDataSourceSchema reports it — mutable so a
// case can give the source an ontology, or hold it loading.
const ds = vi.hoisted(() => ({ entityTypes: [] as unknown[], rootEntityTypes: [] as string[], isLoading: false }))
const lib = vi.hoisted(() => ({ templates: [] as unknown[], isLoading: false, enabled: true }))
// The source's top-level entities per root type, as the Layout step reads them.
const top = vi.hoisted(() => ({ byType: new Map<string, unknown>(), isLoading: false }))

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: ds.entityTypes, relationshipTypes: [], rootEntityTypes: ds.rootEntityTypes, containmentEdgeTypes: [],
    isLoading: ds.isLoading, isError: false,
  }),
}))

vi.mock('../../useTopLevelEntities', async importOriginal => ({
  ...(await importOriginal<typeof import('../../useTopLevelEntities')>()),
  useTopLevelEntities: () => top,
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
import { usePersonaStore } from '@/store/persona'
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

const TEAM = { id: 'Team', name: 'Team', pluralName: 'Teams', hierarchy: { level: 0, canContain: [] }, visual: { color: '#ea580c' } }

/** A root type's top-level entities: these names, and how many there are in all. */
function ofType(type: string, names: string[], count = names.length) {
  return {
    entities: names.slice(0, 201).map(name => ({ urn: `urn:${type}:${name}`, name, type, childCount: 2 })),
    count, over: count > 200,
  }
}
const named = (n: number, prefix = 'Unit') => Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1).padStart(3, '0')}`)
const PER_TYPE = 'One layer per top-level type'
const PER_ENTITY = 'One column per top-level entity'

/** The layer editor's row for a layer. */
const layerRow = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement
const SUGGESTED = 'Suggested from your data'
const TO_FILL = 'Choose what fills this layer — or place entities in it by hand'
const SUGGEST_ALL = 'Suggest from your graph'

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
function Harness({ spy, initial, ...props }: {
  spy: (u: Partial<WizardFormData>) => void
  /** The form as the step opens on it (an edit's view, a template already applied). */
  initial?: Partial<WizardFormData>
} & Partial<Parameters<typeof LayoutStep>[0]>) {
  const [formData, setFormData] = useState(makeFormData(initial))
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
  top.byType = new Map()
  top.isLoading = false
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

  it("library cards show the template's own layers and make no claim about the data", () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS, MEDALLION]
    render(<Harness spy={vi.fn()} dataSourceId="ds1" />)

    const analytics = screen.getByText('Analytics Pipeline').closest('button')!
    expect(analytics).toHaveTextContent('Raw')
    expect(analytics).not.toHaveTextContent('Domains')
    expect(analytics).not.toHaveTextContent('by hand')
    expect(screen.queryByText(/Matches \d+ of|Fits your data|Filled by hand/)).not.toBeInTheDocument()
  })

  it('applying a template keeps its layers as authored, and offers what the graph could fill', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS, DATA_MESH]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    fireEvent.click(screen.getByText('Analytics Pipeline'))

    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Raw', 'Curated', 'Aggregated', 'Dashboard'])
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([[], [], [], []])
    expect(call.suggestedFills).toBeUndefined()
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument()
    // Every open layer invites filling; where the graph has something, a quiet offer.
    expect(within(layerRow('Raw')).getByText(TO_FILL)).toBeInTheDocument()
    expect(within(layerRow('Raw')).getByRole('button', { name: 'Fill Raw with Domains' })).toBeInTheDocument()
    expect(within(layerRow('Dashboard')).getByText(TO_FILL)).toBeInTheDocument()
    expect(within(layerRow('Dashboard')).queryByRole('button', { name: /^Fill Dashboard/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Started from “Analytics Pipeline”. Refine its layers below.')).toBeInTheDocument()
  })

  it('a layer takes the graph\'s offer on a click, marked for the person to keep or change', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)
    fireEvent.click(screen.getByText('Analytics Pipeline'))

    fireEvent.click(within(layerRow('Raw')).getByRole('button', { name: 'Fill Raw with Domains' }))

    expect(spy.mock.calls.at(-1)![0].layers[0].entityTypes).toEqual(['Domain'])
    expect(within(layerRow('Raw')).getByText('Domains')).toBeInTheDocument()
    expect(within(layerRow('Raw')).getByText(SUGGESTED)).toBeInTheDocument()
    expect(within(layerRow('Raw')).queryByText(TO_FILL)).not.toBeInTheDocument()
    // Kept: the types stay, the suggestion is settled.
    fireEvent.click(within(layerRow('Raw')).getByRole('button', { name: 'Keep' }))
    expect(within(layerRow('Raw')).queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(within(layerRow('Raw')).getByText('Domains')).toBeInTheDocument()
  })

  it('"Suggest from your graph" previews a fill for every open layer, and applies what is ticked', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)
    fireEvent.click(screen.getByText('Analytics Pipeline'))

    fireEvent.click(screen.getByRole('button', { name: SUGGEST_ALL }))
    const preview = screen.getByRole('region', { name: 'Suggested from your graph' })
    expect(within(preview).getByRole('checkbox', { name: 'Raw: Domains' })).toBeChecked()
    expect(within(preview).getByRole('checkbox', { name: 'Curated: Systems' })).toBeChecked()
    expect(within(preview).getByRole('checkbox', { name: 'Aggregated: Datasets' })).toBeChecked()
    expect(within(preview).queryByRole('checkbox', { name: /^Dashboard/ })).not.toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)   // nothing applied before it is confirmed

    fireEvent.click(within(preview).getByRole('checkbox', { name: 'Curated: Systems' }))
    fireEvent.click(within(preview).getByRole('button', { name: 'Apply 2 suggestions' }))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([['Domain'], [], ['Dataset'], []])
    expect(call.entityScope).toBe('all')
    expect(screen.queryByRole('region', { name: 'Suggested from your graph' })).not.toBeInTheDocument()
    expect(within(layerRow('Raw')).getByText(SUGGESTED)).toBeInTheDocument()
    expect(within(layerRow('Aggregated')).getByText(SUGGESTED)).toBeInTheDocument()

    // Changed in place: it is the person's choice now.
    fireEvent.click(within(layerRow('Aggregated')).getByRole('button', { name: 'Change' }))
    fireEvent.click(within(layerRow('Aggregated')).getByRole('button', { name: 'System' }))
    expect(within(layerRow('Aggregated')).queryByText(SUGGESTED)).not.toBeInTheDocument()
  })

  it('switching templates brings the new one in as authored', () => {
    ds.entityTypes = DSD
    lib.templates = [ANALYTICS, DATA_MESH]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)
    fireEvent.click(screen.getByText('Analytics Pipeline'))
    fireEvent.click(within(layerRow('Raw')).getByRole('button', { name: 'Fill Raw with Domains' }))

    fireEvent.click(screen.getByRole('button', { name: 'Switch template' }))
    fireEvent.click(screen.getByText('Data Mesh'))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual([['Domain'], ['Dataset']])
    expect(call.suggestedFills).toBeUndefined()
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument()
    confirm.mockRestore()
  })

  it("keeps a template's types as written when the data declares none, and claims nothing", () => {
    lib.templates = [ANALYTICS]
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    fireEvent.click(screen.getByText('Analytics Pipeline'))

    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { entityTypes: string[] }) => l.entityTypes)).toEqual(ANALYTICS.layers.map(l => l.entityTypes))
    expect(screen.queryByText(SUGGESTED)).not.toBeInTheDocument()
    expect(screen.queryByText(TO_FILL)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: SUGGEST_ALL })).not.toBeInTheDocument()
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
    // Root types come from the ontology alone: chips, with no counts to show.
    const card = screen.getByRole('group', { name: PER_TYPE })
    expect(within(card).getByRole('button', { name: 'Domain' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('group', { name: PER_ENTITY })).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Create 1 layer' }))

    const call = spy.mock.calls[0][0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Domains'])
    expect(call.layers[0].entityTypes).toEqual(['Domain'])
    expect(call.layoutTemplateId).toBe('per-root-type')
    // Its layers place by rule, which resolves only in open scope.
    expect(call.entityScope).toBe('all')
  })
})

describe('LayoutStep — layers from the top of the data', () => {
  it('one layer per top-level type uses every root type, and makes only the ones chosen', () => {
    ds.entityTypes = [...DSD, TEAM]
    top.byType = new Map([['Domain', ofType('Domain', named(5))], ['Team', ofType('Team', named(3))]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    const card = screen.getByRole('group', { name: PER_TYPE })
    expect(within(card).getByText('Recommended')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Domain · 5' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(card).getByRole('button', { name: 'Team · 3' })).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveTextContent('2 layers: Domains, Teams')

    fireEvent.click(within(card).getByRole('button', { name: 'Team · 3' }))
    expect(card).toHaveTextContent('1 layer: Domains')
    fireEvent.click(within(card).getByRole('button', { name: 'Create 1 layer' }))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Domains'])
    expect(call.layers[0].entityTypes).toEqual(['Domain'])
    expect(call.entityScope).toBe('all')
  })

  it('a single root type with a few entities recommends a column each, and lets some be left out', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', ['Finance', 'Marketing', 'Ops', 'Sales', 'Support'])]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    const card = screen.getByRole('group', { name: PER_ENTITY })
    expect(within(card).getByText('Recommended')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: PER_TYPE })).queryByText('Recommended')).not.toBeInTheDocument()
    expect(within(card).getByText('One column per Domain')).toBeInTheDocument()
    expect(card).toHaveTextContent('5 columns: Finance, Marketing, Ops, …')
    expect(within(card).getByRole('button', { name: 'Domain · 5' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(card).getByRole('button', { name: 'Create 5 columns' }))
    expect(within(card).getByRole('checkbox', { name: 'Finance' })).toBeChecked()
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Ops' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Create 4 columns' }))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Finance', 'Marketing', 'Sales', 'Support'])
    expect(call.layers.map((l: { anchorUrn: string }) => l.anchorUrn)).toEqual(
      ['urn:Domain:Finance', 'urn:Domain:Marketing', 'urn:Domain:Sales', 'urn:Domain:Support'])
    expect(Object.keys(call.assignments).sort()).toEqual(call.layers.map((l: { anchorUrn: string }) => l.anchorUrn).sort())
    expect(call.entityScope).toBe('curated')
    expect(call.layoutTemplateId).toBe('per-entity')
  })

  it('a single entity makes one column for it, at once', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', ['Finance'])]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    const card = screen.getByRole('group', { name: PER_ENTITY })
    expect(within(card).getByText('One column for Finance')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Create 1 column' }))
    expect(spy.mock.calls.at(-1)![0].layers.map((l: { name: string }) => l.name)).toEqual(['Finance'])
  })

  it('more than 24 columns asks first, with no list to pick from', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', named(30))]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    const card = screen.getByRole('group', { name: PER_ENTITY })
    fireEvent.click(within(card).getByRole('button', { name: 'Create 30 columns' }))
    expect(spy).not.toHaveBeenCalled()
    expect(card).toHaveTextContent('30 columns make a wide view')
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Create 30 columns' }))
    expect(spy.mock.calls.at(-1)![0].layers).toHaveLength(30)
  })

  it('more than 200 is not offered, and says why', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', named(201), 1204)]])
    render(<Harness spy={vi.fn()} dataSourceId="ds1" />)

    expect(screen.queryByRole('group', { name: PER_ENTITY })).not.toBeInTheDocument()
    expect(screen.getByText(/1,204 Domains are too many to read side by side/)).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: PER_TYPE })).getByText('Recommended')).toBeInTheDocument()
  })

  it('with several root types, a column per entity is offered too, counted on the types chosen', () => {
    ds.entityTypes = [...DSD, TEAM]
    top.byType = new Map([['Domain', ofType('Domain', named(20, 'Domain'))], ['Team', ofType('Team', named(10, 'Team'))]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" />)

    const card = screen.getByRole('group', { name: PER_ENTITY })
    expect(within(card).queryByText('Recommended')).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: PER_TYPE })).getByText('Recommended')).toBeInTheDocument()
    // The largest type to begin with, alone.
    expect(within(card).getByRole('button', { name: 'Domain · 20' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(card).getByRole('button', { name: 'Team · 10' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(within(card).getByRole('button', { name: 'Team · 10' }))
    expect(within(card).getByText('One column per top-level entity (30)')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Create 30 columns' }))
    // Thirty in all is over the line, whichever types they come from.
    expect(card).toHaveTextContent('30 columns make a wide view')
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('LayoutStep — what fills each layer', () => {
  const DOMAINS = { id: 'l1', name: 'Domains', color: '#7c3aed', description: '', entityTypes: ['Domain'], order: 0 }
  const SOURCE = (name: string) => `What fills ${name}`
  const MAPPED_LINE = 'This column is Finance’s contents. Adding or dropping there puts things inside Finance — changes the data.'
  // A mapped layer's row names its entity beside its own name: the header's comes first.
  const header = (name: string) => screen.getAllByText(name, { selector: 'span' })[0]
  const open = (name: string) => fireEvent.click(header(name))
  const layerRow = (name: string) => header(name).closest('li') as HTMLElement
  const sourceOf = (name: string) => screen.getByRole('radiogroup', { name: SOURCE(name) })
  const labels = (list: HTMLElement) => within(list).getAllByRole('option').map(o => o.querySelector('[data-option-label]')!.textContent)

  beforeEach(() => usePersonaStore.setState({ mode: 'technical' }))
  afterEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('says what fills a layer, and switching to hand-picked says what it drops, with an undo', () => {
    ds.entityTypes = DSD
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" initial={{ layers: [DOMAINS], assignments: {} }} />)
    open('Domains')

    const source = sourceOf('Domains')
    expect(within(source).getByRole('radio', { name: 'By type' })).toHaveAttribute('aria-checked', 'true')
    expect(within(source).getByRole('radio', { name: 'Hand-picked' })).toHaveAttribute('aria-checked', 'false')
    expect(within(source).getByRole('radio', { name: 'Mapped to an entity' })).toHaveAttribute('aria-checked', 'false')
    expect(within(layerRow('Domains')).getByText(
      'A column for Domains — adding there creates a Domain. Dropping on its header only changes this view.')).toBeInTheDocument()

    fireEvent.click(within(source).getByRole('radio', { name: 'Hand-picked' }))
    expect(spy.mock.calls.at(-1)![0].layers[0].entityTypes).toEqual([])
    expect(within(source).getByRole('radio', { name: 'Hand-picked' })).toHaveAttribute('aria-checked', 'true')
    const notice = within(layerRow('Domains')).getByRole('status')
    expect(notice).toHaveTextContent('No longer fills with Domains — it holds only what’s placed in it.')
    expect(within(layerRow('Domains')).getByText('Holds only what you place in it, on the next step or on the canvas.')).toBeInTheDocument()

    fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }))
    expect(spy.mock.calls.at(-1)![0].layers[0].entityTypes).toEqual(['Domain'])
    expect(within(source).getByRole('radio', { name: 'By type' })).toHaveAttribute('aria-checked', 'true')
    expect(within(layerRow('Domains')).queryByRole('status')).not.toBeInTheDocument()
  })

  it('maps a layer to one of the top-level entities, clearing its types, and says what the column is now', () => {
    ds.entityTypes = [...DSD, TEAM]
    top.byType = new Map([['Domain', ofType('Domain', ['Finance', 'Marketing'])], ['Team', ofType('Team', ['Platform'])]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" initial={{ layers: [DOMAINS], assignments: {} }} />)
    open('Domains')

    fireEvent.click(within(sourceOf('Domains')).getByRole('radio', { name: 'Mapped to an entity' }))
    // Nothing changes before an entity is picked — but it says what mapping will drop, and why.
    expect(spy).not.toHaveBeenCalled()
    expect(within(layerRow('Domains')).getByText(
      'Mapping it stops it filling with Domains: a type rule would pull every Domain into the column.')).toBeInTheDocument()
    const list = within(layerRow('Domains')).getByRole('listbox', { name: 'Top-level entities' })
    expect(labels(list)).toEqual(['Finance', 'Marketing', 'Platform'])
    expect(within(list).getByRole('option', { name: /Platform/ })).toHaveTextContent('Team')
    fireEvent.change(within(layerRow('Domains')).getByRole('combobox', { name: 'Search for an entity to map it to' }), { target: { value: 'fin' } })
    expect(labels(list)).toEqual(['Finance'])
    fireEvent.mouseDown(within(list).getByRole('option', { name: /Finance/ }))

    const call = spy.mock.calls.at(-1)![0]
    expect(call.layers[0]).toMatchObject({ id: 'l1', name: 'Domains', anchorUrn: 'urn:Domain:Finance', entityTypes: [] })
    expect(call.assignments['urn:Domain:Finance']).toMatchObject({ layerId: 'l1', inheritsChildren: true })
    expect(within(sourceOf('Domains')).getByRole('radio', { name: 'Mapped to an entity' })).toHaveAttribute('aria-checked', 'true')
    expect(within(layerRow('Domains')).getByRole('status')).toHaveTextContent(
      'Mapped to Finance. No longer fills with Domains: a type rule would pull every Domain into the column.')
    expect(within(layerRow('Domains')).getAllByText(MAPPED_LINE).length).toBeGreaterThan(0)
  })

  it('a mapped layer (an edit of a view mapped on the canvas) shows as mapped, and maps to another entity or none', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', ['Finance', 'Marketing'])]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" initial={{
      layers: [{ id: 'l1', name: 'Finance', color: '#7c3aed', description: '', entityTypes: [], order: 0, anchorUrn: 'urn:Domain:Finance', nameFromAnchor: true }],
      assignments: { 'urn:Domain:Finance': { layerId: 'l1', inheritsChildren: true } },
    }} />)

    // Collapsed, the row says what the column is.
    expect(within(layerRow('Finance')).getByText(MAPPED_LINE)).toBeInTheDocument()
    expect(within(layerRow('Finance')).queryByText(TO_FILL)).not.toBeInTheDocument()

    open('Finance')
    expect(within(sourceOf('Finance')).getByRole('radio', { name: 'Mapped to an entity' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(layerRow('Finance')).getByRole('button', { name: 'Map to another entity…' }))
    const list = within(layerRow('Finance')).getByRole('listbox', { name: 'Top-level entities' })
    // The entity it is mapped to is not offered again.
    expect(labels(list)).toEqual(['Marketing'])
    fireEvent.mouseDown(within(list).getByRole('option', { name: /Marketing/ }))

    let call = spy.mock.calls.at(-1)![0]
    // It followed its entity's name, so it takes the new one's.
    expect(call.layers[0]).toMatchObject({ name: 'Marketing', anchorUrn: 'urn:Domain:Marketing', nameFromAnchor: true })
    expect(call.assignments['urn:Domain:Marketing']).toMatchObject({ layerId: 'l1', inheritsChildren: true })
    expect(call.assignments['urn:Domain:Finance']).toMatchObject({ layerId: 'l1' })
    expect(within(layerRow('Marketing')).getByRole('status')).toHaveTextContent(
      'Mapped to Marketing — its rows are what’s inside Marketing. Finance stays in it as a row.')

    fireEvent.click(within(sourceOf('Marketing')).getByRole('radio', { name: 'Hand-picked' }))
    call = spy.mock.calls.at(-1)![0]
    expect(call.layers[0].anchorUrn).toBeUndefined()
    expect(call.assignments['urn:Domain:Marketing']).toMatchObject({ layerId: 'l1' })
    expect(within(layerRow('Marketing')).getByRole('status')).toHaveTextContent(
      'Marketing shows as a row now — the column is no longer mapped to it.')
  })

  it('a column named here stops following its entity, and an undo is offered only until the next edit', () => {
    ds.entityTypes = DSD
    top.byType = new Map([['Domain', ofType('Domain', ['Finance'])]])
    const spy = vi.fn()
    render(<Harness spy={spy} dataSourceId="ds1" initial={{
      layers: [{ id: 'l1', name: 'Finance', color: '#7c3aed', description: '', entityTypes: [], order: 0, anchorUrn: 'urn:Domain:Finance', nameFromAnchor: true }],
      assignments: { 'urn:Domain:Finance': { layerId: 'l1', inheritsChildren: true } },
    }} />)
    open('Finance')
    fireEvent.click(within(sourceOf('Finance')).getByRole('radio', { name: 'By type' }))
    expect(within(layerRow('Finance')).getByRole('status')).toBeInTheDocument()

    fireEvent.change(within(layerRow('Finance')).getByDisplayValue('Finance'), { target: { value: 'Money' } })
    expect(spy.mock.calls.at(-1)![0].layers[0]).toMatchObject({ name: 'Money' })
    expect(spy.mock.calls.at(-1)![0].layers[0].nameFromAnchor).toBeUndefined()
    expect(within(layerRow('Money')).queryByRole('status')).not.toBeInTheDocument()
  })
})
