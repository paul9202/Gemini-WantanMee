import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { startServiceWorker } from './app/swUpdate';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startServiceWorker();
