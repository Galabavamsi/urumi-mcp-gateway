// Status colours carry meaning, and always come with a text label (never colour alone).
//   green  = working             red    = the upstream failed
//   amber  = in progress / slow  grey   = switched off
//   purple = refused by the gateway's own rules (policy denial, rejected key)
import type { AuditStatus, Role, ServerStatus } from '../api/types';

const SERVER_STATUS: Record<ServerStatus, { label: string; text: string; bg: string; lamp: string; ring: string }> = {
  connected: { label: 'Connected', text: 'text-ok', bg: 'bg-ok-soft', lamp: 'bg-ok-lamp', ring: 'ring-ok-soft' },
  unreachable: { label: 'Unreachable', text: 'text-bad', bg: 'bg-bad-soft', lamp: 'bg-bad-lamp', ring: 'ring-bad-soft' },
  connecting: { label: 'Connecting', text: 'text-warn', bg: 'bg-warn-soft', lamp: 'bg-warn-lamp', ring: 'ring-warn-soft' },
  disabled: { label: 'Disabled', text: 'text-off', bg: 'bg-off-soft', lamp: 'bg-off-lamp', ring: 'ring-off-soft' },
};

/** The switchboard lamp. It blinks only while connecting (and not at all with reduced motion). */
export function Lamp({ status }: { status: ServerStatus }) {
  const style = SERVER_STATUS[status];
  const pulse = status === 'connecting' ? 'animate-lamp' : '';
  return <span aria-hidden="true" className={`inline-block size-3 shrink-0 rounded-full ring-[5px] ${style.lamp} ${style.ring} ${pulse}`} />;
}

/** Text label for a server status; sits next to the row's lamp, so it carries no dot of its own. */
export function ServerStatusBadge({ status }: { status: ServerStatus }) {
  const style = SERVER_STATUS[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ${style.text} ${style.bg}`}>
      {style.label}
    </span>
  );
}

const AUDIT_STATUS: Record<AuditStatus, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'text-ok bg-ok-soft' },
  error: { label: 'Error', className: 'text-bad bg-bad-soft' },
  unreachable: { label: 'Unreachable', className: 'text-bad bg-bad-soft' },
  timeout: { label: 'Timed out', className: 'text-warn bg-warn-soft' },
  denied: { label: 'Denied', className: 'text-deny bg-deny-soft' },
  auth_rejected: { label: 'Key rejected', className: 'text-deny bg-deny-soft' },
};

export const AUDIT_STATUS_LABELS = Object.fromEntries(
  Object.entries(AUDIT_STATUS).map(([status, { label }]) => [status, label]),
) as Record<AuditStatus, string>;

export function AuditStatusChip({ status }: { status: AuditStatus }) {
  const style = AUDIT_STATUS[status];
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${style.className}`}>
      {style.label}
    </span>
  );
}

export function RoleTag({ role }: { role: Role }) {
  return role === 'admin' ? (
    <span className="inline-flex rounded px-1.5 py-px text-xs font-medium text-accent bg-accent-soft">Admin</span>
  ) : (
    <span className="inline-flex rounded px-1.5 py-px text-xs font-medium text-off bg-off-soft">Member</span>
  );
}
