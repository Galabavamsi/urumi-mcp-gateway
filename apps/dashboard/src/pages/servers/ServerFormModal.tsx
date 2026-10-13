// Add or edit an upstream MCP server. The gateway validates everything again (SSRF guard, slug rules);
// these checks are only here to give quick, specific feedback next to the right field.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { createServer, updateServer } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { AuthType, CreateServerInput, UpdateServerInput, UpstreamServer } from '../../api/types';
import { Field } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Feedback';
import { Modal, ModalActions } from '../../components/Modal';

/** Same rule as the gateway (docs/CONTRACTS.md, "Tool exposure rules"). */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,11}$/;
/** HTTP header names are "tokens": letters, digits and a few symbols; we allow the common subset. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

interface FormState {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  headerName: string;
  credential: string;
  timeoutMs: string;
  allowlist: string;
}

type FieldErrors = Partial<Record<keyof FormState, string>>;

function initialState(server: UpstreamServer | null): FormState {
  return {
    slug: server?.slug ?? '',
    name: server?.name ?? '',
    url: server?.url ?? '',
    authType: server?.authType ?? 'bearer',
    headerName: server?.headerName ?? '',
    credential: '', // write-only: never pre-filled, the gateway never sends it back
    timeoutMs: server?.timeoutMs ? String(server.timeoutMs) : '',
    allowlist: server?.toolAllowlist?.join('\n') ?? '',
  };
}

function parseAllowlist(text: string): string[] | null {
  const names = text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : null;
}

function validate(form: FormState, server: UpstreamServer | null): FieldErrors {
  const errors: FieldErrors = {};
  if (!server && !SLUG_PATTERN.test(form.slug)) {
    errors.slug = '2 to 12 characters: lowercase letters, digits and dashes, starting with a letter.';
  }
  if (form.name.trim().length === 0) errors.name = 'Enter a name.';
  try {
    const url = new URL(form.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.url = 'Use an http:// or https:// address.';
  } catch {
    errors.url = 'Enter a full URL, for example https://mcp.example.com/mcp';
  }
  if (form.authType === 'header' && !HEADER_NAME_PATTERN.test(form.headerName)) {
    errors.headerName = 'Enter a header name such as x-api-key.';
  }
  const needsCredential = form.authType !== 'none' && !(server?.hasCredential && server.authType !== 'none');
  if (needsCredential && form.credential.length === 0) errors.credential = 'Enter the credential.';
  if (form.timeoutMs && !/^\d+$/.test(form.timeoutMs)) errors.timeoutMs = 'Whole milliseconds, for example 10000.';
  return errors;
}

/** Only the fields the gateway should change. Omitting `credential` keeps the stored one (docs/API.md). */
function toPayload(form: FormState, server: UpstreamServer | null): CreateServerInput | UpdateServerInput {
  const payload: UpdateServerInput = {
    name: form.name.trim(),
    url: form.url.trim(),
    authType: form.authType,
    toolAllowlist: parseAllowlist(form.allowlist),
  };
  if (form.authType === 'header') payload.headerName = form.headerName.trim();
  if (form.authType !== 'none' && form.credential) payload.credential = form.credential;
  // Switching an existing server to "no credential": also delete the stored secret.
  if (form.authType === 'none' && server?.hasCredential) payload.credential = '';
  if (form.timeoutMs) payload.timeoutMs = Number(form.timeoutMs);
  return server ? payload : ({ ...payload, slug: form.slug } as CreateServerInput);
}

/** Gateway errors that belong to one field; anything else is shown above the buttons. */
function fieldForError(code: string): keyof FormState | null {
  if (code === 'invalid_slug' || code === 'slug_taken') return 'slug';
  if (code === 'url_not_allowed') return 'url';
  return null;
}

export function ServerFormModal({ open, server, onClose }: { open: boolean; server: UpstreamServer | null; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      description={
        server
          ? 'Changes apply to every MCP client straight away.'
          : 'Its tools appear to the team as <slug>__<tool>, so names from different servers never collide.'
      }
    >
      <ServerForm server={server} onDone={onClose} />
    </Modal>
  );
}

function ServerForm({ server, onDone }: { server: UpstreamServer | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(server));
  const [errors, setErrors] = useState<FieldErrors>({});
  // Start the optional section open when this server already uses it, so its settings are visible.
  const [advancedOpenAtStart] = useState(() => Boolean(server?.timeoutMs || server?.toolAllowlist?.length));
  const base = useId();
  const id = (field: keyof FormState) => `${base}-${field}`;

  const save = useMutation({
    mutationFn: (payload: CreateServerInput | UpdateServerInput) =>
      server ? updateServer(server.id, payload) : createServer(payload as CreateServerInput),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
      onDone();
    },
    onError: (err) => {
      const field = err instanceof ApiError ? fieldForError(err.code) : null;
      if (field) setErrors({ [field]: err.message });
    },
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(form, server);
    setErrors(found);
    const firstInvalid = (Object.keys(found) as (keyof FormState)[])[0];
    // Move keyboard and screen-reader focus to the first field that needs fixing.
    if (firstInvalid) {
      const field = document.getElementById(id(firstInvalid));
      field?.closest('details')?.setAttribute('open', ''); // the field may sit in the collapsed section
      field?.focus();
    } else {
      save.mutate(toPayload(form, server));
    }
  }

  const generalError = save.isError && !(save.error instanceof ApiError && fieldForError(save.error.code)) ? save.error : null;
  const keepsCredential = server?.hasCredential && server.authType !== 'none';

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid gap-5 sm:grid-cols-[180px_1fr]">
        <Field
          label="Slug"
          htmlFor={id('slug')}
          error={errors.slug}
          help={server ? 'Fixed: it prefixes every tool name.' : 'Lowercase, 2 to 12 characters.'}
        >
          <input
            id={id('slug')}
            className="input mono"
            value={form.slug}
            onChange={(e) => set('slug', e.target.value.toLowerCase())}
            disabled={Boolean(server)}
            placeholder="e.g. supplier"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Name" htmlFor={id('name')} error={errors.name}>
          <input id={id('name')} className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Supplier catalog" />
        </Field>
      </div>

      <Field
        className="mt-5"
        label="MCP endpoint URL"
        htmlFor={id('url')}
        error={errors.url}
        help="Public https addresses, or an in-cluster address the platform allows."
      >
        <input
          id={id('url')}
          className="input mono"
          type="url"
          value={form.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          spellCheck={false}
        />
      </Field>

      <fieldset className="mt-6">
        <legend className="field-label">How the gateway authenticates to this server</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ['none', 'No credential'],
              ['bearer', 'Bearer token'],
              ['header', 'Custom header'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                form.authType === value ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line-strong'
              }`}
            >
              <input
                type="radio"
                name={`${base}-auth`}
                value={value}
                checked={form.authType === value}
                onChange={() => set('authType', value)}
                className="accent-accent"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {form.authType !== 'none' && (
        <div className={`mt-5 grid gap-5 ${form.authType === 'header' ? 'sm:grid-cols-[220px_1fr]' : ''}`}>
          {form.authType === 'header' && (
            <Field label="Header name" htmlFor={id('headerName')} error={errors.headerName}>
              <input
                id={id('headerName')}
                className="input mono"
                value={form.headerName}
                onChange={(e) => set('headerName', e.target.value)}
                placeholder="e.g. x-api-key"
                spellCheck={false}
              />
            </Field>
          )}
          <Field
            label={form.authType === 'bearer' ? 'Token' : 'Header value'}
            htmlFor={id('credential')}
            error={errors.credential}
            help={
              keepsCredential
                ? 'Leave empty to keep the stored credential. It is stored encrypted and is never shown again.'
                : 'Stored encrypted. Nobody can read it back, admins included.'
            }
          >
            <input
              id={id('credential')}
              className="input mono"
              type="password"
              autoComplete="new-password"
              value={form.credential}
              onChange={(e) => set('credential', e.target.value)}
              placeholder={keepsCredential ? 'unchanged' : ''}
              spellCheck={false}
            />
          </Field>
        </div>
      )}

      <details className="mt-6 rounded-md border border-line px-4 py-3" open={advancedOpenAtStart}>
        <summary className="cursor-pointer text-sm font-medium">Timeout and tool allowlist</summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-[180px_1fr]">
          <Field label="Call timeout (ms)" htmlFor={id('timeoutMs')} error={errors.timeoutMs} help="Empty uses the gateway default.">
            <input
              id={id('timeoutMs')}
              className="input"
              inputMode="numeric"
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value.trim())}
              placeholder="10000"
            />
          </Field>
          <Field
            label="Tool allowlist"
            htmlFor={id('allowlist')}
            help="Upstream tool names, one per line. Empty exposes every tool the server offers."
          >
            <textarea
              id={id('allowlist')}
              className="input mono"
              rows={3}
              value={form.allowlist}
              onChange={(e) => set('allowlist', e.target.value)}
              placeholder={'firecrawl_scrape\nfirecrawl_search'}
              spellCheck={false}
            />
          </Field>
        </div>
      </details>

      {generalError && <ErrorNote error={generalError} className="mt-5" />}

      <ModalActions>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {server ? 'Save changes' : 'Add server'}
        </button>
      </ModalActions>
    </form>
  );
}
