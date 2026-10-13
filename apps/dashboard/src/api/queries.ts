// Query keys and the shared read hooks. Keeping every key here means invalidation after a change
// ("servers changed, refetch them") always names the same key the reader used.
import { QueryClient, useQuery } from '@tanstack/react-query';
import { ApiError } from './client';
import * as endpoints from './endpoints';

export const queryKeys = {
  me: ['me'] as const,
  config: ['config'] as const,
  servers: ['servers'] as const,
  users: ['users'] as const,
  invites: ['invites'] as const,
  policies: ['policies'] as const,
  /** `undefined` = my own keys; a user id or 'all' = admin views. */
  keys: (userId?: string) => ['keys', userId ?? 'mine'] as const,
  allKeys: ['keys'] as const,
  audit: (filters: object) => ['audit', filters] as const,
  stats: ['stats'] as const,
};

/** How often the servers page re-reads status, so a killed pod shows as unreachable within seconds. */
export const SERVER_POLL_MS = 3000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry only failures that might go away by themselves (network blip, gateway restarting).
        // A 4xx answer will be the same next time, so show it straight away.
        retry: (failureCount, err) => {
          const transient = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
          return transient && failureCount < 2;
        },
        staleTime: 5_000,
      },
    },
  });
}

export function useConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: endpoints.getConfig, staleTime: Infinity });
}

export function useServers(options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.servers,
    queryFn: endpoints.listServers,
    refetchInterval: options.poll ? SERVER_POLL_MS : false,
  });
}

/** Live per-server statistics (admins only: pass `enabled: false` for members, who would get 403). */
export function useStats(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: endpoints.getStats,
    enabled: options.enabled ?? true,
    refetchInterval: SERVER_POLL_MS,
  });
}

export function useUsers(enabled = true) {
  return useQuery({ queryKey: queryKeys.users, queryFn: endpoints.listUsers, enabled });
}
