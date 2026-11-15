import { describe, expect, it } from 'vitest';
import { channel, parseFragment, unb64url } from '../src/pair-crypto.ts';
import { createRoom, qrSvg, qrUrl } from '../src/pair.ts';

const room = createRoom('https://blob-relay.example.workers.dev/');

describe('pairing crypto', () => {
  it('round-trips both ways, with a different key per direction', async () => {
    const pc = await channel(room.secret, room.room, 'pc');
    const phone = await channel(room.secret, room.room, 'phone');
    const req = await phone.seal({ t: 'req', id: '1', text: 'open notepad ✓' });
    expect(await pc.open(req)).toEqual({ t: 'req', id: '1', text: 'open notepad ✓' });
    expect(await phone.open(await pc.seal({ t: 'answer', text: 'Done.' }))).toEqual({ t: 'answer', text: 'Done.' });
    expect(new TextDecoder().decode(req)).not.toContain('notepad');
    await expect(phone.open(req)).rejects.toThrow();       // a frame does not open on the side that sent it
    expect(pc.auth).toBe(phone.auth);
    expect(pc.auth).toMatch(/^[\w-]{22}$/);
  });

  it('keeps the order of frames sealed at once', async () => {
    const pc = await channel(room.secret, room.room, 'pc');
    const phone = await channel(room.secret, room.room, 'phone');
    const frames = await Promise.all([1, 2, 3].map(i => phone.seal({ i })));
    expect(await Promise.all(frames.map(f => pc.open(f)))).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('fails with a wrong key, a wrong room, a changed frame and a replay', async () => {
    const phone = await channel(room.secret, room.room, 'phone');
    const frame = await phone.seal({ t: 'req', id: '1', text: 'hi' });
    const wrongKey = await channel(createRoom('https://x').secret, room.room, 'pc');
    await expect(wrongKey.open(frame)).rejects.toThrow();
    const wrongRoom = await channel(room.secret, createRoom('https://x').room, 'pc');
    await expect(wrongRoom.open(frame)).rejects.toThrow();
    const pc = await channel(room.secret, room.room, 'pc');
    const changed = frame.slice(0);
    new Uint8Array(changed)[20] ^= 1;
    await expect(pc.open(changed)).rejects.toThrow();
    await pc.open(frame);
    await expect(pc.open(frame)).rejects.toThrow('replayed');
  });
});

describe('pairing room', () => {
  it('makes a random 16-byte id and a 32-byte secret', () => {
    expect(unb64url(room.room)).toHaveLength(16);
    expect(unb64url(room.secret)).toHaveLength(32);
    const again = createRoom('https://blob-relay.example.workers.dev');
    expect(again.room).not.toBe(room.room);
    expect(again.secret).not.toBe(room.secret);
  });

  it('puts the room and the secret in the fragment only', () => {
    const url = qrUrl(room);
    expect(url).toBe(`https://blob-relay.example.workers.dev/#r=${room.room}&k=${room.secret}`);
    const u = new URL(url);
    expect(u.pathname + u.search).toBe('/');
    expect(parseFragment(u.hash)).toEqual({ room: room.room, secret: room.secret });
    expect(parseFragment('#r=short&k=short')).toBeNull();
    expect(parseFragment('')).toBeNull();
  });

  it('draws the QR as an SVG string', () => {
    const svg = qrSvg(qrUrl(room));
    expect(svg).toMatch(/^<svg[^>]+viewBox=/);
    expect(svg).toContain('#1c1c1e');
    expect(svg.length).toBeLessThan(40_000);
  });
});
