import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Fault } from './core.js';
export interface RecordValue { id: string; owner: string; state: string; updatedAt: number; [key: string]: unknown; }
export class Store {
  private db: Database.Database;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    const path = join(dir, 'state.sqlite'); this.db = new Database(path); chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests(owner TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,scope,key));
      CREATE TABLE IF NOT EXISTS command_order(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL);
      INSERT OR IGNORE INTO command_order(id,owner) SELECT id,owner FROM records WHERE kind='command' ORDER BY json_extract(data,'$.startedAt'),id;`);
    for (const kind of ['session', 'command', 'input', 'transfer']) for (const row of this.list(kind)) {
      if (['opening', 'ready', 'busy', 'accepted', 'running', 'cancel_requested', 'started'].includes(row.state)) {
        this.put(kind, { ...row, state: kind === 'session' ? 'broken' : 'unknown', reason: 'SERVER_RESTART', exitCode: null });
      }
    }
  }
  put(kind: string, row: RecordValue) {
    row.updatedAt = Date.now();
    if(kind==='command')this.db.prepare('INSERT OR IGNORE INTO command_order(id,owner) VALUES(?,?)').run(row.id,row.owner);
    this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(kind, row.id, row.owner, JSON.stringify(row));
    return row;
  }
  get(kind: string, id: string, owner: string): RecordValue {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=? AND owner=?').get(kind, id, owner) as {data: string} | undefined;
    if (!row) throw new Fault('NOT_FOUND', 'Resource not found or not owned by this principal');
    return JSON.parse(row.data);
  }
  list(kind: string, owner?: string): RecordValue[] {
    const rows = owner === undefined ? this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind) : this.db.prepare('SELECT data FROM records WHERE kind=? AND owner=?').all(kind, owner);
    return (rows as {data: string}[]).map(r => JSON.parse(r.data));
  }
  request(owner: string, scope: string, key: string, digest?: string): string | undefined {
    const row = this.db.prepare('SELECT digest,result FROM requests WHERE owner=? AND scope=? AND key=?').get(owner, scope, key) as {digest: string; result: string} | undefined;
    if (row && digest !== undefined && digest !== row.digest) throw new Fault('REQUEST_CONFLICT', 'Request key already used with different content');
    return row?.result;
  }
  commands(owner:string,sessionId:string,state:string|undefined,cursor:number,maximum:number) {
    const rows=this.db.prepare(`SELECT o.seq,r.data FROM command_order o JOIN records r ON r.kind='command' AND r.id=o.id
      WHERE r.owner=? AND json_extract(r.data,'$.sessionId')=? AND o.seq>? AND (? IS NULL OR json_extract(r.data,'$.state')=?)
      ORDER BY o.seq LIMIT ?`).all(owner,sessionId,cursor,state??null,state??null,maximum+1) as {seq:number;data:string}[];
    const page=rows.slice(0,maximum);
    return {commands:page.map(r=>JSON.parse(r.data) as RecordValue),nextCursor:rows.length>maximum?page.at(-1)!.seq:null,lastCursor:page.at(-1)?.seq??cursor};
  }
  recentCommands(owner:string,sessionId:string,maximum=50):RecordValue[] {
    const rows=this.db.prepare(`SELECT r.data FROM command_order o JOIN records r ON r.kind='command' AND r.id=o.id
      WHERE r.owner=? AND json_extract(r.data,'$.sessionId')=? ORDER BY o.seq DESC LIMIT ?`).all(owner,sessionId,maximum) as {data:string}[];
    return rows.map(row=>JSON.parse(row.data));
  }
  remember(owner: string, scope: string, key: string, digest: string, result: string) {
    this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(owner, scope, key, digest, result);
  }
  close() { this.db.close(); }
}
