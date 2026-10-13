// Admin view of one member's API keys: issue a key for them (shown once, to hand over) or revoke one.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listKeys } from '../../api/endpoints';
import { queryKeys, useConfig } from '../../api/queries';
import type { CreatedApiKey, User } from '../../api/types';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback';
import { Modal } from '../../components/Modal';
import { CreateKeyForm, KeysTable } from '../keys/KeyParts';
import { KeyReveal } from '../keys/KeyReveal';

export function UserKeysModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      wide
      title={`API keys for ${user?.name || user?.email || ''}`}
      description={user?.email}
    >
      {user && <UserKeys user={user} />}
    </Modal>
  );
}

function UserKeys({ user }: { user: User }) {
  const config = useConfig();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const keys = useQuery({ queryKey: queryKeys.keys(user.id), queryFn: () => listKeys(user.id) });

  return (
    <div className="grid gap-5">
      {created ? (
        <KeyReveal created={created} mcpUrl={config.data?.mcpUrl} onDismiss={() => setCreated(null)} />
      ) : user.status === 'disabled' ? (
        <p className="text-sm text-ink-2">This member is disabled. Enable them before issuing a key.</p>
      ) : (
        <CreateKeyForm userId={user.id} onCreated={setCreated} />
      )}

      <div className="overflow-hidden rounded-md border border-line">
        {keys.isPending ? (
          <Loading label="Loading keys" />
        ) : keys.isError ? (
          <div className="p-4">
            <ErrorNote error={keys.error} onRetry={() => void keys.refetch()} />
          </div>
        ) : keys.data.length === 0 ? (
          <EmptyState title="No keys yet" />
        ) : (
          <KeysTable keys={keys.data} />
        )}
      </div>
    </div>
  );
}
