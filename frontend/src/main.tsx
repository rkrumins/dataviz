import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { useBrandingStore } from '@/store/branding'
import { startFeaturesSync, useFeaturesStore } from '@/store/features'
import { installRadixPointerEventsGuard } from '@/lib/radixPointerEventsGuard'

// Declare NO React components in this file. A module that declares one gets a
// react-refresh accept boundary from the Vite plugin, and an entry that accepts
// HMR is re-executed in place — running createRoot() below a second time on the
// same #root (two React trees, duplicate pollers). The app tree lives in App.tsx
// for exactly this reason; keep this file to boot side effects and the mount.

// Branding is public and independent of auth — kick the fetch off at module
// load so the tab title, favicon and accent colour resolve as early as
// possible (the store is seeded with stock defaults, so first paint is
// always correct even before this resolves). Fire-and-forget: a failure
// keeps the seed in place.
void useBrandingStore.getState().loadBranding()

// Feature flags ride the same boot pattern (public, fail-open to seeds) so
// admin-disabled areas (e.g. versioning) are hidden before first interaction.
void useFeaturesStore.getState().loadFeatures()
// …and keep them current. Without this, an admin turning a feature off reaches the database and
// the API, and reaches no open tab — not even their own — until someone hard-refreshes.
startFeaturesSync()

// App-wide safety net for the Radix body pointer-events freeze: a modal layer
// (Dialog / modal DropdownMenu) that unmounts while open can otherwise leave
// the entire app unclickable until a hard reload. Idempotent; lives for the
// whole app lifetime, independent of auth/routing.
installRadixPointerEventsGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
