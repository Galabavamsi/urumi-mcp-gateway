// How upstream tools are named and described to MCP clients and models (docs/CONTRACTS.md "Tool exposure rules").
import { canonicalJson, sha256Hex } from '../crypto/hashing.ts';

/** Server slugs: short, lower-case, no underscores (so `__` in an exposed name can only be our separator). */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,11}$/;

export const MAX_EXPOSED_NAME = 48;
const OVERFLOW_KEEP = 41; // 41 chars + '_' + 6 hex = 48
export const MAX_DESCRIPTION = 1500;
export const MAX_TITLE = 200;
/**
 * Largest upstream inputSchema the gateway exposes, in JSON characters. It is sent in every tools/list and every
 * chat request, so one huge schema would cost every user on every turn. The biggest allowlisted one today is
 * firecrawl_search at about 7 KB (measured 2026-10-13).
 */
export const MAX_SCHEMA_CHARS = 32 * 1024;

/**
 * `<slug>__<toolName>`, with the tool name reduced to [A-Za-z0-9_-] (what the Claude, OpenAI and Gemini APIs all
 * accept). Names over 48 characters keep their first 41 characters plus `_` and 6 hex of a SHA-256 over the slug
 * and the ORIGINAL name, so two long names that share a prefix still get different, stable exposed names.
 * 48 leaves room for prefixes clients add themselves (Claude Code shows `mcp__<server>__<tool>`, max 64).
 */
export function exposedToolName(slug: string, toolName: string): string {
  const full = `${slug}__${toolName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (full.length <= MAX_EXPOSED_NAME) return full;
  return `${full.slice(0, OVERFLOW_KEEP)}_${sha256Hex(`${slug}__${toolName}`).slice(0, 6)}`;
}

// Characters that render as nothing (or reorder text) but are still read by a model: the usual carriers of hidden
// instructions in "tool poisoning" attacks.
//   C0/C1 controls except tab and newline; zero-width space/joiners, word joiner, invisible operators, BOM, soft
//   hyphen, Mongolian vowel separator; bidi marks, embeddings, overrides and isolates; Unicode "tag" characters
//   (U+E0000-E007F, invisible ASCII look-alikes); variation selectors (used to smuggle bytes after emoji).
const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁩︀-️﻿]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

// The same character class without the `g` flag: a global regex keeps state between .test() calls.
const HAS_INVISIBLE = new RegExp(INVISIBLE.source, 'u');

/**
 * A copy of an upstream inputSchema in which every `description` and `title` STRING is cleaned like the tool's own
 * description and title. Models read property descriptions just as closely as the tool description, so that is
 * where hidden instructions go next. Nothing else changes: property names, enum, const, default and pattern values
 * stay exactly as the upstream sent them, because the upstream validates arguments against them. (A property NAMED
 * "description" holds an object, not a string, so it is walked into, not cleaned.)
 */
export function sanitizeInputSchema<T>(schema: T): T {
  return cleanSchemaValue(schema) as T;
}

function cleanSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchemaValue);
  if (typeof value !== 'object' || value === null) return value;
  // Object.fromEntries creates own properties, so even a key spelled "__proto__" stays a plain key.
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (key === 'description' && typeof inner === 'string') return [key, capLength(stripInvisible(inner), MAX_DESCRIPTION)];
      if (key === 'title' && typeof inner === 'string') return [key, capLength(stripInvisible(inner), MAX_TITLE)];
      return [key, cleanSchemaValue(inner)];
    }),
  );
}

/** True when any key or string value still holds an invisible character (e.g. in an enum value or property name). */
export function containsInvisible(value: unknown): boolean {
  if (typeof value === 'string') return HAS_INVISIBLE.test(value);
  if (Array.isArray(value)) return value.some(containsInvisible);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, inner]) => HAS_INVISIBLE.test(key) || containsInvisible(inner));
  }
  return false;
}

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/**
 * The tool annotations MCP clients and the chat agent see. Only the four MCP hints (booleans) and a cleaned title are
 * copied; any other key is dropped. A THIRD-PARTY server's hints are not trusted at all: a server that wanted to be
 * called without a confirmation could simply claim readOnlyHint. Its tools are shown as the MCP worst case (may
 * write, may reach the outside world). Our own in-cluster servers (we wrote them) keep their hints.
 */
export function exposedAnnotations(
  annotations: Record<string, unknown> | undefined,
  trusted: boolean,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof annotations?.title === 'string') out.title = capLength(stripInvisible(annotations.title), MAX_TITLE);
  if (!trusted) return { ...out, readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  for (const hint of HINTS) if (typeof annotations?.[hint] === 'boolean') out[hint] = annotations[hint];
  return Object.keys(out).length > 0 ? out : undefined;
}

// Visible phrases typical of prompt injection in tool text. A match is only a warning (logged, and flagged on the
// dashboard's tool list): plain-English instructions cannot be detected reliably, so nothing is rewritten or blocked.
const INJECTION_PHRASES = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|messages|rules)/i,
  /<\/?important>/i,
  /do not (tell|inform|show|mention)[^.]{0,20}\b(user|human)/i,
  /\b(system|developer) (prompt|message|instructions)\b/i,
  /before (you )?(answer|respond|reply)(ing)? (anything|to anything)/i,
];

/** True when text from an upstream (a description, a schema text) reads like an instruction aimed at the model. */
export function looksLikeInjection(text: string): boolean {
  const visible = stripInvisible(text); // so 'ig<zero-width space>nore' is still read as 'ignore'
  return INJECTION_PHRASES.some((phrase) => phrase.test(visible));
}

/** The lint over everything a model reads about a tool: its description plus every text inside its schema. */
export function toolLooksLikeInjection(tool: { title?: string; description?: string; inputSchema: unknown }): boolean {
  return [tool.title ?? '', tool.description ?? '', ...schemaTexts(tool.inputSchema)].some(looksLikeInjection);
}

/** Every description/title string inside a schema. */
function schemaTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaTexts);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    (key === 'description' || key === 'title') && typeof inner === 'string' ? [inner] : schemaTexts(inner),
  );
}

/** Caps a string at `max` code points (never splitting a surrogate pair), marking the cut with an ellipsis. */
export function capLength(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The description a model sees: `[<slug>] ` (so it always knows which server a tool comes from) + the upstream's
 * description without invisible characters, capped at 1500 characters in total.
 */
export function exposedDescription(slug: string, description: string | undefined): string {
  return capLength(`[${slug}] ${stripInvisible(description ?? '').trim()}`.trimEnd(), MAX_DESCRIPTION);
}

/**
 * Fingerprint of everything about a tool a model or client relies on. If an upstream silently changes a tool
 * after it was reviewed ("rug pull"), the hash changes and the gateway logs and records it.
 */
export function toolDefinitionHash(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? null,
    }),
  );
}
