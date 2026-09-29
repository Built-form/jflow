// Copied from workflows/web/src/main.tsx — changes: none
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { App } from './App';
import { AuthGate } from './app/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { EnvBanner } from './components/EnvBanner';
import { SessionProvider } from './app/session';
import { GOOGLE_CLIENT_ID } from './auth/sharedSession';
import { APP_ENV, windowTitle } from './config/env';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';

// The tab must say which environment it is before anyone reads a number off it.
document.title = windowTitle(APP_ENV);

// The gate sits ABOVE SessionProvider on purpose: `/me`, `/meta/enums` and `/users` are the
// first three calls the app makes, and firing them without a credential would just be three
// 401s on boot.
// The boundary sits above everything: a throw in a provider is as blank as one in a screen.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <BrowserRouter>
          <AuthGate>
            <SessionProvider>
              <App />
            </SessionProvider>
          </AuthGate>
        </BrowserRouter>
      </GoogleOAuthProvider>
    </ErrorBoundary>
    {/* Outside the auth gate and the boundary: the environment marker has to show on
        the sign-in screen and on the crash screen too. */}
    <EnvBanner />
  </StrictMode>,
);
