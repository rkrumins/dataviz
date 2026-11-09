/**
 * PullBeforeMergeBanner — a draft behind Published is told why it matters and what to do next.
 * Behind automation alone, on nothing it changed, it publishes as it is, and the strip says so
 * calmly. Behind people, or automation that changed what it changes, it is asked to get the latest
 * first, and told which.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useCommitLog: (ws?: string) => ({
    isLoading: false,
    data: ws ? {
      commits: [
        { commit_id: 'c7', commit_seq: 7, message: 'nightly sync', actor: 'svc_sync', actor_kind: 'service',
          api_key_id: 'apk_1', automation: true, created_at: '2026-11-09T09:00:00Z', stats: { create: 2, update: 1 } },
        { commit_id: 'c6', commit_seq: 6, message: 'Rename Sales', actor: 'usr_a', actor_kind: 'human',
          automation: false, created_at: '2026-11-09T08:00:00Z', stats: { update: 1 } },
        { commit_id: 'c4', commit_seq: 4, message: 'before the draft', actor: 'usr_a', created_at: '2026-11-08T08:00:00Z' },
      ],
      userNames: { svc_sync: 'Snowflake sync', usr_a: 'Ana Lee' },
      apiKeyNames: { apk_1: 'Nightly loader' },
    } : undefined,
  }),
}))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => <button>Get latest updates</button> }))

import { PullBeforeMergeBanner } from '../PullBeforeMergeBanner'
import { gateCopy, refusalCopy } from '../../model/provenance'

const banner = (props: Partial<Parameters<typeof PullBeforeMergeBanner>[0]> = {}) =>
  render(<PullBeforeMergeBanner wsId="ws1" graphId="g1" branchId="br1" baseCommitSeq={5} mainHead={7} {...props} />)

describe('PullBeforeMergeBanner', () => {
  it('behind automation alone: says it publishes as it is, and lists what came in', async () => {
    banner({ required: false })
    expect(screen.getByText('Published moved — 2 updates from automation only')).toBeInTheDocument()
    expect(screen.getByText(/you can publish as it is: your changes land on top/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /What changed/ }))
    expect(screen.getByText('nightly sync')).toBeInTheDocument()
    expect(screen.getByText('· 3 changes')).toBeInTheDocument()
    expect(screen.getByText('Service account')).toBeInTheDocument()
    expect(screen.getByText('Nightly loader')).toBeInTheDocument()
    expect(screen.queryByText('before the draft')).toBeNull()      // already in the draft
  })

  it('behind people: asks to get their changes first', () => {
    banner({ required: true, reason: 'people', behindByPeople: 1 })
    expect(screen.getByText('Updates available — 1 change by people on the Published version')).toBeInTheDocument()
    expect(screen.getByText(/Someone changed Published since you started/)).toBeInTheDocument()
  })

  it('automation changed what the draft changes: says so, and asks to look', () => {
    banner({ required: true, reason: 'overlap' })
    expect(screen.getByText('Automation changed something you’re changing')).toBeInTheDocument()
    expect(screen.getByText(/see what it changed and keep the values you want/)).toBeInTheDocument()
  })

  it('shows nothing when the draft is up to date', () => {
    const { container } = banner({ baseCommitSeq: 7 })
    expect(container).toBeEmptyDOMElement()
  })
})

describe('gate copy', () => {
  it('reads as a calm note only when nothing must be done', () => {
    expect(gateCopy(null, 3).tone).toBe('info')
    for (const r of ['people', 'overlap', 'size'] as const) expect(gateCopy(r, 3, 1).tone).toBe('warn')
  })

  it('says what to do after a refused publish, for each reason', () => {
    expect(refusalCopy('overlap')).toMatch(/Automation changed something this draft changes/)
    expect(refusalCopy('size')).toMatch(/large/)
    expect(refusalCopy(undefined)).toMatch(/Someone changed Published/)
  })
})
