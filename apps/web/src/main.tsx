import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return <main className="shell"><h1>SzroNox</h1><p>Aplikacja jest gotowa do konfiguracji.</p></main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
