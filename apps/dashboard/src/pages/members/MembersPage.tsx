import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { listInvites, revokeInvite, updateUser } from '../../api/endpoints';
import { queryKeys, useUsers } from '../../api/queries';
import type { PendingInvite, Role, User } from '../../api/types';
import { useCurrentUser } from '../../auth/session';
import { PageHeader } from '../../components/Controls';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback';
import { ConfirmDialog } from '../../components/Modal';
import { RoleTag } from '../../components/StatusBadge';
import { formatDateTime, formatRelative } from '../../lib/format';
import { InviteForm } from './InviteForm';
import { UserKeysModal } from './UserKeysModal';

export function MembersPage() {
  const me = useCurrentUser();
  const users = useUsers();
  const invites = useQuery({ queryKey: queryKeys.invites, queryFn: listInvites });
  const queryClient = useQueryClient();

  const [disabling, setDisabling] = useState<User | null>(null);
  const [keysFor, setKeysFor] = useState<User | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<PendingInvite | null>(null);

  const update = useMutation({
    mutationFn: ({ user, patch }: { user: User; patch: { role?: Role; status?: User['status'] } }) =>
      updateUser(user.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
      // Disabling a user also revokes their keys on the server.
      void queryClient.invalidateQueries({ queryKey: queryKeys.allKeys });
    },
  });
  const cancelInvite = useMutation({
    mutationFn: (invite: PendingInvite) => revokeInvite(invite.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites }),
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="Admins manage servers, members and policies and see every audit row. Members use the tools and manage their own keys."
      />

      <div className="grid gap-6">
        <section className="panel overflow-hidden" aria-labelledby="people-heading">
          <h2 id="people-heading" className="section-title border-b border-line px-5 py-3.5">
            People
          </h2>
          {update.isError && (
            <div className="px-5 pt-4">
              <ErrorNote error={update.error} />
            </div>
          )}
          {users.isPending ? (
            <Loading label="Loading members" />
          ) : users.isError ? (
            <div className="p-5">
              <ErrorNote error={users.error} onRetry={() => void users.refetch()} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.map((user) => {
                    const isMe = user.id === me.id;
                    const disabled = user.status === 'disabled';
                    return (
                      <tr key={user.id} className={disabled ? 'text-ink-3' : ''}>
                        <td>
                          <p className="font-medium">
                            {user.name || 'No name yet'}
                            {isMe && <span className="ml-1.5 text-xs font-normal text-ink-3">(you)</span>}
                          </p>
                          <p className="text-[13px] break-all text-ink-2">{user.email}</p>
                        </td>
                        <td>
                          {isMe ? (
                            <span title="You can't change your own role">
                              <RoleTag role={user.role} />
                            </span>
                          ) : (
                            <select
                              className="input h-8 w-auto py-0 text-[13px]"
                              aria-label={`Role for ${user.email}`}
                              value={user.role}
                              disabled={update.isPending}
                              onChange={(e) => update.mutate({ user, patch: { role: e.target.value as Role } })}
                            >
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                            </select>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          {disabled ? 'Disabled' : <span className="font-medium text-ok">Active</span>}
                        </td>
                        <td className="whitespace-nowrap" title={formatDateTime(user.lastSeenAt)}>
                          {formatRelative(user.lastSeenAt)}
                        </td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setKeysFor(user)}
                              aria-label={`API keys for ${user.email}`}
                            >
                              <KeyRound aria-hidden="true" className="size-3.5" />
                              Keys
                            </button>
                            {!isMe &&
                              (disabled ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={update.isPending}
                                  onClick={() => update.mutate({ user, patch: { status: 'active' } })}
                                  aria-label={`Enable ${user.email}`}
                                >
                                  Enable
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm hover:text-bad"
                                  onClick={() => setDisabling(user)}
                                  aria-label={`Disable ${user.email}`}
                                >
                                  Disable
                                </button>
                              ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section className="panel px-5 py-5" aria-labelledby="invite-heading">
            <h2 id="invite-heading" className="section-title">
              Invite someone
            </h2>
            <p className="mt-1 mb-4 text-sm text-ink-2">
              You get a link to send them yourself. It works once and expires after 72 hours.
            </p>
            <InviteForm />
          </section>

          <section className="panel overflow-hidden" aria-labelledby="pending-heading">
            <h2 id="pending-heading" className="section-title border-b border-line px-5 py-3.5">
              Pending invites
            </h2>
            {invites.isPending ? (
              <Loading label="Loading invites" />
            ) : invites.isError ? (
              <div className="p-5">
                <ErrorNote error={invites.error} onRetry={() => void invites.refetch()} />
              </div>
            ) : invites.data.length === 0 ? (
              <EmptyState title="No pending invites" />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Expires</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.data.map((invite) => (
                      <tr key={invite.id}>
                        <td className="break-all">{invite.email}</td>
                        <td>
                          <RoleTag role={invite.role} />
                        </td>
                        <td className="whitespace-nowrap" title={formatDateTime(invite.expiresAt)}>
                          {formatRelative(invite.expiresAt)}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm hover:text-bad"
                            onClick={() => setRevokingInvite(invite)}
                            aria-label={`Revoke invite for ${invite.email}`}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={disabling !== null}
        onClose={() => setDisabling(null)}
        title={`Disable ${disabling?.name || disabling?.email || 'member'}?`}
        confirmLabel="Disable member"
        onConfirm={() => update.mutateAsync({ user: disabling!, patch: { status: 'disabled' } })}
      >
        They are signed out everywhere and every API key they own stops working immediately. You can enable them
        again later, but they will need new keys.
      </ConfirmDialog>

      <ConfirmDialog
        open={revokingInvite !== null}
        onClose={() => setRevokingInvite(null)}
        title="Revoke this invite?"
        confirmLabel="Revoke invite"
        onConfirm={() => cancelInvite.mutateAsync(revokingInvite!)}
      >
        The link sent to <span className="font-medium text-ink">{revokingInvite?.email}</span> stops working. You can
        send a new invite at any time.
      </ConfirmDialog>

      <UserKeysModal user={keysFor} onClose={() => setKeysFor(null)} />
    </>
  );
}
