/**
 * Applying a profile stages only what the person may set at this level and that would change
 * something; everything else is left out with why: not set at this level, already like this, a
 * system admin's to set, locked by the platform, outside what the platform allows, or a fork's.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../catalogue'
import { GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { applyProfile, skipWords, type ProfilePlan } from '../profiles'
import type { Profile, ResolvedValues } from '../types'

const shipped = (id: string) => CATALOGUE.profiles.find((p) => p.id === id)!
const staged = (plan: ProfilePlan) => Object.fromEntries(plan.stage.map((s) => [s.key, s.value]))
const why = (plan: ProfilePlan) => Object.fromEntries(plan.skipped.map((s) => [s.key, s.reason]))

/** A profile of the given values, for the levels it names. */
const profile = (values: Profile['values'], scopes: Profile['scopes'] = ['platform', 'workspace', 'graph']): Profile => ({
    id: 'test', title: 'Test', promise: '', audience: 'business', when: [], values, scopes, caution: '',
})

describe('applyProfile', () => {
    it('stages for a system admin on the platform each value that would change something', () => {
        const plan = applyProfile(shipped('fastest-reads'), 'platform', 'system_admin', PLATFORM_VALUES)
        expect(staged(plan)).toEqual({ 'reads.mode': 'in_place', 'updates.statementTargetMs': 250, 'updates.pacingRatio': 0.5 })
        // The platform has no limit on versions behind already: nothing to stage.
        expect(plan.skipped).toEqual([{ key: 'reads.maxVersionsBehind', reason: 'already' }])
    })

    it('leaves out what a workspace admin may not set on a graph, and says why', () => {
        const plan = applyProfile(shipped('balanced'), 'graph', 'workspace_admin', GRAPH_VALUES)
        // The graph's own "switch when ready", and the workspace's 3 versions behind, go back to the defaults.
        expect(staged(plan)).toEqual({ 'reads.mode': 'latest', 'reads.maxVersionsBehind': 'unlimited' })
        const reasons = why(plan)
        expect(reasons['residency.class']).toBe('system_admin_only')
        expect(reasons['updates.pacingRatio']).toBe('not_here')
        expect(Object.keys(reasons).sort()).toEqual(
            Object.keys(shipped('balanced').values).filter((k) => !k.startsWith('reads.')).sort())
    })

    it('treats a setting the level resolves but nobody sets there as not set here', () => {
        const graphOnly: ResolvedValues = {
            ...GRAPH_VALUES,
            'updates.pacingRatio': { ...PLATFORM_VALUES['updates.pacingRatio'], editor: null, editable: false },
        }
        const plan = applyProfile(shipped('fastest-reads'), 'graph', 'system_admin', graphOnly)
        expect(why(plan)['updates.pacingRatio']).toBe('not_here')
    })

    it('never stages what the platform locked, a fork follows, or a value already chosen', () => {
        const plan = applyProfile(profile({ 'imports.replaceGuard': false, 'imports.guardDeleteShare': 0.3, 'imports.identifier': 'urn' }),
            'graph', 'workspace_admin', GRAPH_VALUES)
        expect(why(plan)).toEqual({ 'imports.replaceGuard': 'locked', 'imports.guardDeleteShare': 'already' })
        expect(staged(plan)).toEqual({ 'imports.identifier': 'urn' })

        const fork: ResolvedValues = {
            ...GRAPH_VALUES,
            'imports.identifier': { ...GRAPH_VALUES['imports.identifier'], editable: false, why: [{ code: 'follows_root', text: '', fix: null }] },
        }
        expect(why(applyProfile(profile({ 'imports.identifier': 'urn' }), 'graph', 'workspace_admin', fork))).toEqual({ 'imports.identifier': 'follows_root' })
    })

    it('keeps a workspace admin within the platform’s limits, and lets a system admin step outside them', () => {
        // Workspaces may choose `latest` or `in_place`; forks are limited to 0 to 20.
        const values = { 'reads.mode': 'beside', 'forks.maxPerGraph': 30 }
        expect(why(applyProfile(profile(values), 'workspace', 'workspace_admin', WORKSPACE_VALUES)))
            .toEqual({ 'reads.mode': 'not_allowed', 'forks.maxPerGraph': 'not_allowed' })
        const admin: ResolvedValues = {
            ...WORKSPACE_VALUES,
            'reads.mode': { ...WORKSPACE_VALUES['reads.mode'], allowed: ['latest', 'in_place', 'beside'] },
        }
        expect(staged(applyProfile(profile(values), 'workspace', 'system_admin', admin))).toEqual(values)
    })

    it('stages nothing where the profile doesn’t apply, or for someone who may not edit', () => {
        const tonight = applyProfile(shipped('big-import-tonight'), 'graph', 'system_admin', GRAPH_VALUES)
        expect(tonight.stage).toEqual([])
        expect(new Set(tonight.skipped.map((s) => s.reason))).toEqual(new Set(['not_here']))

        const viewer = applyProfile(shipped('fastest-reads'), 'graph', null, GRAPH_VALUES)
        expect(viewer.stage).toEqual([])
        expect(why(viewer)).toMatchObject({ 'reads.mode': 'no_permission', 'reads.maxVersionsBehind': 'no_permission' })
    })

    it('says why a value was left out in words', () => {
        expect(skipWords('not_here', 'graph')).toBe('Can’t be set for this graph')
        expect(skipWords('system_admin_only', 'workspace')).toBe('Only a system admin can set it here')
        expect(skipWords('locked', 'graph')).toBe('Locked by the platform')
        expect(skipWords('already', 'platform')).toBe('Already like this for the platform')
    })
})
