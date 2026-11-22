/**
 * A rise into place, one part after another: the DashboardHero's entry, in the app's `MOTION`.
 * Nothing moves for a person who asked for calm (the OS setting or the app's own). The Settings
 * hero, its task cards, the Overview's hero and its list of what needs attention share it.
 */
import type { Transition } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import { useCalmMotion } from '@/components/settings/visuals/motion'

export function useRise(stagger: number, entry: Transition, y: number) {
    const { reduced } = useCalmMotion()
    return (i: number) => (reduced ? { initial: false as const } : {
        initial: { opacity: 0, y },
        animate: { opacity: 1, y: 0 },
        transition: { ...entry, delay: Math.min(i, MOTION.staggerMax) * stagger },
    })
}
