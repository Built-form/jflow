// Copied from workflows/web/src/app/session.tsx — changes: theme storage key workflows.theme → jflow.theme; default theme light, not dark (its boot reads — /me, /meta/enums, /users — all exist in JFlow, so none were dropped)
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { AllowedUser, Me, MetaEnums } from '../api/types';

/**
 * Boot state: `GET /me`, then `GET /meta/enums` once and cached for the session, plus the
 * allowlist (assignees are always picked from it, never typed).
 */

type Theme = 'dark' | 'light';

interface SessionValue {
  me: Me | null;
  enums: MetaEnums | null;
  users: AllowedUser[];
  ready: boolean;
  /** Kept as the error, not a string: a 401 here means the ACCOUNT was refused. */
  bootError: ApiError | null;
  theme: Theme;
  /** null = follow the device. A manual choice is persisted. */
  themeChoice: Theme | null;
  setTheme: (theme: Theme | null) => void;
  refreshUsers: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);
const THEME_KEY = 'jflow.theme';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [enums, setEnums] = useState<MetaEnums | null>(null);
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<ApiError | null>(null);

  const [themeChoice, setThemeChoice] = useState<Theme | null>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    return stored === 'dark' || stored === 'light' ? stored : null;
  });
  // Light by default (Dev's decision for JFlow, 2026-09-30; workflows chose dark on
  // 2026-08-21). The app does not follow the device preference — light unless the
  // person picked Dark with the toggle.
  const theme = themeChoice ?? 'light';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme | null) => {
    setThemeChoice(next);
    if (next) localStorage.setItem(THEME_KEY, next);
    else localStorage.removeItem(THEME_KEY);
  }, []);

  const refreshUsers = useCallback(() => {
    api.users
      .list()
      .then((res) => setUsers(res.data))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.meta.me(), api.meta.enums(), api.users.list()])
      .then(([meRes, enumsRes, usersRes]) => {
        if (!live) return;
        setMe(meRes);
        setEnums(enumsRes);
        setUsers(usersRes.data);
      })
      .catch((e: unknown) => {
        if (live) {
          setBootError(
            e instanceof ApiError ? e : new ApiError(0, { error: 'Could not start the app.' }),
          );
        }
      })
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ me, enums, users, ready, bootError, theme, themeChoice, setTheme, refreshUsers }),
    [me, enums, users, ready, bootError, theme, themeChoice, setTheme, refreshUsers],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/** Null outside a provider — for a screen that only adds something when it knows who is here. */
export function useSessionOptional(): SessionValue | null {
  return useContext(SessionContext);
}

/** Display name for an allowlist address, falling back to the local part. */
export function useDisplayName(): (email: string | null | undefined) => string {
  const { users } = useSession();
  return useCallback(
    (email: string | null | undefined) => {
      if (!email) return '—';
      return users.find((u) => u.email === email)?.displayName ?? email.split('@')[0];
    },
    [users],
  );
}
