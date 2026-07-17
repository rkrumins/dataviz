/**
 * PhysicalAlignmentSection — grade hero, predictive findings, degrade paths.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchMock(...a),
}))

import { PhysicalAlignmentSection, type AlignmentAnalysis } from './PhysicalAlignmentSection'

const ANALYSIS: AlignmentAnalysis = {
  profiled: true,
  schemaUpdatedAt: new Date().toISOString(),
  ontology: { id: 'bp_1', name: 'Core Schema', version: 3 },
  adoption: {
    matchWeighted: 23.5,
    matchByType: 40,
    nodes: {
      matchWeighted: 15, matchByType: 33, totalTypes: 3, totalInstances: 750,
      exact: [{ id: 'Pipeline', count: 100 }],
      caseDrift: [{ id: 'pipeline', declared: 'Pipeline', count: 600 }],
      unmapped: [{ id: 'custom_thing', count: 50 }],
      declaredUnused: ['Report'],
    },
    edges: null,
  },
  indexCoverage: {
    indexedLabels: ['dataset', 'Pipeline'],
    indexedProps: ['urn'],
    unindexedPhysical: [
      { label: 'pipeline', declared: 'Pipeline', instances: 600, reason: 'case_drift' },
      { label: 'custom_thing', declared: null, instances: 50, reason: 'unmapped' },
    ],
  },
  aggregation: { status: 'none', lastAggregatedAt: null, canonicalized: false },
  grade: 'D',
  findings: [
    { severity: 'critical', code: 'CASE_DRIFT_SCAN', message: 'Raw reads on `pipeline` (600 instances) fall back to label scans.', instances: 600 },
    { severity: 'critical', code: 'RAW_READS_DEGRADED', message: 'This source is not aggregated/versioned.' },
    { severity: 'warning', code: 'UNMAPPED_NO_INDEX', message: '1 physical type has no declared counterpart.' },
  ],
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PhysicalAlignmentSection wsId="ws1" dataSourceId="ds1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ANALYSIS })
})

describe('PhysicalAlignmentSection', () => {
  it('renders the grade hero with the alignment percentage and schema identity', async () => {
    renderSection()
    expect(await screen.findByText('D')).toBeInTheDocument()
    expect(screen.getByText('Poorly aligned')).toBeInTheDocument()
    expect(screen.getByText('24%')).toBeInTheDocument()
    expect(screen.getByText('Core Schema')).toBeInTheDocument()
  })

  it('lists the predictive slow-query findings by severity', async () => {
    renderSection()
    expect(await screen.findByText(/fall back to label scans/)).toBeInTheDocument()
    expect(screen.getByText(/not aggregated\/versioned/)).toBeInTheDocument()
    expect(screen.getByText(/no declared counterpart/)).toBeInTheDocument()
    // Type-by-type chips reuse the shared DimBreakdown semantics
    expect(screen.getByText('custom_thing')).toBeInTheDocument()
  })

  it('degrades to a not-profiled message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...ANALYSIS, profiled: false, grade: null, adoption: null,
        indexCoverage: null,
        findings: [{ severity: 'info', code: 'NOT_PROFILED', message: 'not profiled' }],
      }),
    })
    renderSection()
    expect(await screen.findByText(/Not profiled yet/)).toBeInTheDocument()
  })

  it('renders nothing when the endpoint is unavailable', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    const { container } = renderSection()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(container.textContent).not.toContain('Physical Alignment'))
  })
})
