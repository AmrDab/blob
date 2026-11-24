// Blob's phone relay: one Durable Object per pairing room. The PC and the phone both connect out to
// wss://<host>/room/<id>?role=pc|phone&auth=<token>&pc=<PC token> | &dev=<phone id>; the room forwards their encrypted frames and stores no content.
// Also /report: the private reports Blob sends after a mistake, with the user's Yes (reports.ts), kept in one
// Durable Object and read only with the REPORTS_KEY secret.
import { post, read, senderHash, type Report, type Store } from './reports';
import { admit, entered, frame, left, tick, type Host, type Meta, type Role } from './room';

interface Env { ROOM: DurableObjectNamespace; REPORTS: DurableObjectNamespace; REPORTS_KEY?: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/report' || url.pathname === '/reports') return env.REPORTS.get(env.REPORTS.idFromName('reports')).fetch(req);
    const id = /^\/room\/([\w-]{22})$/.exec(url.pathname)?.[1];
    if (!id) return new Response('Not found', { status: 404 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const role = url.searchParams.get('role');
    const id22 = (k: string) => /^[\w-]{22}$/.test(url.searchParams.get(k) ?? '');
    // Each side also names itself: the PC with a token only it has (`pc`), the phone with an id it keeps (`dev`).
    if ((role !== 'pc' && role !== 'phone') || !id22('auth') || !id22(role === 'pc' ? 'pc' : 'dev')) {
      return new Response('Bad request', { status: 400 });
    }
    return env.ROOM.get(env.ROOM.idFromName(id)).fetch(req);
  },
};

export class Room {
  private host: Host;

  constructor(private ctx: DurableObjectState) {
    this.host = {
      meta: () => ctx.storage.get<Meta>('meta'),
      save: meta => ctx.storage.put('meta', meta),
      wipe: async () => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); },
      alarm: at => ctx.storage.setAlarm(at),
      socks: role => ctx.getWebSockets(role).filter(ws => ws.readyState === WebSocket.OPEN),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const role = q.get('role') as Role;
    const [client, server] = Object.values(new WebSocketPair());
    const refused = await admit(this.host, role, q.get('auth')!, Date.now(), q.get(role === 'pc' ? 'pc' : 'dev') ?? '');
    if (refused) {
      // Accepted and closed at once, so the page sees why (a failed upgrade shows no reason to a browser).
      server.accept();
      server.close(refused, 'refused');
    } else {
      this.ctx.acceptWebSocket(server, [role]);
      entered(this.host, role, server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private role(ws: WebSocket): Role { return this.ctx.getTags(ws)[0] as Role; }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    await frame(this.host, this.role(ws), ws, data, Date.now());
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch { /* already closed */ }
    await left(this.host, this.role(ws), ws, Date.now());
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await tick(this.host, Date.now());
  }
}

/** The reports, in this object's own SQLite storage. */
export class Reports {
  private store: Store;

  constructor(ctx: DurableObjectState, private env: Env) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, who TEXT, title TEXT, text TEXT, version TEXT)');
    this.store = {
      add: async (r, who) => { sql.exec('INSERT INTO reports (t, who, title, text, version) VALUES (?, ?, ?, ?, ?)', r.t, who, r.title, r.text, r.version); },
      count: async (since, who) => Number((who === undefined
        ? sql.exec('SELECT COUNT(*) AS n FROM reports WHERE t >= ?', since)
        : sql.exec('SELECT COUNT(*) AS n FROM reports WHERE t >= ? AND who = ?', since, who)).one().n),
      list: async limit => sql.exec('SELECT id, t, title, text, version FROM reports ORDER BY id DESC LIMIT ?', limit).toArray() as unknown as Report[],
      remove: async id => { sql.exec('DELETE FROM reports WHERE id = ?', id); },
      trim: async keep => { sql.exec('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY id DESC LIMIT ?)', keep); },
      forget: async before => { sql.exec("UPDATE reports SET who = '' WHERE t < ? AND who != ''", before); },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/report' && req.method === 'POST') {
      let body: unknown;
      try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
      return post(this.store, body, await senderHash(req.headers.get('cf-connecting-ip') ?? ''), Date.now());
    }
    if (url.pathname === '/reports') return read(this.store, req.method, url, req.headers.get('authorization'), this.env.REPORTS_KEY);
    return new Response('Not found', { status: 404 });
  }
}
