import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/brand.css';
import './styles/app.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
