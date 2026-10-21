import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

const ZERO_HASH = '0'.repeat(64);
const MAX_RECORD_BYTES = 8192;
const READ_BYTES = 64 * 1024;
const LEGACY_KEYS = ['at', 'event', 'owner', 'id', 'state'];
const BASE_KEYS = ['version', 'sequence', 'at', 'event', 'owner', 'id', 'state', 'previousHash'];

export interface AuditEvent {
  event: string;
  owner: string;
  id: string;
  state: string;
}

export interface AuditVerification {
  valid: true;
  chainStarted: boolean;
  legacyRecords: number;
  chainedRecords: number;
  headHash: string | null;
}

interface Scan extends AuditVerification {
  sequence: number;
  legacySha256: string;
}

interface LockRecord {
  pid: number;
  bootId: string;
  startTicks: string;
  nonce: string;
}

function fail(message: string): never {
  throw new Error(`AUDIT_LOG_INVALID: ${message}`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBody(record: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of BASE_KEYS) body[key] = record[key];
  if (record.event === 'audit_chain_start') {
    body.legacyCount = record.legacyCount;
    body.legacySha256 = record.legacySha256;
  }
  return body;
}

function processStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return undefined;
    // Fields after comm begin with field 3 (state); starttime is field 22.
    return stat.slice(end + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function currentBootId(): string {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return 'unknown'; }
}

function lockIsLive(lock: LockRecord): boolean {
  try { process.kill(lock.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
  const bootId = currentBootId();
  const startTicks = processStartTicks(lock.pid);
  // If process identity cannot be checked, refuse to guess that a writer is stale.
  if (!startTicks || bootId === 'unknown') return true;
  return lock.bootId === bootId && lock.startTicks === startTicks;
}

function acquireLock(path: string): { fd: number; nonce: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = randomBytes(24).toString('hex');
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        fchmodSync(fd, 0o600);
        const lock: LockRecord = {
          pid: process.pid,
          bootId: currentBootId(),
          startTicks: processStartTicks(process.pid) ?? 'unknown',
          nonce,
        };
        writeSync(fd, JSON.stringify(lock) + '\n');
        fsyncSync(fd);
        return { fd, nonce };
      } catch (error) {
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let lock: LockRecord;
      let before;
      try {
        before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink()) fail('lock file is not a regular file');
        const uid = process.getuid?.();
        if (uid !== undefined && before.uid !== uid) fail('lock file is owned by a different account');
        lock = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('AUDIT_LOCK_UNCERTAIN: cannot safely inspect the existing audit lock');
      }
      if (!Number.isSafeInteger(lock.pid) || typeof lock.nonce !== 'string' || typeof lock.startTicks !== 'string' || typeof lock.bootId !== 'string') {
        throw new Error('AUDIT_LOCK_UNCERTAIN: existing audit lock has an unknown format');
      }
      if (lockIsLive(lock)) throw new Error('AUDIT_LOCKED: another server process owns this state directory');
      try {
        const after = lstatSync(path);
        if (after.dev === before.dev && after.ino === before.ino) unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error('AUDIT_LOCKED: could not acquire the audit log lock');
}

function legacyRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === LEGACY_KEYS.length
    && LEGACY_KEYS.every(key => Object.hasOwn(record, key) && typeof record[key] === 'string');
}

function chainedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('record is not an object');
  const record = value as Record<string, unknown>;
  const isStart = record.event === 'audit_chain_start';
  const allowed = [...BASE_KEYS, ...(isStart ? ['legacyCount', 'legacySha256'] : []), 'hash'];
  if (Object.keys(record).length !== allowed.length || !allowed.every(key => Object.hasOwn(record, key))) fail('record fields are invalid');
  if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) fail('record version or sequence is invalid');
  for (const key of ['at', 'event', 'owner', 'id', 'state', 'previousHash', 'hash']) {
    if (typeof record[key] !== 'string') fail(`record field ${key} is invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.previousHash as string) || !/^[a-f0-9]{64}$/.test(record.hash as string)) fail('record hash format is invalid');
  if (isStart && (!Number.isSafeInteger(record.legacyCount) || (record.legacyCount as number) < 0 || typeof record.legacySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.legacySha256))) fail('legacy checkpoint is invalid');
  return record;
}

function scanFd(fd: number): Scan {
  let legacyRecords = 0;
  let chainedRecords = 0;
  let chainStarted = false;
  let headHash: string | null = null;
  let sequence = 0;
  const legacyHash = createHash('sha256');
  const readBuffer = Buffer.alloc(READ_BYTES);
  let pending = Buffer.alloc(0);

  const consume = (lineWithNewline: Buffer) => {
    if (lineWithNewline.length > MAX_RECORD_BYTES) fail('record exceeds the maximum size');
    const line = lineWithNewline.subarray(0, -1);
    let value: unknown;
    try { value = JSON.parse(line.toString('utf8')); }
    catch { fail('record is not valid JSON'); }
    if (legacyRecord(value)) {
      if (chainStarted) fail('legacy record appears after the integrity chain started');
      legacyHash.update(lineWithNewline);
      legacyRecords++;
      return;
    }

    const record = chainedRecord(value);
    if (!chainStarted) {
      if (record.event !== 'audit_chain_start' || record.sequence !== 1 || record.previousHash !== ZERO_HASH) fail('integrity chain has no valid start record');
      if (record.legacyCount !== legacyRecords || record.legacySha256 !== legacyHash.copy().digest('hex')) fail('legacy checkpoint does not match the original records');
      chainStarted = true;
    } else {
      if (record.event === 'audit_chain_start') fail('integrity chain has more than one start record');
      if (record.sequence !== sequence + 1 || record.previousHash !== headHash) fail('sequence or previous hash does not match');
    }
    const expectedHash = sha256(JSON.stringify(canonicalBody(record)));
    if (record.hash !== expectedHash) fail('record hash does not match its contents');
    sequence = record.sequence as number;
    headHash = record.hash as string;
    chainedRecords++;
  };

  for (;;) {
    const count = readSync(fd, readBuffer, 0, readBuffer.length, null);
    if (count === 0) break;
    const chunk = readBuffer.subarray(0, count);
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const line = pending.length === 0
        ? chunk.subarray(start, i + 1)
        : Buffer.concat([pending, chunk.subarray(start, i + 1)]);
      consume(line);
      pending = Buffer.alloc(0);
      start = i + 1;
    }
    if (start < chunk.length) {
      pending = pending.length === 0 ? Buffer.from(chunk.subarray(start)) : Buffer.concat([pending, chunk.subarray(start)]);
      if (pending.length > MAX_RECORD_BYTES) fail('record exceeds the maximum size');
    }
  }
  if (pending.length !== 0) fail('file ends with an incomplete record');
  return {
    valid: true, chainStarted, legacyRecords, chainedRecords, headHash,
    sequence, legacySha256: legacyHash.digest('hex'),
  };
}

export function verifyAuditFile(path: string): AuditVerification {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('audit path is not a regular file');
    return scanFd(fd);
  } finally { closeSync(fd); }
}

export class AuditLog {
  private readonly fd: number;
  private readonly lockFd: number;
  private readonly lockNonce: string;
  private sequence = 0;
  private headHash = ZERO_HASH;
  private closed = false;
  private failed = false;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(`${path}.lock`);
    this.lockFd = lock.fd;
    this.lockNonce = lock.nonce;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile()) fail('audit path is not a regular file');
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) fail('audit file is owned by a different account');
      fchmodSync(fd, 0o600);
      const scan = scanFd(fd);
      this.sequence = scan.sequence;
      this.headHash = scan.headHash ?? ZERO_HASH;
      this.fd = fd;
      if (!scan.chainStarted) this.appendRecord({
        event: 'audit_chain_start', owner: 'system', id: 'audit', state: 'started',
        legacyCount: scan.legacyRecords, legacySha256: scan.legacySha256,
      });
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      closeSync(this.lockFd);
      this.releaseLock();
      throw error;
    }
  }

  append(event: AuditEvent): void {
    if (this.closed) throw new Error('AUDIT_CLOSED: audit log is closed');
    if (this.failed) throw new Error('AUDIT_WRITE_FAILED: audit log is unavailable');
    try { this.appendRecord(event); }
    catch (error) { this.failed = true; throw error; }
  }

  get healthy(): boolean { return !this.closed && !this.failed; }

  private appendRecord(event: AuditEvent & { legacyCount?: number; legacySha256?: string }): void {
    const record: Record<string, unknown> = {
      version: 1,
      sequence: this.sequence + 1,
      at: new Date().toISOString(),
      event: event.event,
      owner: event.owner,
      id: event.id,
      state: event.state,
      previousHash: this.headHash,
    };
    if (event.event === 'audit_chain_start') {
      record.legacyCount = event.legacyCount;
      record.legacySha256 = event.legacySha256;
    }
    const hash = sha256(JSON.stringify(canonicalBody(record)));
    const line = Buffer.from(JSON.stringify({ ...record, hash }) + '\n');
    if (line.length > MAX_RECORD_BYTES) throw new Error('AUDIT_WRITE_FAILED: event exceeds the maximum audit record size');
    let offset = 0;
    while (offset < line.length) {
      const written = writeSync(this.fd, line, offset, line.length - offset, null);
      if (written <= 0) throw new Error('AUDIT_WRITE_FAILED: no audit bytes were written');
      offset += written;
    }
    fsyncSync(this.fd);
    this.sequence++;
    this.headHash = hash;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { closeSync(this.fd); }
    finally {
      try { closeSync(this.lockFd); }
      finally { this.releaseLock(); }
    }
  }

  private releaseLock(): void {
    try {
      const lock = JSON.parse(readFileSync(`${this.path}.lock`, 'utf8')) as LockRecord;
      if (lock.nonce === this.lockNonce) unlinkSync(`${this.path}.lock`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
