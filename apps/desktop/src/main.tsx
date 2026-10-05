import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HudErrorBoundary } from './HudErrorBoundary.js';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('root elementi bulunamadi');

createRoot(root).render(
  <StrictMode>
    <HudErrorBoundary>
      <App />
    </HudErrorBoundary>
  </StrictMode>,
);
