// The operating system Blob runs on (`os`), and any of them by name (`osFor`, for tests and pure functions).
// The per-system files import the modules that do the work, so those modules never import this one.
import { linux } from './linux.ts';
import { mac } from './mac.ts';
import type { Os } from './types.ts';
import { win } from './win.ts';

export type { Os };

const KNOWN = new Map<string, Os>([win, mac, linux].map(o => [o.id, o]));

/** A system Blob has no file for runs as Linux does, under its own name (and tells a network path by its mount, with `df`). */
export function osFor(platform: string): Os {
  return KNOWN.get(platform) ?? { ...linux, id: platform, name: platform, isLocal: mac.isLocal };
}

export const os: Os = osFor(process.platform);
