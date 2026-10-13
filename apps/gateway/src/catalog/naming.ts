// How upstream tools are named and described to MCP clients and models (docs/CONTRACTS.md "Tool exposure rules").
import { canonicalJson, sha256Hex } from '../crypto/hashing.ts';

/** Server slugs: short, lower-case, no underscores (so `__` in an exposed name can only be our separator). */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,11}$/;

export const MAX_EXPOSED_NAME = 48;
const OVERFLOW_KEEP = 41; // 41 chars + '_' + 6 hex = 48
export const MAX_DESCRIPTION = 1500;

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
