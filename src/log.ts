// The log: one row per request, tool call and answer. Shown on the Log blob, copied as plain text, and appended to
// ~/.pronto/logs/YYYY-MM-DD.log. Shared by the host and the page, so it imports nothing from Node.

export type LogBody =
  | { kind: 'request'; text: string }
  | { kind: 'call'; tool: string; action?: string; outcome: string; line: string }
  | { kind: 'answer'; text: string };
export type LogRow = { t: number } & LogBody;

const two = (n: number) => String(n).padStart(2, '0');

export function clock(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The day's file name, in local time. */
export function logFileName(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.log`;
}

export function formatRow(r: LogRow): string {
  if (r.kind === 'request') return `${clock(r.t)}  › ${r.text}`;
  if (r.kind === 'answer') return `${clock(r.t)}  = ${r.text}`;
  return `${clock(r.t)}    ${r.tool}${r.action ? ` · ${r.action}` : ''}  ${r.line}`;
}

export const formatLog = (rows: LogRow[]): string => rows.map(formatRow).join('\n');
