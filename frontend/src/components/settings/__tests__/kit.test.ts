/**
 * The kit's words and checks: every kind reads with its unit; a staged value is checked the way the
 * server checks it (range narrowed by the platform's limits, allowed choices, cross-field rules,
 * and a rule re-checked when the value it names moves); the lens orders without hiding; fixes and
 * impacts read in plain words.
 */
import { describe, expect, it } from 'vitest'
import { SCHEMA, SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { boundsAt, describeFix, formatValue, inheritedAt, settingAnchor } from '../format'
import { changeImpacts, choiceImpacts } from '../impacts'
import { orderForLens } from '../lens'
import { validateStaged, validateValue } from '../validate'

const pairs = (impacts: ReturnType<typeof changeImpacts>) => impacts.map((i) => [i.dimension, i.verdict])

describe('formatValue', () => {
    it('says every kind with its unit', () => {
        expect(formatValue(S['reads.mode'], 'beside')).toBe('Keep serving, switch when ready')
        expect(formatValue(S['residency.autoUnload'], false)).toBe('Off')
        expect(formatValue(S['builds.aboveRows'], 200000)).toBe('200,000 changes')
        expect(formatValue(S['builds.perWorker'], 1)).toBe('1 build')
        expect(formatValue(S['imports.guardDeleteShare'], 0.2)).toBe('20%')
        // A ratio reads in percent, a multiplier too, as the server's sentences say it.
        expect(formatValue(S['updates.pacingRatio'], 0.25)).toBe('25%')
        expect(formatValue(S['updates.readPressureRatio'], 2.5)).toBe('250%')
        expect(formatValue(S['residency.unloadStartPct'], 85)).toBe('85%')
        expect(formatValue(S['updates.statementTargetMs'], 500)).toBe('500 ms')
        expect(formatValue(S['database.readTimeoutMs'], 15000)).toBe('15 seconds')
        expect(formatValue(S['residency.standardIdleSecs'], 604800)).toBe('7 days')
        expect(formatValue(S['residency.bytesPerEntity'], 550)).toBe('550 bytes')
        expect(formatValue(S['trash.restoreDays'], 1)).toBe('1 day')
        expect(formatValue(S['drafts.keepClosedDays'], 'forever')).toBe('Forever')
        expect(formatValue(S['reads.maxVersionsBehind'], 'unlimited')).toBe('Unlimited')
        expect(formatValue(S['reads.maxVersionsBehind'], 3)).toBe('3 versions')
        expect(formatValue(S['builds.copyMaxBytes'], 8 * 1024 ** 3)).toBe('8 GB')
        expect(formatValue(S['imports.identifier'], 'prop.sku,urn')).toBe('Property sku, then URN')
        expect(formatValue(S['imports.maxRefusedRows'], '0.5%')).toBe('0.5% of rows')
        expect(formatValue(S['reads.mode'], null)).toBe('Not set')
    })

    it('anchors a row the way the guide anchors its section', () => {
        expect(settingAnchor('reads.mode')).toBe('reads-mode')
        expect(settingAnchor('reads.maxVersionsBehind')).toBe('reads-maxversionsbehind')
        expect(S['reads.maxVersionsBehind'].docs).toBe(`versioned-graph-settings#${settingAnchor('reads.maxVersionsBehind')}`)
    })
})

describe('the trail', () => {
    it('knows what clearing a scope’s own value would leave in force', () => {
        expect(inheritedAt(GRAPH_VALUES['imports.guardDeleteShare'], 'graph')).toEqual({ scope: 'workspace', value: 0.25 })
        expect(inheritedAt(GRAPH_VALUES['reads.mode'], 'graph')).toEqual({ scope: 'platform', value: 'latest' })
        expect(inheritedAt(WORKSPACE_VALUES['imports.identifier'], 'workspace')).toEqual({ scope: 'default', value: 'entity_id' })
    })

    it('narrows the range by the platform’s limits below the platform', () => {
        expect(boundsAt(S['forks.maxPerGraph'], WORKSPACE_VALUES['forks.maxPerGraph'], 'workspace')).toEqual({ min: 0, max: 20 })
        expect(boundsAt(S['forks.maxPerGraph'], WORKSPACE_VALUES['forks.maxPerGraph'], 'platform')).toEqual({ min: 0, max: 1000 })
    })
})

describe('validateValue', () => {
    const values = { 'residency.unloadStartPct': 85, 'database.readsPerProcess': 8 }
    it('checks the range in the setting’s own unit', () => {
        expect(validateValue(S['residency.unloadStartPct'], 99, { values, bounds: { min: 50, max: 95 } })).toBe('Enter 50% to 95%.')
        expect(validateValue(S['forks.maxPerGraph'], 50, { values, bounds: { min: 0, max: 20 } })).toBe('Enter 0 forks to 20 forks.')
        expect(validateValue(S['builds.aboveRows'], 1.5, { values })).toBe('Enter a whole number.')
        expect(validateValue(S['residency.unloadStartPct'], 90, { values, bounds: { min: 50, max: 95 } })).toBeNull()
    })

    it('checks cross-field rules with their margin, in the registry’s words', () => {
        const stopRule = S['residency.unloadStopPct'].rules[0]
        expect(validateValue(S['residency.unloadStopPct'], 82, { values })).toBe(stopRule.message)
        expect(validateValue(S['residency.unloadStopPct'], 80, { values })).toBeNull()
        expect(validateValue(S['database.readsPerGraph'], 9, { values, settings: S })).toBe(S['database.readsPerGraph'].rules[0].message)
    })

    it('checks choices, identifiers and refusal budgets in their syntax', () => {
        const title = (id: string) => S['reads.mode'].choices.find((c) => c.id === id)!.title
        expect(validateValue(S['reads.mode'], 'beside', { values, allowed: ['latest', 'in_place'] }))
            .toBe(`Not allowed here. Choose ${title('latest')} or ${title('in_place')}.`)
        expect(validateValue(S['imports.identifier'], 'prop.', { values })).toBe('Name the property.')
        expect(validateValue(S['imports.identifier'], 'prop.a b', { values })).toBe('A property name has no spaces or commas.')
        expect(validateValue(S['imports.identifier'], 'prop.sku,urn', { values })).toBeNull()
        expect(validateValue(S['imports.maxRefusedRows'], '0.5%', { values })).toBeNull()
        expect(validateValue(S['imports.maxRefusedRows'], 'lots', { values })).toMatch(/^Enter none/)
        expect(validateValue(S['drafts.keepClosedDays'], 'forever', { values })).toBeNull()
        expect(validateValue(S['reads.mode'], null, { values })).toBeNull()
    })

    it('re-checks a rule when the value it names is staged', () => {
        const staged = { 'residency.unloadStartPct': 72 }
        const errors = validateStaged(S, staged, () => ({ values: { 'residency.unloadStartPct': 72, 'residency.unloadStopPct': 70 } }))
        expect(errors).toEqual({ 'residency.unloadStopPct': S['residency.unloadStopPct'].rules[0].message })
    })
})

describe('orderForLens', () => {
    it('leads with business settings under Business, keeps category order under Operator, and hides none', () => {
        const business = orderForLens(SCHEMA.settings, 'business', SCHEMA.categories)
        const operator = orderForLens(SCHEMA.settings, 'operator', SCHEMA.categories)
        expect(business).toHaveLength(SCHEMA.settings.length)
        expect(operator).toHaveLength(SCHEMA.settings.length)
        const firstOperatorAt = business.findIndex((s) => s.audience === 'operator')
        expect(firstOperatorAt).toBeGreaterThan(0)
        expect(business.slice(0, firstOperatorAt).every((s) => s.audience === 'business')).toBe(true)
        expect(business.slice(firstOperatorAt).every((s) => s.audience === 'operator')).toBe(true)
        expect(operator[0].key).toBe('reads.mode')
        const order = operator.map((s) => SCHEMA.categories.find((c) => c.id === s.category)!.order)
        expect(order).toEqual([...order].sort((a, b) => a - b))
    })
})

describe('describeFix and impacts', () => {
    it('words a fix as its button would', () => {
        expect(describeFix({ feature: 'candidateKeysEnabled', to: true })).toBe('Turn on New-version builds')
        expect(describeFix({ setting: 'reads.mode', to: 'in_place' }, { settings: S })).toBe('Use “Keep serving, update in place”')
        expect(describeFix({ setting: 'imports.replaceGuard', to: true }, { settings: S })).toBe('Turn on replace guard')
        expect(describeFix({ setting: 'drafts.levels', to: 'any' }, { settings: S })).toBe('Use “Public or private”')
    })

    it('says what a choice does, dimension by dimension, from its verdicts', () => {
        const beside = S['reads.mode'].choices.find((c) => c.id === 'beside')!
        expect(pairs(choiceImpacts(beside))).toEqual([
            ['consistency', 'better'], ['availability', 'better'], ['read_speed', 'better'], ['update_speed', 'worse'],
            ['memory', 'worse'], ['cost', 'worse'],
        ])
        expect(pairs(changeImpacts(S['reads.mode'], 'latest', 'in_place'))).toEqual([
            ['consistency', 'worse'], ['availability', 'better'], ['read_speed', 'better'], ['database_load', 'better'],
        ])
    })

    it('says what raising or lowering a number does, from each effect’s upVerdict', () => {
        const up = changeImpacts(S['residency.unloadStartPct'], 80, 90)
        expect(pairs(up)).toEqual([['availability', 'worse'], ['read_speed', 'better'], ['memory', 'worse'], ['cost', 'better']])
        expect(up.map((i) => i.text)).toEqual(['availability', 'read_speed', 'memory', 'cost']
            .map((d) => S['residency.unloadStartPct'].guidance.effects.find((e) => e.dimension === d)!.up))
        expect(pairs(changeImpacts(S['residency.unloadStartPct'], 80, 70))).toEqual([
            ['availability', 'better'], ['read_speed', 'worse'], ['memory', 'better'], ['cost', 'worse'],
        ])
        expect(pairs(changeImpacts(S['residency.autoUnload'], true, false))).toEqual([
            ['availability', 'worse'], ['read_speed', 'better'], ['memory', 'worse'],
        ])
        expect(changeImpacts(S['imports.identifier'], 'entity_id', 'urn')).toEqual([])
    })
})
