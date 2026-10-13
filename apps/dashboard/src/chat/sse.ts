// Incremental parser for the `text/event-stream` format (WHATWG HTML, "Parsing an event stream").
//
// Why not EventSource? It can only send GET requests, and our chat endpoint is a POST with a JSON body
// (and a CSRF header). So we read the response body ourselves and parse the stream with this class.
//
// The format is line based:
//   event: tool_call          <- sets the event name
//   data: {"id":"1",...}      <- data lines; several are joined with "\n"
//   : keepalive               <- a comment, ignored
//   (blank line)              <- dispatches the event
// Lines end with "\n", "\r\n" or "\r". Network chunks can split a line (or even a "\r\n") anywhere,
// so the parser keeps the unfinished tail of the buffer until the next chunk arrives.

export interface SseMessage {
  /** The `event:` field, or "message" when the event had none. */
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  /** The previous chunk ended with "\r"; if this one starts with "\n" it belongs to that same line break. */
  private pendingCr = false;

  /** Feed decoded text; returns every event completed by it (possibly none). */
  push(chunk: string): SseMessage[] {
    let text = chunk;
    if (this.pendingCr && text.length > 0) {
      if (text.startsWith('\n')) text = text.slice(1);
      this.pendingCr = false;
    }
    this.buffer += text;

    const events: SseMessage[] = [];
    let lineStart = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;

      const line = this.buffer.slice(lineStart, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i++; // "\r\n" is one line break
        } else {
          this.pendingCr = true; // can't tell yet whether a "\n" follows
        }
      }
      lineStart = i + 1;

      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(lineStart);
    return events;
  }

  // Note there is no flush(): per the spec, an event that is not terminated by a blank line before the
  // stream ends is incomplete and must be discarded.

  private processLine(line: string): SseMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null; // comment (servers use these as keepalives)

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // one optional space after the colon

    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    // `id`, `retry` and unknown fields are ignored: we never reconnect, so we don't need them.
    return null;
  }

  private dispatch(): SseMessage | null {
    const hadData = this.dataLines.length > 0;
    const message: SseMessage = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
    this.eventName = '';
    this.dataLines = [];
    // An event with no data lines at all is not dispatched (spec).
    return hadData ? message : null;
  }
}
