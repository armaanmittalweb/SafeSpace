import { render } from 'preact';
import './styles/tokens.css';
import './styles/product.css';
import { countViews } from './beacon';
import { applyTheme } from './app/theme';

const path = location.pathname.replace(/\/+$/, '');
const root = document.getElementById('app')!;
countViews('safespace');
applyTheme();

if (path === '/embed') {
  // The portfolio Lab frames the original recorder here; it keeps its own (scoped) styles.
  void Promise.all([import('./embed/Embed'), import('./styles/sim.css')]).then(([{ Embed }]) => render(<div class="sim"><Embed /></div>, root));
} else {
  void import('./app/App').then(({ App }) => render(<App />, root));
  if ('serviceWorker' in navigator && import.meta.env.PROD && !import.meta.env.VITE_FAKE) {
    addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
}
