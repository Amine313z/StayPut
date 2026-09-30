import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routes } from './App';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './theme';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <RouterProvider router={createBrowserRouter(routes)} />
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
