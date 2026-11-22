/**
 * Visual harness for the settings kit: mounts `SettingsKitHarness` (see that file for the
 * fixtures). Declares no components, so the page module keeps Fast Refresh.
 *
 *   npm run harness
 *   open http://localhost:5199/settings-harness.html?fixture=platform&theme=dark
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles/globals.css'
import { SettingsKitHarness } from './settingsKitHarness'

// No CSS transitions here: a headless screenshot freezes them on their first frame, so a staged
// change would be caught half-drawn (framer-motion's are skipped in the page module).
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; }'
document.head.appendChild(still)

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsKitHarness /></StrictMode>)
