import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';
import './styles/responsive.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到应用挂载节点');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/admin">
      <AuthProvider><App /></AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
