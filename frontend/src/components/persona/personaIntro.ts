/**
 * personaIntro — whether this browser has been shown what the Business view
 * is, and how to reach every tool. The tip shows until it is dismissed or the
 * persona is changed by any route.
 */
import { introFlag } from '@/lib/introFlag'


export const PERSONA_INTRO_KEY = 'synodic.persona.intro.v1'

const flag = introFlag(PERSONA_INTRO_KEY)

export const markPersonaIntroSeen: () => void = flag.mark

export const usePersonaIntroSeen: () => boolean = flag.useSeen
