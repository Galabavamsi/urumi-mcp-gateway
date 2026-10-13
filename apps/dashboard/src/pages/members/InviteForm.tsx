import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { createInvite } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { CreatedInvite, Role } from '../../api/types';
import { Field } from '../../components/Controls';
import { CopyBlock } from '../../components/Copy';
import { ErrorNote, Spinner } from '../../components/Feedback';
import { formatDateTime } from '../../lib/format';

export function InviteForm() {
  const queryClient = useQueryClient();
  const ids = { email: useId(), role: useId() };
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const invite = useMutation({
    mutationFn: () => createInvite(email.trim(), role),
    onSuccess: (result) => {
      setCreated(result);
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.invites });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setCreated(null);
    invite.mutate();
  }

  return (
    <>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Email" htmlFor={ids.email}>
          <input
            id={ids.email}
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            autoComplete="off"
          />
        </Field>
        <Field label="Role" htmlFor={ids.role}>
          <select id={ids.role} className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <button type="submit" className="btn btn-primary" disabled={invite.isPending}>
            {invite.isPending && <Spinner />}
            Create invite link
          </button>
        </div>
      </form>

      {invite.isError && <ErrorNote error={invite.error} className="mt-4" />}

      {created && (
        <div className="mt-5 rounded-md border border-accent/30 bg-accent-soft/50 p-4">
          <CopyBlock
            label={`Invite link for ${created.email}`}
            help={`Send it privately. Valid until ${formatDateTime(created.expiresAt)}, for one use.`}
            text={created.inviteUrl}
          />
        </div>
      )}
    </>
  );
}
