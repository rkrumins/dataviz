/**
 * First-call snippets: only the .env line holds the key, and the cURL one
 * keeps it off the command line the way the API guide does.
 */
import { describe, expect, it } from 'vitest'

import { SNIPPETS, snippet } from '../snippets'

const TOKEN = 'nxpat_SECRET_VALUE'
const ORIGIN = 'https://lineage.example.com'

describe('first calls with a new key', () => {
    it('offers cURL, Python, JavaScript and a .env line', () => {
        expect(SNIPPETS.map((s) => s.id)).toEqual(['curl', 'python', 'javascript', 'env'])
    })

    it('puts the key only in the .env line', () => {
        expect(snippet('env', TOKEN, ORIGIN)).toBe(`API_KEY=${TOKEN}`)
        for (const id of ['curl', 'python', 'javascript'] as const) {
            expect(snippet(id, TOKEN, ORIGIN), id).not.toContain(TOKEN)
            expect(snippet(id, TOKEN, ORIGIN), id).toContain(`${ORIGIN}`)
            expect(snippet(id, TOKEN, ORIGIN), id).toContain('/api/v1/api-keys/self')
        }
    })

    it('hands cURL the key through a header file a builtin wrote', () => {
        const curl = snippet('curl', TOKEN, ORIGIN)
        expect(curl).toContain(`printf 'Authorization: Bearer %s\\n' "$API_KEY" > "$HDR"`)
        expect(curl).toContain('-H @"$HDR"')
        expect(curl).not.toMatch(/-H ["']Authorization/)
        expect(curl).toContain('rm -f "$HDR"')
    })

    it('reads the key from the environment in Python and JavaScript', () => {
        expect(snippet('python', TOKEN, ORIGIN)).toContain('import httpx')
        expect(snippet('python', TOKEN, ORIGIN)).toContain("os.environ['API_KEY']")
        expect(snippet('javascript', TOKEN, ORIGIN)).toContain('process.env.API_KEY')
        expect(snippet('javascript', TOKEN, ORIGIN)).toContain('await fetch(')
    })
})
