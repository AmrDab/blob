// Yes/No questions to the user on the bubble: the files server asks (askUser), Blob's host shows the card (Questions).

export const ASK_TIMEOUT_MS = 60_000;

/** Asks through Blob's local server. False on No, after the timeout, or when Blob can't be reached. */
export async function askUser(question: string, o: {
  url?: string; token?: string; fetch?: typeof fetch; timeoutMs?: number;
} = {}): Promise<boolean> {
  const url = o.url ?? process.env.BLOB_ASK_URL;
  const token = o.token ?? process.env.BLOB_ASK_TOKEN;
  if (!url || !token) return false;
  try {
    const res = await (o.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ask-token': token },
      body: JSON.stringify({ question }),
      // the host answers No itself at 60 s; this only covers a host that never replies
      signal: AbortSignal.timeout((o.timeoutMs ?? ASK_TIMEOUT_MS) + 5_000),
    });
    if (!res.ok) return false;
    const body = await res.json() as { yes?: unknown };
    return body.yes === true;
  } catch { return false; }
}

/** The host's open questions: each resolves on the user's answer, or No after the timeout. */
export class Questions {
  private open = new Map<string, { resolve: (yes: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private next = 1;

  constructor(private o: { show: (id: string, question: string) => void; hide: (id: string) => void; timeoutMs?: number }) {}

  /** `timeoutMs`: how long this one waits before it counts as No (the usual 60 s when left out). */
  ask(question: string, timeoutMs: number = this.o.timeoutMs ?? ASK_TIMEOUT_MS): Promise<boolean> {
    const id = String(this.next++);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(id, false), timeoutMs);
      this.open.set(id, { resolve, timer });
      this.o.show(id, question);
    });
  }

  /** The user's click; false when that question is already closed. */
  answer(id: string, yes: boolean): boolean {
    const q = this.open.get(id);
    if (!q) return false;
    this.open.delete(id);
    clearTimeout(q.timer);
    this.o.hide(id);
    q.resolve(yes);
    return true;
  }
}
