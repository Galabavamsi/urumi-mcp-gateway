// The signed-in shell: top bar (who you are, log out), navigation rail, and the page.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MessageSquareText, ScrollText, Server, ShieldBan, Store, Users, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { logout } from '../api/endpoints';
import { queryKeys, useConfig } from '../api/queries';
import { useCurrentUser } from '../auth/session';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { RoleTag } from '../components/StatusBadge';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const MAIN_NAV: NavItem[] = [
  { to: '/servers', label: 'Servers', icon: Server },
  { to: '/chat', label: 'Chat', icon: MessageSquareText },
  { to: '/keys', label: 'My API keys', icon: KeyRound },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/members', label: 'Members', icon: Users },
  { to: '/policies', label: 'Tool policies', icon: ShieldBan },
];

export function AppLayout() {
  const user = useCurrentUser();
  const config = useConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      // Forget everything we loaded as this user, then mark the session as gone.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      queryClient.setQueryData(queryKeys.me, null);
      navigate('/login', { replace: true });
    },
  });

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>

      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="flex h-14 items-center gap-4 px-4 md:px-6">
          <BrandMark />
          <div className="ml-auto flex min-w-0 items-center gap-3 text-sm">
            {config.data?.storeUrl && (
              <a
                href={config.data.storeUrl}
                target="_blank"
                rel="noreferrer"
                className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-ink-2 hover:bg-sunken hover:text-ink sm:inline-flex"
              >
                <Store aria-hidden="true" className="size-4" />
                Open storefront
              </a>
            )}
            <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-ink" title={user.email}>
                {user.name || user.email}
              </span>
              <RoleTag role={user.role} />
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              <LogOut aria-hidden="true" className="size-4" />
              Log out
            </button>
          </div>
        </div>
      </header>

      <div className="md:flex">
        <nav aria-label="Main" className="border-b border-line bg-surface md:sticky md:top-14 md:h-[calc(100vh-56px)] md:w-56 md:shrink-0 md:border-r md:border-b-0">
          <div className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-col md:px-3 md:py-5">
            {MAIN_NAV.map((item) => (
              <NavRailLink key={item.to} item={item} />
            ))}
            {user.role === 'admin' && (
              <>
                <p className="mt-5 mb-1 hidden px-3 text-xs font-medium text-ink-3 md:block">Team admin</p>
                <span className="mx-1 w-px shrink-0 bg-line md:hidden" aria-hidden="true" />
                {ADMIN_NAV.map((item) => (
                  <NavRailLink key={item.to} item={item} />
                ))}
              </>
            )}
          </div>
        </nav>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-[1180px]">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

function NavRailLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `relative flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${
          isActive
            ? 'bg-accent-soft font-medium text-accent-strong md:before:absolute md:before:inset-y-1.5 md:before:-left-3 md:before:w-[3px] md:before:rounded-r md:before:bg-accent'
            : 'text-ink-2 hover:bg-sunken hover:text-ink'
        }`
      }
    >
      <Icon aria-hidden="true" className="size-4" />
      {item.label}
    </NavLink>
  );
}

export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <circle cx="16" cy="16" r="14" className="fill-ink" />
        <circle cx="16" cy="16" r="8.5" fill="none" strokeWidth="2" className="stroke-[#5fb3cf]" />
        <circle cx="16" cy="16" r="4" className="fill-[#5fb3cf]" />
      </svg>
      <span className="font-display text-[1.125rem] leading-none font-semibold tracking-[0.01em] whitespace-nowrap text-ink">
        Urumi <span className="font-normal text-ink-2">gateway</span>
      </span>
    </div>
  );
}
