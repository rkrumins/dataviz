/**
 * CALM MODE HOLDS THE STATUS PINGS STILL.
 *
 * `animate-ping` loops forever: the Overview's "N things need attention" and the dashboard's status
 * line both pulse with it. framer-motion's animations follow the app's calm mode through
 * `<MotionConfig>`, but a CSS keyframe only stops where globals.css's two calm-mode lists name it —
 * one for the OS's reduced motion, one for the app's own preference (`:root.reduce-motion`). A ping
 * missing from either kept pulsing for someone who asked for calm.
 *
 * SOURCE-LEVEL ON PURPOSE: jsdom runs no CSS animations, so only the stylesheet can say.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf8')
const calm = css.slice(css.indexOf('=== Calm mode'))

/** The selectors of the first rule in `block` that stops animations. */
function quieted(block: string): string[] {
    const list = block.match(/([^{}]*)\{\s*animation: none !important;/)?.[1] ?? ''
    return list.split(',').map((s) => s.trim()).filter(Boolean)
}

describe('calm mode', () => {
    it('is in globals.css, with its two lists', () => {
        expect(calm.length).toBeLessThan(css.length)
        expect(calm).toContain('@media (prefers-reduced-motion: reduce)')
    })

    it('holds a ping still for the OS’s reduced motion', () => {
        const os = calm.slice(calm.indexOf('@media (prefers-reduced-motion: reduce)') + '@media (prefers-reduced-motion: reduce) {'.length)
        expect(quieted(os)).toContain('.animate-ping')
    })

    it('holds a ping still for the app’s own calm mode', () => {
        const own = calm.slice(calm.indexOf(':root.reduce-motion'))
        expect(quieted(own)).toContain(':root.reduce-motion .animate-ping')
    })
})
