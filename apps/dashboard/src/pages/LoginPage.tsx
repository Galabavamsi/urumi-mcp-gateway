import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { login } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import { useMe } from '../auth/session';
import { Field } from '../components/Controls';
import { ErrorNote, Spinner } from '../components/Feedback';
import { PublicShell } from './PublicShell';

/** Where to go after signing in: back to the page that sent us here, but only to a path on this site. */
function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/servers';
}

export function LoginPage() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ids = { email: useId(), password: useId() };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => login(email.trim(), password),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.me, user);
      navigate(returnPath(location.state), { replace: true });
    },
  });

  // Already signed in (e.g. opened /login in a new tab): go straight in.
  if (me.data) return <Navigate to={returnPath(location.state)} replace />;

  function submit(event: FormEvent) {
    event.preventDefault();
    signIn.mutate();
  }

  return (
    <PublicShell>
      <h1 className="page-title">Sign in</h1>
      <p className="mt-1 text-ink-2">Use the email and password from your invite.</p>

      <form onSubmit={submit} className="mt-8 space-y-5" noValidate={false}>
        <Field label="Email" htmlFor={ids.email}>
          <input
            id={ids.email}
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor={ids.password}>
          <input
            id={ids.password}
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {signIn.isError && <ErrorNote error={signIn.error} />}

        <button type="submit" className="btn btn-primary w-full" disabled={signIn.isPending}>
          {signIn.isPending && <Spinner />}
          Sign in
        </button>
      </form>

      <p className="mt-8 border-t border-line pt-5 text-sm text-ink-2">
        New to the team? Ask an admin for an invite link. It sets up your account in one step.
      </p>
    </PublicShell>
  );
}
