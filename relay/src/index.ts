// Blob's phone relay: one Durable Object per pairing room. The PC and the phone both connect out to
// wss://<host>/room/<id>?role=pc|phone&auth=<token>[&dev=<phone id>]; the room forwards their encrypted frames and stores no content.
import { admit, entered, frame, left, tick, type Host, type Meta, type Role } from './room';

interface Env { ROOM: DurableObjectNamespace }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const id = /^\/room\/([\w-]{22})$/.exec(url.pathname)?.[1];
    if (!id) return new Response('Not found', { status: 404 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const role = url.searchParams.get('role');
    const id22 = (k: string) => /^[\w-]{22}$/.test(url.searchParams.get(k) ?? '');
    // A phone also names itself (`dev`, a random id it keeps): the room takes the first phone only.
    if ((role !== 'pc' && role !== 'phone') || !id22('auth') || (role === 'phone' && !id22('dev'))) {
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
    const refused = await admit(this.host, role, q.get('auth')!, Date.now(), q.get('dev') ?? undefined);
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
