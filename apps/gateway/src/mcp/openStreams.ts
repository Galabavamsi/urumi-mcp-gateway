// Long-lived MCP responses (the `subscriptions/listen` notification stream of 2026-07-28 clients) outlive the
// authentication check that opened them. When a key is revoked or a user disabled, the gateway closes that
// key's/user's open streams too, so a revoked key stops receiving anything at once.

interface Tracked {
  apiKeyId: string;
  userId: string;
  close: () => void;
}

export class OpenStreams {
  private readonly streams = new Set<Tracked>();

  /** Returns a response whose body can be cut from outside; non-streaming responses pass through untouched. */
  track(response: Response, owner: { apiKeyId: string; userId: string }): Response {
    const source = response.body;
    if (!source || !response.headers.get('content-type')?.includes('text/event-stream')) return response;

    const reader = source.getReader();
    let entry: Tracked | undefined;
    let done = false;
    const finish = () => {
      done = true;
      if (entry) this.streams.delete(entry);
    };

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry = {
          ...owner,
          close: () => {
            if (done) return;
            finish();
            controller.close();
            void reader.cancel('access revoked').catch(() => {});
          },
        };
        this.streams.add(entry);
      },
      pull: async (controller) => {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (done) return; // closed from outside while we were waiting
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: (reason) => {
        finish(); // the client went away
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  closeForKey(apiKeyId: string): void {
    for (const stream of [...this.streams]) if (stream.apiKeyId === apiKeyId) stream.close();
  }

  closeForUser(userId: string): void {
    for (const stream of [...this.streams]) if (stream.userId === userId) stream.close();
  }

  get size(): number {
    return this.streams.size;
  }
}
