/**
 * The catalogue the app ships speaks the kit's words. `catalogue.ts` holds its shape at compile
 * time; JSON is typed with plain strings, so the word lists (kinds, dimensions, verdicts…) and the
 * references between settings are held here.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../catalogue'
import { settingAnchor } from '../format'
import {
    AUDIENCES, DIMENSIONS, EDITORS, KINDS, LEGACY_ENCODES, LIMIT_KINDS, RISKS, SCOPES, TAKES_EFFECT, VERDICTS, VISUALS, WEIGHTS,
} from '../types'

const keys = new Set(CATALOGUE.settings.map((s) => s.key))

describe('the generated catalogue', () => {
    it('uses only the words the kit draws', () => {
        expect(CATALOGUE.dimensions.map((d) => d.id)).toEqual([...DIMENSIONS])
        expect(CATALOGUE.scopes.map((s) => s.id)).toEqual([...SCOPES])
        for (const c of CATALOGUE.categories) expect(AUDIENCES).toEqual(expect.arrayContaining(c.audience))
        for (const s of CATALOGUE.settings) {
            expect(KINDS).toContain(s.kind)
            expect(AUDIENCES).toContain(s.audience)
            expect(TAKES_EFFECT).toContain(s.takesEffect.when)
            expect(RISKS).toContain(s.guidance.risk)
            if (s.visual) expect(VISUALS).toContain(s.visual)
            if (s.legacy?.encode) expect(LEGACY_ENCODES).toContain(s.legacy.encode)
            for (const l of s.limitable) expect(LIMIT_KINDS).toContain(l)
            for (const [scope, editor] of Object.entries(s.scopes)) {
                expect(SCOPES).toContain(scope)
                expect(EDITORS).toContain(editor)
            }
            for (const e of s.guidance.effects) {
                expect(DIMENSIONS).toContain(e.dimension)
                expect(WEIGHTS).toContain(e.weight)
                expect(VERDICTS).toContain(e.upVerdict)
            }
            for (const c of s.choices) {
                for (const [dim, [verdict]] of Object.entries(c.effects)) {
                    expect(DIMENSIONS).toContain(dim)
                    expect(VERDICTS).toContain(verdict)
                }
                for (const f of c.frames) expect(['before', 'while', 'after']).toContain(f.when)
            }
        }
    })

    it('names only settings, categories and why texts that exist, and anchors each setting where the guide does', () => {
        const categories = new Set(CATALOGUE.categories.map((c) => c.id))
        for (const s of CATALOGUE.settings) {
            expect(categories).toContain(s.category)
            expect(s.docs).toBe(`versioned-graph-settings#${settingAnchor(s.key)}`)
            for (const r of [...s.requires, ...s.choices.flatMap((c) => c.requires)]) {
                if (r.setting) expect(keys).toContain(r.setting)
                expect(Object.keys(CATALOGUE.why)).toContain(r.why)
            }
            for (const r of s.rules) expect(keys).toContain(r.other)
            for (const c of s.caps) if (c.setting) expect(keys).toContain(c.setting)
            for (const u of s.uses) expect(keys).toContain(u)
            if (s.kind === 'choice') expect(s.choices.map((c) => c.id)).toContain(s.default.code)
        }
        // A deployment fact's value reads as a setting's of its kind would.
        for (const d of CATALOGUE.deployment) {
            expect(KINDS).toContain(d.kind)
            expect(categories).toContain(d.category)
        }
    })

    it('ships profiles and signals that name only settings, levels and problems that exist', () => {
        const symptoms = new Set(CATALOGUE.settings.flatMap((s) => s.guidance.symptoms))
        expect(CATALOGUE.profiles.length).toBeGreaterThanOrEqual(5)
        for (const p of CATALOGUE.profiles) {
            expect(AUDIENCES).toContain(p.audience)
            for (const scope of p.scopes) expect(SCOPES).toContain(scope)
            for (const key of Object.keys(p.values)) expect(keys).toContain(key)
        }
        for (const s of CATALOGUE.signals) {
            expect(symptoms).toContain(s.symptom)
            for (const key of s.settings) expect(keys).toContain(key)
        }
    })
})
