// Yes/No questions to the user on the bubble: the files server asks (askUser), Blob's host shows the card (Questions).

export const ASK_TIMEOUT_MS = 60_000;
/** The longest text shown under a question (a command, a task): it is shown whole, so a longer one is never asked. */
export const MAX_DETAIL = 600;

/**
 * Asks through Blob's local server. False on No, after the timeout, or when Blob can't be reached.
 * `detail`: text shown under the question exactly as it is (the command that would run).
 */
export async function askUser(question: string, o: {
  url?: string; token?: string; fetch?: typeof fetch; timeoutMs?: number; detail?: string;
} = {}): Promise<boolean> {
  const url = o.url ?? process.env.BLOB_ASK_URL;
  const token = o.token ?? process.env.BLOB_ASK_TOKEN;
  if (!url || !token) return false;
  try {
    const res = await (o.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ask-token': token },
      body: JSON.stringify({ question, ...(o.detail && { detail: o.detail }) }),
      // the host answers No itself at 60 s; this only covers a host that never replies
      signal: AbortSignal.timeout((o.timeoutMs ?? ASK_TIMEOUT_MS) + 5_000),
    });
    if (!res.ok) return false;
    const body = await res.json() as { yes?: unknown; shown?: unknown };
    // A Yes to a question with a detail counts only when the host says it showed the detail: a host from before
    // details (still running after an update) would have asked "Run this command?" with no command under it.
    return body.yes === true && (!o.detail || body.shown === true);
  } catch { return false; }
}

/**
 * The host's open questions: each resolves on the user's answer, or No after the timeout. An offer ("Keep it?") is not
 * one of them: it is only up while no question is open, so a question never waits behind it, and it steps aside for
 * one that arrives and comes back after.
 */
export class Questions {
  private open = new Map<string, { resolve: (yes: boolean | null) => void; timer: ReturnType<typeof setTimeout>; question: string; detail?: string; offer: boolean }>();
  private next = 1;
  private offerUp: string | null = null;   // the offer that is shown now

  constructor(private o: { show: (id: string, question: string, detail?: string) => void; hide: (id: string) => void; timeoutMs?: number }) {}

  /** `timeoutMs`: how long this one waits before it counts as No (the usual 60 s when left out). */
  ask(question: string, timeoutMs: number = this.o.timeoutMs ?? ASK_TIMEOUT_MS, detail?: string): Promise<boolean> {
    return this.add(question, timeoutMs, false, detail).then(yes => yes === true);
  }

  /** An offer: the user's Yes or No, or null when they did not answer in `timeoutMs`. */
  offer(question: string, timeoutMs: number): Promise<boolean | null> {
    return this.add(question, timeoutMs, true);
  }

  /** The user's click; false when that question is already closed. */
  answer(id: string, yes: boolean): boolean {
    return this.close(id, yes);
  }

  private add(question: string, timeoutMs: number, offer: boolean, detail?: string): Promise<boolean | null> {
    const id = String(this.next++);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.close(id, null), timeoutMs);
      this.open.set(id, { resolve, timer, question, detail, offer });
      this.placeOffer();
      if (!offer) this.o.show(id, question, detail);
    });
  }

  private close(id: string, yes: boolean | null): boolean {
    const q = this.open.get(id);
    if (!q) return false;
    this.open.delete(id);
    clearTimeout(q.timer);
    if (!q.offer) this.o.hide(id);
    q.resolve(yes);
    this.placeOffer();
    return true;
  }

  /** The oldest offer is up while no question is open; otherwise none is. */
  private placeOffer(): void {
    const all = [...this.open];
    const want = all.some(([, q]) => !q.offer) ? null : all.find(([, q]) => q.offer)?.[0] ?? null;
    if (want === this.offerUp) return;
    if (this.offerUp) this.o.hide(this.offerUp);
    this.offerUp = want;
    if (want) this.o.show(want, this.open.get(want)!.question);
  }
}
