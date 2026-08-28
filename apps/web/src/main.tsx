import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './app.css';
import './font.css';
import './settings-leaf.css';
import { applyFontPreset, readFontPreset } from './lib/conversationFont';

applyFontPreset(readFontPreset());

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
