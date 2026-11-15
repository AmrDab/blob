// wss://<the site>/room/<id>: passed as it is (the WebSocket upgrade too) to the relay Worker in relay/, over a service binding.
interface Env { RELAY: { fetch(req: Request): Promise<Response> } }

export const onRequest = (c: { request: Request; env: Env }): Promise<Response> => c.env.RELAY.fetch(c.request);
