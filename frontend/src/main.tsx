import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { GraphProvider } from '@/providers/GraphProviderContext'

// GraphProvider now manages the RemoteGraphProvider lifecycle internally,
// creating a connection-scoped instance whenever the active connection changes.
// No singleton is needed here.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GraphProvider>
      <App />
    </GraphProvider>
  </React.StrictMode>,
)

