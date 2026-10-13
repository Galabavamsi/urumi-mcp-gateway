// Pieces shared by "My API keys" and the admin's per-member key dialog.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { createKey, revokeKey } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { ApiKey, CreatedApiKey } from '../../api/types';
import { ErrorNote, Spinner } from '../../components/Feedback';
import { ConfirmDialog } from '../../components/Modal';
import { formatDateTime, formatRelative } from '../../lib/format';

/** Name + button. Calls `onCreated` with the full key, which the caller shows once. */
export function CreateKeyForm({ userId, onCreated }: { userId?: string; onCreated: (key: CreatedApiKey) => void }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => createKey(name.trim(), userId),
    onSuccess: (created) => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.allKeys });
      onCreated(created);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor={inputId} className="field-label">
        Key name
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          className="input max-w-sm flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Laptop, Claude Code"
          maxLength={80}
          required
        />
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim()}>
          {create.isPending && <Spinner />}
          Create key
        </button>
      </div>
      <p className="field-help">Name it after where you will use it, so you know which one to revoke later.</p>
      {create.isError && <ErrorNote error={create.error} className="mt-3" />}
    </form>
  );
}

export function KeysTable({ keys, showOwner = false }: { keys: ApiKey[]; showOwner?: boolean }) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => revokeKey(key.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.allKeys }),
  });

  // Active keys first, newest first within each group.
  const sorted = [...keys].sort(
    (a, b) => Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt)) || b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Key</th>
              {showOwner && <th scope="col">Owner</th>}
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((key) => (
              <tr key={key.id} className={key.revokedAt ? 'text-ink-3' : ''}>
                <td className="font-medium">{key.name}</td>
                <td>
                  <code className="mono">{key.prefix}</code>
                </td>
                {showOwner && <td className="break-all">{key.userEmail}</td>}
                <td className="whitespace-nowrap" title={formatDateTime(key.createdAt)}>
                  {formatRelative(key.createdAt)}
                </td>
                <td className="whitespace-nowrap" title={formatDateTime(key.lastUsedAt)}>
                  {formatRelative(key.lastUsedAt)}
                </td>
                <td className="whitespace-nowrap">
                  {key.revokedAt ? (
                    <span title={formatDateTime(key.revokedAt)}>Revoked {formatRelative(key.revokedAt)}</span>
                  ) : (
                    <span className="font-medium text-ok">Active</span>
                  )}
                </td>
                <td className="text-right">
                  {!key.revokedAt && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm hover:text-bad"
                      aria-label={`Revoke key ${key.name}`}
                      onClick={() => setRevoking(key)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name ?? 'key'}"?`}
        confirmLabel="Revoke key"
        onConfirm={() => revoke.mutateAsync(revoking!)}
      >
        The next MCP request that uses <code className="mono text-ink">{revoking?.prefix}</code> is rejected, and the
        rejection is recorded in the audit log. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
