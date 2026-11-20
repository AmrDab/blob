// https://<the site>/report: Blob's private reports, passed as they are to the relay Worker (relay/src/reports.ts).
interface Env { RELAY: { fetch(req: Request): Promise<Response> } }

export const onRequest = (c: { request: Request; env: Env }): Promise<Response> => c.env.RELAY.fetch(c.request);
