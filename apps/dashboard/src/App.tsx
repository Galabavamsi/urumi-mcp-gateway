// Every route of the dashboard. Public: login and invite acceptance. Everything else needs a session;
// Members, Tool policies and Observability additionally need the admin role.
import { Navigate, Route, Routes } from 'react-router';
import { RequireAdmin, RequireAuth, SessionExpiryBridge } from './auth/session';
import { AppLayout } from './layout/AppLayout';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { AuditPage } from './pages/AuditPage';
import { ChatPage } from './pages/chat/ChatPage';
import { KeysPage } from './pages/keys/KeysPage';
import { LoginPage } from './pages/LoginPage';
import { MembersPage } from './pages/members/MembersPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ObservabilityPage } from './pages/observability/ObservabilityPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { ServersPage } from './pages/servers/ServersPage';

export function App() {
  return (
    <>
      <SessionExpiryBridge />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />

        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/servers" replace />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="members" element={<MembersPage />} />
              <Route path="policies" element={<PoliciesPage />} />
              <Route path="observability" element={<ObservabilityPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}
