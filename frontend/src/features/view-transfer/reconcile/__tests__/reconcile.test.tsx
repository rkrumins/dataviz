/**
 * The Match step's pieces, pinned:
 *   - choices are pure edits of `Resolutions` (the shape the server applies), and taking one back
 *     leaves no trace; many at once is one pass, fast enough for the 20,000 entities a report lists;
 *   - the score projects dropped entities immediately and counts what it can't score (remaps,
 *     withdrawn choices) as pending, never as found;
 *   - the panel turns a click into exactly that edit: drop one, drop all not found, map a type;
 *   - Merge can't be chosen where there's nothing to merge from.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReconciledView, ReconcileReport, Resolutions } from '@/services/viewTransferApiService'
import { ReconciliationPanel } from '../ReconciliationPanel'
import {
  decisionOf, projectedRate, resolutionCount, sameResolutions, withDecision, withDecisions, withTypeDecision,
} from '../resolutions'

function report(): ReconcileReport {
  const counts = { total: 4, matched: 2, renamed: 0, typeChanged: 0, missing: 2, unknown: 0, found: 2, checked: 4, matchRate: 0.5 }
  return {
    summary: {
      entities: counts, byKind: { anchor: { ...counts, total: 1, matched: 1, missing: 0, found: 1, checked: 1, matchRate: 1 } },
      entityTypes: { total: 2, missing: 1 }, relationshipTypes: { total: 0, missing: 0 },
      layers: { total: 1, healthy: 0 }, displayRules: 2, urnPatterns: 0, matchRate: 0.5, coverage: 1,
      verdict: 'attention', verdictReason: '2 of 4 entities aren’t here.',
    },
    entities: [
      { urn: 'urn:gone1', status: 'missing', kinds: ['assignment'], layerId: 'l1', exported: { name: 'orders_v1', type: 'dataset' }, target: null },
      { urn: 'urn:gone2', status: 'missing', kinds: ['assignment'], layerId: 'l1', exported: { name: 'orders_v2', type: 'dataset' }, target: null },
    ],
    entitiesTruncated: false,
    types: {
      entity: [
        { id: 'dataset', status: 'present', suggestions: [], layers: ['Sources'] },
        { id: 'Table', status: 'missing', suggestions: ['table'], layers: ['Sources'] },
      ],
      relationship: [],
    },
    layers: [{ id: 'l1', name: 'Sources', ...counts, anchor: null, healthy: false }],
    notices: [],
  }
}

function reconciled(update: ReconciledView['update'] = null): ReconciledView {
  return { key: '0', effectiveDefinition: {}, effectiveHash: 'sha256:x', report: report(), update }
}

const TYPES = { entity: [{ id: 'table', name: 'Table' }, { id: 'dataset', name: 'Dataset' }], relationship: [] }

describe('resolutions', () => {
  it('records and takes back an entity decision', () => {
    const dropped = withDecision({}, 'urn:a', { kind: 'drop' })
    expect(decisionOf(dropped, 'urn:a')).toEqual({ kind: 'drop' })
    const remapped = withDecision(dropped, 'urn:a', { kind: 'remap', urn: 'urn:b' })
    expect(remapped.drop).toEqual([])
    expect(decisionOf(remapped, 'urn:a')).toEqual({ kind: 'remap', urn: 'urn:b' })
    expect(sameResolutions(withDecision(remapped, 'urn:a', { kind: 'keep' }), {})).toBe(true)
  })

  it('records one decision for many at once, as one at a time would', () => {
    const start: Resolutions = { drop: ['urn:kept-drop', 'urn:a'], remap: { 'urn:b': 'urn:x', 'urn:c': 'urn:y' } }
    const urns = ['urn:a', 'urn:b', 'urn:d']
    const oneByOne = urns.reduce<Resolutions>((r, urn) => withDecision(r, urn, { kind: 'drop' }), start)
    const atOnce = withDecisions(start, urns, { kind: 'drop' })
    expect(sameResolutions(atOnce, oneByOne)).toBe(true)
    expect(atOnce.remap).toEqual({ 'urn:c': 'urn:y' })
    expect(sameResolutions(withDecisions(atOnce, urns, { kind: 'keep' }), { drop: ['urn:kept-drop'], remap: { 'urn:c': 'urn:y' } })).toBe(true)
  })

  it('drops and scores 20,000 entities without stalling the page', () => {
    const r = report()
    r.entities = Array.from({ length: 20_000 }, (_, i) => ({ ...r.entities[0], urn: `urn:gone:${i}` }))
    r.summary.entities = { ...r.summary.entities, checked: 20_100, found: 100 }
    const started = performance.now()
    const draft = withDecisions({}, r.entities.map(e => e.urn), { kind: 'drop' })
    expect(projectedRate(r, {}, draft)).toEqual({ rate: 1, pending: 0 })
    // One entity at a time took seconds here: each searched every choice already made.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('records type decisions: map, drop, and leave', () => {
    const mapped = withTypeDecision({}, 'entity', 'Table', 'table')
    expect(mapped.typeMap).toEqual({ Table: 'table' })
    const dropped = withTypeDecision(mapped, 'entity', 'Table', null)
    expect([dropped.typeMap, dropped.dropTypes]).toEqual([{}, ['Table']])
    expect(resolutionCount(withTypeDecision(dropped, 'entity', 'Table', undefined))).toBe(0)
  })

  it('projects drops at once and counts what it cannot score as pending', () => {
    const r = report()
    expect(projectedRate(r, {}, withDecision({}, 'urn:gone1', { kind: 'drop' }))).toEqual({ rate: 2 / 3, pending: 0 })
    expect(projectedRate(r, {}, withDecision({}, 'urn:gone1', { kind: 'remap', urn: 'urn:new' }))).toEqual({ rate: 0.5, pending: 1 })
    // A drop already applied (so no longer in the report) and now taken back needs a re-check.
    expect(projectedRate(r, { drop: ['urn:old'] }, {})).toEqual({ rate: 0.5, pending: 1 })
  })
})

describe('ReconciliationPanel', () => {
  it('turns clicks into the matching choices', () => {
    const onDraft = vi.fn()
    render(<ReconciliationPanel reconciled={reconciled()} applied={{}} draft={{}} onDraft={onDraft}
      sourceLabel="dev · Finance" targetLabel="UAT · Lineage" availableTypes={TYPES} exportedNames={{}} />)

    expect(screen.getByText('Worth a look')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '50.0% matched' })).toBeInTheDocument()

    const row = screen.getByRole('group', { name: 'What to do with orders_v1' })
    fireEvent.click(within(row).getByRole('button', { name: 'drop' }))
    expect(onDraft).toHaveBeenLastCalledWith({ drop: ['urn:gone1'], remap: {} })

    fireEvent.click(screen.getByRole('button', { name: 'Drop all 2' }))
    expect(onDraft.mock.lastCall![0].drop.sort()).toEqual(['urn:gone1', 'urn:gone2'])

    fireEvent.change(screen.getByLabelText('Map Table'), { target: { value: 'table' } })
    expect(onDraft).toHaveBeenLastCalledWith({ typeMap: { Table: 'table' }, dropTypes: [] })
  })

  it('shows the projected score while choices wait to be checked', () => {
    render(<ReconciliationPanel reconciled={reconciled()} applied={{}} draft={{ drop: ['urn:gone1'] }} onDraft={vi.fn()}
      sourceLabel="dev" targetLabel="UAT" availableTypes={TYPES} exportedNames={{}} />)
    expect(screen.getByRole('img', { name: '66.7% matched' })).toBeInTheDocument()
    expect(screen.getByText('after your choices')).toBeInTheDocument()
  })

  it('offers Merge only when there is a version to merge from', () => {
    const onStrategy = vi.fn()
    const update = {
      status: 'unrelated' as const, base: null, targetHead: { version: 4, hash: 'h' }, targetWorkingHash: 'h',
      mergeAvailable: false, strategy: 'replace' as const, conflicts: [],
      diff: {
        metadata: [], layers: { added: [], removed: [], changed: [], reordered: false },
        assignments: { added: 0, removed: 0, moved: 0, modified: 0, samples: { added: [], removed: [], moved: [], modified: [] }, truncated: false },
        settings: [], identical: true,
      },
    }
    render(<ReconciliationPanel reconciled={reconciled(update)} applied={{}} draft={{}} onDraft={vi.fn()} onStrategy={onStrategy}
      sourceLabel="dev" targetLabel="“Finance”" targetName="Finance" availableTypes={TYPES} exportedNames={{}} />)
    expect(screen.getByText('No shared history')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Merge/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Replace/ }))
    expect(onStrategy).toHaveBeenCalledWith('replace')
  })
})
