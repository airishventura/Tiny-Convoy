import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

/**
 * StrictMode is deliberately off. It double-invokes effects, which would spawn
 * the physics world and start the run controller twice; the simulation is not
 * idempotent and the app is small enough to audit by hand instead.
 */
createRoot(container).render(<App />);
