import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { CompanionApp } from './App'
import { browserTokenStore, createCompanionClient } from './companion-client'
import { createGhosttyCompanionPane } from './ghostty-companion-pane'
import './styles.css'

const client = createCompanionClient({
  fetch: (url, init) => globalThis.fetch(url, init),
  tokens: browserTokenStore(() => globalThis.localStorage),
})

const container = document.getElementById('root')
if (!container) throw new Error('hvir companion: #root element not found')

createRoot(container).render(
  <StrictMode>
    <CompanionApp client={client} createPane={createGhosttyCompanionPane} />
  </StrictMode>,
)
