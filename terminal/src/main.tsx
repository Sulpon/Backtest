import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/tokens.css'
import App from './App.tsx'
import { startMarketStructureLogger } from './marketStructure/marketStructureLogger'

// Independent of React's render tree on purpose - it only observes
// useDrawingStore (see marketStructureLogger.ts), so it starts once here
// rather than from inside any chart/drawing component.
startMarketStructureLogger()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
