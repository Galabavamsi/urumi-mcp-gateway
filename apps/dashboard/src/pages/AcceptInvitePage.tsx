import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { acceptInvite, getInvite } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import { Field } from '../components/Controls';
import { ErrorNote, Loading, Spinner } from '../components/Feedback';
import { RoleTag } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';
import { PublicShell } from './PublicShell';

/** Same rule as the gateway (docs/API.md): at least 10 characters. */
const MIN_PASSWORD = 10;

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => getInvite(token), retry: false });

  return (
    <PublicShell>
      {invite.isPending ? (
        <Loading label="Checking your invite" />
      ) : invite.isError ? (
        <InviteProblem error={invite.error} />
      ) : (
        <>
          <h1 className="page-title">Join the team</h1>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-line bg-surface px-4 py-3 text-sm">
            <dt className="text-ink-2">Email</dt>
            <dd className="font-medium break-all">{invite.data.email}</dd>
            <dt className="text-ink-2">Role</dt>
            <dd>
              <RoleTag role={invite.data.role} />
            </dd>
            <dt className="text-ink-2">Link valid until</dt>
            <dd>{formatDateTime(invite.data.expiresAt)}</dd>
          </dl>
          <AcceptForm token={token} />
        </>
      )}
    </PublicShell>
  );
}

function InviteProblem({ error }: { error: unknown }) {
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <>
      <h1 className="page-title">{gone ? 'This invite link no longer works' : 'Could not check this invite'}</h1>
      {gone ? (
        <p className="mt-2 text-ink-2">
          It may have been used already, revoked, or it expired (links last 72 hours). Ask the admin who invited you
          for a new link.
        </p>
      ) : (
        <ErrorNote error={error} className="mt-4" />
      )}
      <Link to="/login" className="btn btn-secondary mt-6">
        Go to sign in
      </Link>
    </>
  );
}

function AcceptForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ids = { name: useId(), password: useId(), confirm: useId() };
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => acceptInvite(token, name.trim(), password),
    onSuccess: (user) => {
      // The gateway also set our session cookie, so we are signed in now.
      queryClient.setQueryData(queryKeys.me, user);
      navigate('/servers', { replace: true });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length === 0) return setProblem('Enter your name.');
    if (password.length < MIN_PASSWORD) return setProblem(`Use at least ${MIN_PASSWORD} characters for the password.`);
    if (password !== confirm) return setProblem('The two passwords do not match.');
    setProblem(null);
    accept.mutate();
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-5">
      <Field label="Your name" htmlFor={ids.name} help="Shown to admins in the members list and the audit log.">
        <input id={ids.name} className="input" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor={ids.password} help={`At least ${MIN_PASSWORD} characters.`}>
        <input
          id={ids.password}
          className="input"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Repeat password" htmlFor={ids.confirm}>
        <input
          id={ids.confirm}
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>

      {problem && <ErrorNote error={new Error(problem)} />}
      {accept.isError && <ErrorNote error={accept.error} />}

      <button type="submit" className="btn btn-primary w-full" disabled={accept.isPending}>
        {accept.isPending && <Spinner />}
        Create account and sign in
      </button>
    </form>
  );
}
