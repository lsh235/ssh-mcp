import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const ZERO_HASH = '0'.repeat(64);
const MAX_RECORD_BYTES = 8192;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_MAX_FILE_BYTES = MAX_RECORD_BYTES * 2;
const READ_BYTES = 64 * 1024;
const LEGACY_KEYS = ['at', 'event', 'owner', 'id', 'state'];
const BASE_KEYS = ['version', 'sequence', 'at', 'event', 'owner', 'id', 'state', 'previousHash'];
const STRUCTURAL_EVENTS = new Set(['audit_chain_start', 'audit_segment_start', 'audit_segment_end']);

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
  segments: number;
  headHash: string | null;
}

export interface AuditLogOptions {
  /** Maximum bytes per active JSONL segment. Archived segments are retained. */
  maxFileBytes?: number;
}

interface LockRecord {
  pid: number;
  bootId: string;
  startTicks: string;
  nonce: string;
}

interface ChainState {
  legacyRecords: number;
  legacyHash: ReturnType<typeof createHash>;
  chainedRecords: number;
  chainStarted: boolean;
  headHash: string | null;
  sequence: number;
}

interface FileScan {
  bytes: number;
  firstEvent?: string;
  firstSequence?: number;
  lastEvent?: string;
  lastSequence?: number;
  lastHash?: string;
  businessRecords: number;
}

interface SegmentFile {
  path: string;
  firstSequence: number;
  lastSequence: number;
  lastHash: string;
  dev: number;
  ino: number;
}

interface AuditScan {
  state: ChainState;
  active: FileScan;
  archivedSegments: number;
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

function makeRecord(event: AuditEvent & { legacyCount?: number; legacySha256?: string }, sequence: number, previousHash: string) {
  const record: Record<string, unknown> = {
    version: 1,
    sequence,
    at: new Date().toISOString(),
    event: event.event,
    owner: event.owner,
    id: event.id,
    state: event.state,
    previousHash,
  };
  if (event.event === 'audit_chain_start') {
    record.legacyCount = event.legacyCount;
    record.legacySha256 = event.legacySha256;
  }
  const hash = sha256(JSON.stringify(canonicalBody(record)));
  const line = Buffer.from(JSON.stringify({ ...record, hash }) + '\n');
  if (line.length > MAX_RECORD_BYTES) throw new Error('AUDIT_WRITE_FAILED: event exceeds the maximum audit record size');
  return { line, hash, sequence, event: event.event };
}

function emptyState(): ChainState {
  return {
    legacyRecords: 0,
    legacyHash: createHash('sha256'),
    chainedRecords: 0,
    chainStarted: false,
    headHash: null,
    sequence: 0,
  };
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
      if (lockIsLive(lock)) throw new Error('AUDIT_LOCKED: another process owns this audit log');
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

function releaseLock(path: string, nonce: string): void {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    if (lock.nonce === nonce) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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

function scanFd(fd: number, state: ChainState, continuation: boolean): FileScan {
  const file: FileScan = { bytes: fstatSync(fd).size, businessRecords: 0 };
  const readBuffer = Buffer.alloc(READ_BYTES);
  let pending = Buffer.alloc(0);

  const consume = (lineWithNewline: Buffer) => {
    if (lineWithNewline.length > MAX_RECORD_BYTES) fail('record exceeds the maximum size');
    const line = lineWithNewline.subarray(0, -1);
    let value: unknown;
    try { value = JSON.parse(line.toString('utf8')); }
    catch { fail('record is not valid JSON'); }
    if (legacyRecord(value)) {
      if (state.chainStarted || continuation) fail('legacy record appears after the integrity chain started');
      state.legacyHash.update(lineWithNewline);
      state.legacyRecords++;
      file.businessRecords++;
      return;
    }

    const record = chainedRecord(value);
    const wasStarted = state.chainStarted;
    if (!wasStarted) {
      if (continuation || record.event !== 'audit_chain_start' || record.sequence !== 1 || record.previousHash !== ZERO_HASH) {
        fail('integrity chain has no valid start record');
      }
      if (record.legacyCount !== state.legacyRecords || record.legacySha256 !== state.legacyHash.copy().digest('hex')) {
        fail('legacy checkpoint does not match the original records');
      }
    } else {
      if (file.lastEvent === 'audit_segment_end') fail('record follows a segment end marker');
      if (record.event === 'audit_chain_start') fail('integrity chain has more than one start record');
      if (record.sequence !== state.sequence + 1 || record.previousHash !== state.headHash) fail('sequence or previous hash does not match');
      if (!file.firstEvent && continuation && record.event !== 'audit_segment_start') fail('segment does not start with its link marker');
      if (!file.firstEvent && !continuation && record.event === 'audit_segment_start') fail('root segment cannot begin with a continuation marker');
      if (file.firstEvent && record.event === 'audit_segment_start') fail('segment start marker appears inside a segment');
    }
    const expectedHash = sha256(JSON.stringify(canonicalBody(record)));
    if (record.hash !== expectedHash) fail('record hash does not match its contents');
    if (!file.firstEvent) {
      file.firstEvent = record.event as string;
      file.firstSequence = record.sequence as number;
    }
    file.lastEvent = record.event as string;
    file.lastSequence = record.sequence as number;
    file.lastHash = record.hash as string;
    state.chainStarted = true;
    state.sequence = record.sequence as number;
    state.headHash = record.hash as string;
    state.chainedRecords++;
    if (!STRUCTURAL_EVENTS.has(record.event as string)) file.businessRecords++;
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
  if (continuation && file.bytes > 0 && file.firstEvent !== 'audit_segment_start') fail('continuation segment has no start marker');
  if (!continuation && state.chainStarted && file.bytes > 0 && file.firstEvent !== 'audit_chain_start') fail('root segment has no start marker');
  return file;
}

function assertOwnedRegularFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) fail('audit path is not a regular file');
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) fail('audit file is owned by a different account');
  if ((stat.mode & 0o077) !== 0) fail('audit file permissions are broader than 0600');
}

function scanPath(path: string, state: ChainState, continuation: boolean): FileScan {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertOwnedRegularFile(fd);
    return scanFd(fd, state, continuation);
  } finally { closeSync(fd); }
}

function archivePattern(path: string): RegExp {
  const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.segment-(\\d{20})-(\\d{20})-([a-f0-9]{64})\\.jsonl$`);
}

function listArchives(path: string): SegmentFile[] {
  const prefix = `${basename(path)}.segment-`;
  const pattern = archivePattern(path);
  const segments: SegmentFile[] = [];
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const match = pattern.exec(name);
    if (!match) fail('archive filename is invalid');
    const segmentPath = join(dirname(path), name);
    const stat = lstatSync(segmentPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('archive is not a regular file');
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) fail('archive is owned by a different account');
    if ((stat.mode & 0o077) !== 0) fail('archive permissions are broader than 0600');
    const firstSequence = Number(match[1]);
    const lastSequence = Number(match[2]);
    if (!Number.isSafeInteger(firstSequence) || !Number.isSafeInteger(lastSequence) || firstSequence < 1 || lastSequence < firstSequence) {
      fail('archive sequence range is invalid');
    }
    segments.push({ path: segmentPath, firstSequence, lastSequence, lastHash: match[3], dev: stat.dev, ino: stat.ino });
  }
  segments.sort((a, b) => a.firstSequence - b.firstSequence);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i - 1].firstSequence === segments[i].firstSequence) fail('archive sequence range is duplicated');
  }
  return segments;
}

function scanArchives(path: string): { state: ChainState; segments: SegmentFile[] } {
  const segments = listArchives(path);
  const state = emptyState();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const scanned = scanPath(segment.path, state, i > 0);
    if (!scanned.firstEvent || scanned.lastEvent !== 'audit_segment_end') fail('archive is missing its segment end marker');
    if (scanned.firstSequence !== segment.firstSequence || scanned.lastSequence !== segment.lastSequence || scanned.lastHash !== segment.lastHash) {
      fail('archive filename does not match its contents');
    }
  }
  return { state, segments };
}

function statMaybe(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function segmentPath(path: string, scan: FileScan): string {
  if (scan.firstSequence === undefined || scan.lastSequence === undefined || !scan.lastHash) fail('cannot name an empty segment');
  const first = String(scan.firstSequence).padStart(20, '0');
  const last = String(scan.lastSequence).padStart(20, '0');
  return `${path}.segment-${first}-${last}-${scan.lastHash}.jsonl`;
}

function writeAll(fd: number, line: Buffer): void {
  let offset = 0;
  while (offset < line.length) {
    const written = writeSync(fd, line, offset, line.length - offset, null);
    if (written <= 0) throw new Error('AUDIT_WRITE_FAILED: no audit bytes were written');
    offset += written;
  }
}

function writeNextSegment(path: string, state: ChainState): Buffer {
  if (!state.chainStarted || !state.headHash) fail('cannot continue an unstarted audit chain');
  const nextPath = `${path}.next`;
  const nextStat = statMaybe(nextPath);
  if (nextStat) fail('rotation staging file already exists');
  const { line } = makeRecord({ event: 'audit_segment_start', owner: 'system', id: 'audit', state: 'continued' }, state.sequence + 1, state.headHash);
  const fd = openSync(nextPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeAll(fd, line);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
  return line;
}

function scanNext(path: string, state: ChainState): FileScan {
  const nextPath = `${path}.next`;
  const scannedState = {
    legacyRecords: state.legacyRecords,
    legacyHash: state.legacyHash.copy(),
    chainedRecords: state.chainedRecords,
    chainStarted: state.chainStarted,
    headHash: state.headHash,
    sequence: state.sequence,
  };
  const scanned = scanPath(nextPath, scannedState, true);
  if (scanned.firstEvent !== 'audit_segment_start' || scanned.lastEvent !== 'audit_segment_start' || scanned.businessRecords !== 0) {
    fail('rotation staging file is not a single segment start marker');
  }
  return scanned;
}

function scanFiles(path: string, allowTerminalEnd = false): AuditScan {
  const { state, segments } = scanArchives(path);
  const activeStat = statMaybe(path);
  if (!activeStat) fail(segments.length ? 'active audit segment is missing' : 'audit file does not exist');
  if (!activeStat.isFile() || activeStat.isSymbolicLink()) fail('audit path is not a regular file');
  const active = scanPath(path, state, segments.length > 0);
  if (segments.length > 0 && active.bytes > 0 && active.firstEvent !== 'audit_segment_start') fail('active segment has no start marker');
  if (segments.length === 0 && state.chainStarted && active.bytes > 0 && active.firstEvent !== 'audit_chain_start') fail('active root segment has no start marker');
  if (active.lastEvent === 'audit_segment_end' && !allowTerminalEnd) fail('rotation is incomplete; restart the server to recover it');
  return { state, active, archivedSegments: segments.length };
}

function ensureNextValid(path: string, state: ChainState): void {
  const nextStat = statMaybe(`${path}.next`);
  if (!nextStat) {
    writeNextSegment(path, state);
    return;
  }
  if (!nextStat.isFile() || nextStat.isSymbolicLink()) fail('rotation staging path is not a regular file');
  const uid = process.getuid?.();
  if (uid !== undefined && nextStat.uid !== uid) fail('rotation staging file is owned by a different account');
  if ((nextStat.mode & 0o077) !== 0) fail('rotation staging permissions are broader than 0600');
  scanNext(path, state);
}

function promoteNext(path: string): void {
  if (statMaybe(path)) fail('cannot promote rotation staging file over an active audit path');
  renameSync(`${path}.next`, path);
  fsyncDirectory(dirname(path));
}

function recoverRotation(path: string): void {
  const archives = listArchives(path);
  const activeStat = statMaybe(path);
  const nextStat = statMaybe(`${path}.next`);
  if (nextStat && (!nextStat.isFile() || nextStat.isSymbolicLink())) fail('rotation staging path is not a regular file');

  if (activeStat && (!activeStat.isFile() || activeStat.isSymbolicLink())) fail('audit path is not a regular file');
  const duplicateArchive = activeStat && archives.find(segment => segment.dev === activeStat.dev && segment.ino === activeStat.ino);
  if (duplicateArchive) {
    if (duplicateArchive !== archives[archives.length - 1] || !nextStat) fail('incomplete rotation has no valid continuation');
    const archived = scanArchives(path);
    scanNext(path, archived.state);
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    promoteNext(path);
    return;
  }

  if (activeStat) {
    const scan = scanFiles(path, true);
    if (scan.active.lastEvent !== 'audit_segment_end') {
      if (nextStat) fail('orphan rotation staging file has no closed segment');
      return;
    }
    ensureNextValid(path, scan.state);
    const archive = segmentPath(path, scan.active);
    if (statMaybe(archive)) fail('archive destination already exists with different contents');
    linkSync(path, archive);
    fsyncDirectory(dirname(path));
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    promoteNext(path);
    return;
  }

  if (nextStat) {
    if (archives.length === 0) fail('rotation staging file has no archived predecessor');
    const archived = scanArchives(path);
    scanNext(path, archived.state);
    promoteNext(path);
    return;
  }
  if (archives.length > 0) fail('active audit segment and rotation staging file are both missing');
}

function verifyAuditFiles(path: string): AuditVerification {
  const lock = acquireLock(`${path}.lock`);
  try {
    if (statMaybe(`${path}.next`)) fail('rotation is incomplete; restart the server to recover it');
    const scan = scanFiles(path);
    return {
      valid: true,
      chainStarted: scan.state.chainStarted,
      legacyRecords: scan.state.legacyRecords,
      chainedRecords: scan.state.chainedRecords,
      segments: scan.archivedSegments + 1,
      headHash: scan.state.headHash,
    };
  } finally {
    closeSync(lock.fd);
    releaseLock(`${path}.lock`, lock.nonce);
  }
}

export function verifyAuditFile(path: string): AuditVerification {
  return verifyAuditFiles(path);
}

export class AuditLog {
  private fd: number | undefined;
  private readonly lockFd: number;
  private readonly lockNonce: string;
  private readonly maxFileBytes: number;
  private sequence = 0;
  private headHash = ZERO_HASH;
  private activeBytes = 0;
  private activeBusinessRecords = 0;
  private closed = false;
  private failed = false;

  constructor(private readonly path: string, options: AuditLogOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < MIN_MAX_FILE_BYTES) {
      throw new Error(`AUDIT_CONFIG_INVALID: maxFileBytes must be at least ${MIN_MAX_FILE_BYTES}`);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(`${path}.lock`);
    this.lockFd = lock.fd;
    this.lockNonce = lock.nonce;
    let fd: number | undefined;
    try {
      recoverRotation(path);
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      assertOwnedRegularFile(fd);
      fchmodSync(fd, 0o600);
      const scan = scanFiles(path);
      this.sequence = scan.state.sequence;
      this.headHash = scan.state.headHash ?? ZERO_HASH;
      this.activeBytes = fstatSync(fd).size;
      this.activeBusinessRecords = scan.active.businessRecords;
      this.fd = fd;
      if (!scan.state.chainStarted) {
        this.writeRecord({
          event: 'audit_chain_start', owner: 'system', id: 'audit', state: 'started',
          legacyCount: scan.state.legacyRecords,
          legacySha256: scan.state.legacyHash.copy().digest('hex'),
        });
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      closeSync(this.lockFd);
      releaseLock(`${this.path}.lock`, this.lockNonce);
      throw error;
    }
  }

  append(event: AuditEvent): void {
    if (this.closed) throw new Error('AUDIT_CLOSED: audit log is closed');
    if (this.failed) throw new Error('AUDIT_WRITE_FAILED: audit log is unavailable');
    if (STRUCTURAL_EVENTS.has(event.event)) throw new Error('AUDIT_EVENT_RESERVED: structural event names are reserved');
    try {
      const proposed = makeRecord(event, this.sequence + 1, this.headHash).line.length;
      if (this.activeBusinessRecords > 0 && this.activeBytes + proposed > this.maxFileBytes) this.rotate();
      this.writeRecord(event);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  get healthy(): boolean { return !this.closed && !this.failed; }

  private writeRecord(event: AuditEvent & { legacyCount?: number; legacySha256?: string }): void {
    if (this.fd === undefined) throw new Error('AUDIT_WRITE_FAILED: audit file is not open');
    const { line, hash, sequence } = makeRecord(event, this.sequence + 1, this.headHash);
    writeAll(this.fd, line);
    fsyncSync(this.fd);
    this.sequence = sequence;
    this.headHash = hash;
    this.activeBytes += line.length;
    if (!STRUCTURAL_EVENTS.has(event.event)) this.activeBusinessRecords++;
  }

  private rotate(): void {
    if (this.fd === undefined) throw new Error('AUDIT_WRITE_FAILED: audit file is not open');
    this.writeRecord({ event: 'audit_segment_end', owner: 'system', id: 'audit', state: 'closed' });
    const scan = scanFiles(this.path, true);
    if (scan.active.lastEvent !== 'audit_segment_end') fail('active segment failed to close');
    ensureNextValid(this.path, scan.state);
    const archive = segmentPath(this.path, scan.active);
    if (statMaybe(archive)) fail('archive destination already exists');
    linkSync(this.path, archive);
    fsyncDirectory(dirname(this.path));
    closeSync(this.fd);
    this.fd = undefined;
    unlinkSync(this.path);
    fsyncDirectory(dirname(this.path));
    promoteNext(this.path);
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    assertOwnedRegularFile(this.fd);
    const start = scanNextFromArchive(this.path);
    this.sequence = start.sequence;
    this.headHash = start.hash;
    this.activeBytes = start.bytes;
    this.activeBusinessRecords = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.fd !== undefined) closeSync(this.fd); }
    finally {
      try { closeSync(this.lockFd); }
      finally { releaseLock(`${this.path}.lock`, this.lockNonce); }
    }
  }
}

function scanNextFromArchive(path: string): { sequence: number; hash: string; bytes: number } {
  const { state, segments } = scanArchives(path);
  if (segments.length === 0 || !state.headHash) fail('continued audit chain has no archived segment');
  const nextState = {
    legacyRecords: state.legacyRecords,
    legacyHash: state.legacyHash.copy(),
    chainedRecords: state.chainedRecords,
    chainStarted: state.chainStarted,
    headHash: state.headHash,
    sequence: state.sequence,
  };
  const active = scanPath(path, nextState, true);
  if (active.firstEvent !== 'audit_segment_start' || active.lastEvent !== 'audit_segment_start') fail('new active segment start marker is invalid');
  if (!active.lastSequence || !active.lastHash) fail('new active segment start marker is incomplete');
  return { sequence: active.lastSequence, hash: active.lastHash, bytes: active.bytes };
}
