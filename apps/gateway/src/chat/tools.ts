// Translation between MCP tool shapes (what the gateway lists and returns) and Anthropic tool shapes.
import type Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/client';
import { log } from '@urumi/mcp-common';

// The Messages API only accepts these tool names. The gateway already sanitizes exposed names
// (docs/CONTRACTS.md "Tool exposure rules"), so this is a cheap guard: one bad name would make
// every chat request fail with a 400, so we skip that tool instead.
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** MCP tools from the gateway → Anthropic tool definitions. Names are kept exactly as exposed. */
export function toAnthropicTools(tools: readonly McpTool[]): Anthropic.Tool[] {
  const result: Anthropic.Tool[] = [];
  for (const tool of tools) {
    if (!ANTHROPIC_TOOL_NAME.test(tool.name)) {
      log('warn', 'chat: skipping a tool whose name the model API would reject', { tool: tool.name });
      continue;
    }
    result.push({
      name: tool.name,
      // The gateway has already cleaned the description and prefixed it with "[<slug>] ".
      description: tool.description ?? '',
      input_schema: normalizeInputSchema(tool.inputSchema),
    });
  }
  return result;
}

/**
 * The Messages API wants a JSON Schema whose top level is `{type: "object"}` and rejects anyOf/oneOf/allOf
 * at the top level. MCP requires an object schema too, but we don't trust every upstream to follow that.
 * Dropping a top-level combinator loosens the hint for the model only: the upstream server still
 * validates the arguments when the tool is called.
 */
export function normalizeInputSchema(schema: unknown): Anthropic.Tool.InputSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema as Record<string, unknown>;
  return { ...rest, type: 'object' };
}

/**
 * Flattens an MCP tool result into plain text for the model and the UI preview.
 * Text blocks are kept; other block types get a short placeholder (this chat only handles text).
 * If there is no content but there is structuredContent, its JSON is used instead.
 */
export function toolResultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource':
        parts.push('text' in block.resource ? block.resource.text : `[binary resource ${block.resource.uri} omitted]`);
        break;
      case 'resource_link':
        parts.push(`[resource link: ${block.uri}]`);
        break;
      default:
        parts.push(`[${block.type} content omitted]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n');
}

/** Cuts `text` to at most `max` characters, ending with `marker` when something was cut. */
export function truncate(text: string, max: number, marker = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}
