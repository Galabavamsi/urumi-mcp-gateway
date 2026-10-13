// Tool permissions (stand-out item). Policies are deny rules for the `member` role; admins are never restricted.
// A rule names a server slug (or '*') and an ORIGINAL upstream tool name (or '*'), never an exposed name, so the
// rule means the same thing however the tool is exposed.
import type { Role } from '../types.ts';

export interface ToolPolicy {
  role: 'member';
  server: string; // slug or '*'
  tool: string; // original tool name or '*'
  effect: 'deny';
}

/** The default seeded once at first start: members can read the store but not change it. */
export const DEFAULT_POLICIES: readonly ToolPolicy[] = [
  { role: 'member', server: 'woo', tool: 'create_product', effect: 'deny' },
  { role: 'member', server: 'woo', tool: 'update_order_status', effect: 'deny' },
];

export function isToolDenied(
  policies: readonly ToolPolicy[],
  role: Role,
  serverSlug: string,
  toolName: string,
): boolean {
  if (role === 'admin') return false;
  return policies.some(
    (policy) =>
      policy.effect === 'deny' &&
      policy.role === role &&
      (policy.server === '*' || policy.server === serverSlug) &&
      (policy.tool === '*' || policy.tool === toolName),
  );
}
