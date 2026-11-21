/**
 * Which tours Help offers where. A contextual tour belongs to its own surface:
 * the Playground's tour to the Playground's workspace page (told apart from any
 * other workspace by its ribbon), the request tours to Workspaces while their
 * button or queue is on screen.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getTour, isTourOffered } from './tours'

const tour = (id: string) => getTour(id)!

afterEach(() => { document.body.innerHTML = '' })

describe('isTourOffered', () => {
  it('offers a tour that is not contextual anywhere', () => {
    expect(isTourOffered(tour('getting-started'), '/dashboard')).toBe(true)
  })

  it('offers a contextual tour only under its path', () => {
    expect(isTourOffered(tour('workspace-detail'), '/workspaces/ws_fin')).toBe(true)
    expect(isTourOffered(tour('workspace-detail'), '/explorer')).toBe(false)
  })

  it('offers the Playground tour only where its ribbon is on the page', () => {
    expect(isTourOffered(tour('playground'), '/workspaces/ws_fin')).toBe(false)
    document.body.innerHTML = '<p data-tour="playground-ribbon"></p>'
    expect(isTourOffered(tour('playground'), '/workspaces/ws_pg')).toBe(true)
    expect(isTourOffered(tour('playground'), '/explorer')).toBe(false)
  })

  it('offers asking for a workspace only beside the Request a workspace button', () => {
    expect(isTourOffered(tour('request-workspace'), '/workspaces')).toBe(false)
    document.body.innerHTML = '<button data-tour="workspaces-request"></button>'
    expect(isTourOffered(tour('request-workspace'), '/workspaces')).toBe(true)
  })

  it('offers the approver tour only while the queue is on the page', () => {
    expect(isTourOffered(tour('workspace-approver'), '/workspaces')).toBe(false)
    document.body.innerHTML = '<section data-tour="workspace-requests-queue"></section>'
    expect(isTourOffered(tour('workspace-approver'), '/workspaces')).toBe(true)
  })
})
