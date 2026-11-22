/**
 * setupIntro — whether this browser has been shown the coach mark on "Set up with a guide". It is
 * done once it is dismissed, or once the guided setup opens by any route.
 */
import { introFlag } from '@/lib/introFlag'

export const SETUP_INTRO_KEY = 'synodic.versionedGraphs.setupIntro.v1'

const flag = introFlag(SETUP_INTRO_KEY)

export const markSetupIntroSeen: () => void = flag.mark

export const useSetupIntroSeen: () => boolean = flag.useSeen
