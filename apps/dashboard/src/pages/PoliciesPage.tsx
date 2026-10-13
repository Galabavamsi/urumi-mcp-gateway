// Member deny rules ("tool permissions"). A denied tool is hidden from members' tool lists and rejected
// if they call it anyway. Admins are never restricted. Saving replaces the whole rule set (PUT).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { listPolicies, replacePolicies } from '../api/endpoints';
import { queryKeys, useServers } from '../api/queries';
import type { Policy, PolicyInput, UpstreamServer } from '../api/types';
import { PageHeader } from '../components/Controls';
import { EmptyState, ErrorNote, Loading, Spinner } from '../components/Feedback';

const ANY = '*';

interface Rule {
  /** Local row id for React keys; not sent to the gateway. */
  key: number;
  server: string;
  tool: string;
}

let nextKey = 1;
const toRule = (policy: Pick<Policy, 'server' | 'tool'>): Rule => ({ key: nextKey++, server: policy.server, tool: policy.tool });
const fingerprint = (rules: Pick<Rule, 'server' | 'tool'>[]) =>
  JSON.stringify(rules.map((r) => `${r.server}/${r.tool}`).sort());

export function PoliciesPage() {
  const policies = useQuery({ queryKey: queryKeys.policies, queryFn: listPolicies });
  const servers = useServers();

  return (
    <>
      <PageHeader
        title="Tool policies"
        description="Choose tools members may not use. They disappear from members' tool lists and calls to them are rejected and logged as denied. Admins can always use every tool."
      />
      {policies.isPending ? (
        <div className="panel">
          <Loading label="Loading policies" />
        </div>
      ) : policies.isError ? (
        <ErrorNote error={policies.error} onRetry={() => void policies.refetch()} />
      ) : (
        <PolicyEditor initial={policies.data} servers={servers.data ?? []} />
      )}
    </>
  );
}

function PolicyEditor({ initial, servers }: { initial: Policy[]; servers: UpstreamServer[] }) {
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<Rule[]>(() => initial.map(toRule));
  // What the gateway has now; compared with `rules` to know whether there are unsaved changes.
  const [savedPolicies, setSavedPolicies] = useState<Policy[]>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (input: PolicyInput[]) => replacePolicies(input),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.policies, result);
      // `allowedForMe` on the servers page depends on policies.
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
      setRules(result.map(toRule));
      setSavedPolicies(result);
      setSaved(true);
    },
  });

  const dirty = fingerprint(rules) !== fingerprint(savedPolicies);

  function update(key: number, patch: Partial<Rule>) {
    setSaved(false);
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  }

  function submit() {
    if (rules.some((rule) => !rule.server || !rule.tool)) {
      setProblem('Choose a server and a tool for every rule, or remove the incomplete ones.');
      return;
    }
    setProblem(null);
    // Drop exact duplicates; the gateway gets each rule once.
    const unique = [...new Map(rules.map((r) => [`${r.server}/${r.tool}`, r])).values()];
    save.mutate(unique.map((r) => ({ role: 'member', server: r.server, tool: r.tool, effect: 'deny' })));
  }

  return (
    <section className="panel overflow-hidden" aria-label="Member deny rules">
      {rules.length === 0 ? (
        <EmptyState title="Members can use every tool">Add a rule to keep a tool admin-only.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Tool</th>
                <th scope="col">Hidden from members</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, index) => (
                <tr key={rule.key}>
                  <td>
                    <select
                      className="input w-auto min-w-[170px]"
                      aria-label={`Server for rule ${index + 1}`}
                      value={rule.server}
                      // A tool name only makes sense for the server it was picked from.
                      onChange={(e) => update(rule.key, { server: e.target.value, tool: ANY })}
                    >
                      <option value="" disabled>
                        Choose a server
                      </option>
                      <option value={ANY}>Every server</option>
                      {withCurrent(servers.map((s) => s.slug), rule.server).map((slug) => (
                        <option key={slug} value={slug}>
                          {slug}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="input mono w-auto min-w-[200px]"
                      aria-label={`Tool for rule ${index + 1}`}
                      value={rule.tool}
                      onChange={(e) => update(rule.key, { tool: e.target.value })}
                      disabled={!rule.server}
                    >
                      <option value={ANY}>Every tool</option>
                      {withCurrent(toolNames(servers, rule.server), rule.tool).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="text-[13px] text-ink-2">
                    <Affected servers={servers} rule={rule} />
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="icon-btn hover:text-bad"
                      aria-label={`Remove rule ${index + 1}`}
                      onClick={() => {
                        setSaved(false);
                        setRules((current) => current.filter((r) => r.key !== rule.key));
                      }}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setSaved(false);
            setRules((current) => [...current, { key: nextKey++, server: '', tool: ANY }]);
          }}
        >
          <Plus aria-hidden="true" className="size-4" />
          Add rule
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {saved && !dirty && (
            <span role="status" className="text-sm text-ok">
              Saved. Members' tool lists change on their next request.
            </span>
          )}
          {dirty && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setRules(savedPolicies.map(toRule));
                setProblem(null);
              }}
            >
              Discard changes
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending && <Spinner />}
            Save policies
          </button>
        </div>
      </div>

      {(problem || save.isError) && (
        <div className="px-5 pb-4">
          <ErrorNote error={problem ? new Error(problem) : save.error} />
        </div>
      )}
    </section>
  );
}

/** Keeps a value that is no longer offered (e.g. a deleted server) visible in its select. */
function withCurrent(options: string[], current: string): string[] {
  return current && current !== ANY && !options.includes(current) ? [...options, current] : options;
}

/** Upstream tool names for one server, or for all servers when `server` is the wildcard. */
function toolNames(servers: UpstreamServer[], server: string): string[] {
  const relevant = server === ANY ? servers : servers.filter((s) => s.slug === server);
  return [...new Set(relevant.flatMap((s) => s.tools.map((t) => t.name)))].sort();
}

/** Shows which exposed tool names a rule hides, so the admin sees the effect before saving. */
function Affected({ servers, rule }: { servers: UpstreamServer[]; rule: Rule }) {
  if (!rule.server) return null;
  if (rule.server === ANY && rule.tool === ANY) return <span className="font-medium text-deny">Every tool on every server</span>;
  const names = servers
    .filter((s) => rule.server === ANY || s.slug === rule.server)
    .flatMap((s) => s.tools.filter((t) => rule.tool === ANY || t.name === rule.tool).map((t) => t.exposedName));
  if (names.length === 0) return <span>No current tools match</span>;
  const shown = names.slice(0, 3);
  return (
    <span>
      {shown.map((name, i) => (
        <span key={name}>
          {i > 0 && ', '}
          <code className="mono text-ink">{name}</code>
        </span>
      ))}
      {names.length > shown.length && ` and ${names.length - shown.length} more`}
    </span>
  );
}
