import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './styles/app.css';

// vite-plugin-pwa (registerType: 'autoUpdate') generates this virtual module
// at build time. It isn't present in every environment (e.g. some test/dev
// setups), so guard the import to avoid breaking the app if it's missing.
(async () => {
  try {
    const { registerSW } = await import('virtual:pwa-register');
    registerSW({ immediate: true });
  } catch {
    // PWA registration is best-effort; ignore if the virtual module isn't available.
  }
})();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
