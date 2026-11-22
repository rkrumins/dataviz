/**
 * ReviewStep — Checks: what the server's check found, most pressing first: what stops the change,
 * then warnings, then notes. Past three the rest wait behind "Show all N", but nothing that stops it
 * is ever hidden. A check that found nothing says so.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { PropertyJobPreview, PropertyJobWarning } from '@/services/versioningApiService'
import type { OpDraft } from '../opModel'
import { ReviewStep } from '../ReviewStep'

const op: OpDraft = { kind: 'rename', key: 'owner', to: 'steward', value: '', onConflict: 'skip' }
const warning = (field: string): PropertyJobWarning => ({ code: 'field_required', entityType: 'Table', field, message: `${field} is required on Table.` })
const preview = (over: Partial<PropertyJobPreview>): PropertyJobPreview => ({ refusal: null, nameBudget: null, activeJobId: null, counts: null, ...over })

function review(answer: PropertyJobPreview, { stagedCount = 0, previewError = null as string | null } = {}) {
  render(
    <ReviewStep op={op} preset={{ kind: 'view' }} scopeMode="view" counts={null} impact={{ changes: 10, replaced: 0, untouched: 0 }} exact
      preview={answer} previewLoading={false} previewError={previewError} sample={null} sampleLoading={false} stagedCount={stagedCount} />,
  )
}
/** Each check shown, in order. */
const shown = () => [...screen.getByRole('region', { name: 'Checks' }).querySelectorAll(':scope > div')].map((n) => n.textContent)

describe('ReviewStep — checks', () => {
  it('puts what stops it first, then warnings, then notes — three at first, the rest behind Show all', async () => {
    const user = userEvent.setup()
    review(preview({
      activeJobId: 'job-0',
      counts: { matched: 10, haveKey: 10, haveTo: 0, missing: 0, derived: 2 },
      nameBudget: { registered: 10, nativeBudget: 50_000, ceiling: 65_534, isNew: true, verdict: 'ok' },
      warnings: [warning('tier'), warning('dept')],
    }))
    expect(shown()).toEqual([
      expect.stringMatching(/^Another change is still being applied/), 'tier is required on Table.', 'dept is required on Table.',
    ])
    await user.click(screen.getByRole('button', { name: 'Show all 5' }))
    expect(shown()).toEqual([
      expect.stringMatching(/^Another change is still being applied/), 'tier is required on Table.', 'dept is required on Table.',
      expect.stringMatching(/^2 of them are roll-ups/), expect.stringMatching(/^A new property name stays registered/),
    ])
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })

  it('never hides what stops it, however many', () => {
    review(preview({
      refusal: { code: 'reserved_key', message: '“urn” is kept by the platform.' }, activeJobId: 'job-0',
      nameBudget: { registered: 65_000, nativeBudget: 50_000, ceiling: 65_534, isNew: true, verdict: 'refused' },
      warnings: [warning('tier')],
    }), { stagedCount: 2, previewError: 'the server is busy' })
    expect(shown()).toEqual([
      expect.stringMatching(/^Couldn’t check it can be applied: the server is busy/), '“urn” is kept by the platform.',
      expect.stringMatching(/^Another change is still being applied/), expect.stringMatching(/no room left for new property names/),
      expect.stringMatching(/^You have 2 staged changes not saved yet/),
    ])
    expect(within(screen.getByRole('region', { name: 'Checks' })).getAllByRole('alert')).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'Show all 6' })).toBeInTheDocument()
  })

  it('says when the check found nothing that would stop it', () => {
    review(preview({}))
    expect(screen.getByRole('region', { name: 'Checks' })).toHaveTextContent('The server found nothing that would stop it.')
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })
})
