/**
 * Motion for the explainers: short and decelerating, and none at all when the person asked for
 * less motion — the OS setting or the app's own preference, both of which reach framer-motion
 * through the app's `<MotionConfig>`. framer-motion stops transform animations by itself under
 * reduced motion but keeps animating SVG attributes (a radar's points, a bar's width), so the
 * explainers ask here and pass a zero-length transition instead.
 */
import { useReducedMotionConfig, type Transition } from 'framer-motion'

const EASE: Transition = { duration: 0.45, ease: [0.32, 0.72, 0, 1] }

export function useCalmMotion(transition: Transition = EASE): { reduced: boolean; transition: Transition } {
    const reduced = useReducedMotionConfig() ?? false
    return { reduced, transition: reduced ? { duration: 0 } : transition }
}
