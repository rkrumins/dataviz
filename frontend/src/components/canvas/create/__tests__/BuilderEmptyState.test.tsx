/**
 * BuilderEmptyState — the blank-start card on the Graph and Hierarchy canvases. It offers to
 * build only to someone who can: version control on (authoring exists only as drafts) AND the
 * manage permission on the active view's own workspace. Anyone else is told what is true, and the
 * two reasons are told apart: a switched-off feature is not something to ask a colleague about.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@/hooks/useViewSchema', () => ({
  useViewEntityTypes: () => [],
  useViewRootEntityTypes: () => [],
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({ id: 'view_1', workspaceId: 'ws_1' }),
}))
vi.mock('../hierarchyBuilderStore', () => ({
  useHierarchyBuilderStore: { getState: () => ({ open, openBuild: vi.fn() }) },
}))

import { BuilderEmptyState } from '../BuilderEmptyState'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function setVersioning(on: boolean) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: on } })
}

function grant(ws: Record<string, string[]>) {
  useAuthStore.setState({ permissions: { global: [], ws } } as never)
}

beforeEach(() => {
  open.mockClear()
  setVersioning(true)
})

describe('BuilderEmptyState', () => {
  it('offers a manager of this view’s workspace the way to start', () => {
    grant({ ws_1: ['workspace:datasource:manage'] })
    render(<BuilderEmptyState />)
    expect(screen.getByText('Start your model')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Build a lot at once/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add your first entity/ }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('offers nothing to someone who cannot manage it — and says who can', () => {
    // Managing a DIFFERENT workspace is not managing this one.
    grant({ ws_1: ['workspace:view:read'], ws_2: ['workspace:datasource:manage'] })
    render(<BuilderEmptyState />)
    expect(screen.getByText('This model is empty')).toBeInTheDocument()
    expect(screen.getByText('Nothing has been added yet. Someone with edit access can start building this model.')).toBeInTheDocument()
    expect(screen.queryByText(/Editing is turned off/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/or press/)).toBeNull()
  })

  it('blames the feature, not the person, while version control is off', () => {
    setVersioning(false)
    grant({ ws_1: ['workspace:datasource:manage'] })
    render(<BuilderEmptyState />)
    expect(screen.getByText('This model is empty')).toBeInTheDocument()
    expect(screen.getByText(/Editing is turned off for this workspace/)).toBeInTheDocument()
    expect(screen.queryByText(/Someone with edit access/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers nothing to build on a past revision, which is read-only', () => {
    grant({ ws_1: ['workspace:datasource:manage'] })
    const schema: ResolvedViewSchema = {
      entityTypes: [], relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: [],
    }
    render(<StaticViewSchemaProvider schema={schema} asOfSeq={12}><BuilderEmptyState /></StaticViewSchemaProvider>)
    expect(screen.getByText('This model is empty')).toBeInTheDocument()
    expect(screen.getByText('Nothing had been added by this revision.')).toBeInTheDocument()
    expect(screen.queryByText(/Someone with edit access/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
