// Copied from workflows/web/src/app/auth.tsx — changes: none
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { API_CONFIGURED, API_IS_LOCAL, onSessionLost } from '../api/client';
import {
  clearSharedToken,
  decodeToken,
  readSharedToken,
  watchSharedSession,
  writeSharedToken,
} from '../auth/sharedSession';
import { NotConfiguredScreen, SignInScreen } from '../screens/SignInScreen';

/**
 * The sign-in gate. Nothing below it mounts — and no API call is made — until there is a
 * credential the gateway will actually take.
 *
 * The credential is the estate-wide one (see `auth/sharedSession.ts`): one Google ID token
 * in a cookie on `.built-form.co.uk`, so a sign-in in any sibling app lands here as a
 * signed-in session, and a sign-out anywhere ends it here too. `watchSharedSession` also
 * renews it silently a few minutes before it lapses, so a tab left open all day does not
 * drop someone mid-inspection.
 *
 * **Local dev is exempt.** Against `npm run dev` in `api/` the server bypasses auth and
 * resolves everyone as `local@dev`; demanding a credential it never reads would lock out
 * anyone off the allowlist for no gain.
 */

interface AuthValue {
  token: string | null;
  email: string | null;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue>({ token: null, email: null, signOut: () => undefined });

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readSharedToken());
  // "Ran out" reads differently from "never signed in", and only one of them is worth an
  // apology. Set when a session we HAD goes away.
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    return watchSharedSession((next) => {
      setToken((prev) => {
        if (prev && !next) setExpired(true);
        return next;
      });
    });
  }, []);

  // A 401 the transport judged to be a dead credential, rather than a refused account.
  useEffect(() => {
    return onSessionLost(() => {
      setToken(null);
      setExpired(true);
    });
  }, []);

  const signOut = useCallback(() => {
    clearSharedToken();
    setToken(null);
    setExpired(false);
  }, []);

  const email = useMemo(() => decodeToken(token)?.email ?? null, [token]);
  const value = useMemo<AuthValue>(() => ({ token, email, signOut }), [token, email, signOut]);

  // Checked before the session: without an address, "signed in" and "signed out" both end in
  // the same three 404s, and the sign-in screen would be a lie about what is wrong.
  if (!API_CONFIGURED) return <NotConfiguredScreen />;

  if (!token && !API_IS_LOCAL) {
    return (
      <SignInScreen
        expired={expired}
        onSignedIn={(credential) => {
          // writeSharedToken already ran in the screen; re-read so the cookie stays the one
          // source of truth rather than trusting a value we happen to be holding.
          if (!writeSharedToken(credential)) return;
          setExpired(false);
          setToken(readSharedToken());
        }}
      />
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
