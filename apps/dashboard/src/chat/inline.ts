// The agent often answers with light Markdown. We render only **bold** and `code` (as React elements,
// never as HTML, so nothing in a reply can inject markup); everything else stays plain text, which reads
// fine for lists and line breaks because the bubble preserves whitespace.

export type InlineSegment = { kind: 'text' | 'bold' | 'code'; text: string };

/** One capture group, so `split` returns: text, match, text, match, ..., text (matches at odd indexes). */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

export function parseInline(text: string): InlineSegment[] {
  return text.split(INLINE).flatMap((part, index): InlineSegment[] => {
    if (part === '') return [];
    if (index % 2 === 0) return [{ kind: 'text', text: part }];
    return part.startsWith('**')
      ? [{ kind: 'bold', text: part.slice(2, -2) }]
      : [{ kind: 'code', text: part.slice(1, -1) }];
  });
}
