// Who is signed in, and the route guards built on it.
//
// The session itself is an HttpOnly cookie the browser manages; JavaScript can't read it. We learn who we
// are by asking the gateway (GET /api/auth/me) and keep the answer in the TanStack Query cache under
// ['me']. `null` there means "signed out". Setting it to null (logout, or any 401 from the API) makes
// <RequireAuth> send the user to /login.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { setUnauthorizedHandler } from '../api/client';
import { getMe } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import type { User } from '../api/types';
import { ErrorNote, Loading } from '../components/Feedback';

const UserContext = createContext<User | null>(null);

/** The signed-in user. Only valid inside <RequireAuth>, which guarantees one exists. */
export function useCurrentUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useCurrentUser() used outside <RequireAuth>');
  return user;
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: getMe, staleTime: 60_000, retry: false });
}

/** Wires API 401s to "signed out": every page then falls back to the login screen. */
export function SessionExpiryBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => queryClient.setQueryData(queryKeys.me, null));
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);
  return null;
}

export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading label="Checking your session" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md px-4 pt-24">
        <ErrorNote error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) {
    // Remember where the user was going, so login can take them back there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return (
    <UserContext value={me.data}>
      <Outlet />
    </UserContext>
  );
}

/** Admin-only pages. Members never see the links; this also covers typed-in URLs. */
export function RequireAdmin() {
  const user = useCurrentUser();
  if (user.role !== 'admin') return <Navigate to="/servers" replace />;
  return <Outlet />;
}
