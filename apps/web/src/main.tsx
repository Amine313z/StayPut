import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routes } from './App';
import { I18nProvider, detectLocale } from './i18n';
import { ThemeProvider } from './theme';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

// The page says its language before anything is drawn: browsers read it early to decide
// whether to offer a translation (a French page declared English got one).
const locale = detectLocale();
document.documentElement.lang = locale;

createRoot(root).render(
  <StrictMode>
    <I18nProvider initialLocale={locale}>
      <ThemeProvider>
        <RouterProvider router={createBrowserRouter(routes)} />
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
