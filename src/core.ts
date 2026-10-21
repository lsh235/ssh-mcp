import { createHash, randomUUID } from 'node:crypto';
export class Fault extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function assert(ok: unknown, code: string, message: string): asserts ok { if (!ok) throw new Fault(code, message); }
