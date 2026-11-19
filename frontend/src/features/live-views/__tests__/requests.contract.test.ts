/**
 * The requests that make a view from a query, pinned across the tiers.
 *
 * The bodies the browser sends live in a fixture the backend also reads
 * (`backend/tests/fixtures/membership_requests.json`): here each is built from
 * its input by the code the sheet uses and must come out exactly; there each
 * must validate against the models, which refuse any field they don't know.
 * So a field reaches a request only once the server accepts it — a body the
 * server refuses is a 422, and the reader sees a broken preview.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { traceMembershipSpec } from '@/hooks/lib/traceExport'
import type { MembershipOrigin, MembershipSpec } from '@/types/membership'

import { createRequestOf, planRequestOf, type SaveChoices } from '../model'

interface Case {
  name: string
  builder: 'plan' | 'create'
  input: {
    spec?: MembershipSpec
    trace?: Parameters<typeof traceMembershipSpec>[0]
    viewId: string
    choices: SaveChoices
    name?: string
    description?: string
    visibility?: 'private' | 'workspace'
    mode?: 'live' | 'snapshot'
    workspaceId?: string
    dataSourceId?: string
    origin?: MembershipOrigin
  }
  body: Record<string, unknown>
}

const FIXTURE = resolve(__dirname, '../../../../../backend/tests/fixtures/membership_requests.json')
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { cases: Case[] }

describe('the requests that make a view from a query', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const spec = c.input.spec ?? traceMembershipSpec(c.input.trace!)
    const body = c.builder === 'plan'
      ? planRequestOf(spec, c.input.viewId, c.input.choices)
      : createRequestOf({
          name: c.input.name!, description: c.input.description, visibility: c.input.visibility!,
          mode: c.input.mode!, workspaceId: c.input.workspaceId!, dataSourceId: c.input.dataSourceId,
          spec, viewId: c.input.viewId, choices: c.input.choices, origin: c.input.origin!,
        })
    expect(JSON.parse(JSON.stringify(body))).toEqual(c.body)
  })

  it('no request carries a wait: the server’s own applies, and an older server still answers', () => {
    for (const c of cases) expect(c.body).not.toHaveProperty('waitMs')
  })
})
