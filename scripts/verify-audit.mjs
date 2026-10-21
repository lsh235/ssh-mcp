import { resolve } from 'node:path';
import { verifyAuditFile } from '../dist/audit.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('Usage: npm run audit:verify -- /absolute/path/to/audit.jsonl\n');
  process.exitCode = 2;
} else {
  try {
    const result = verifyAuditFile(resolve(path));
    process.stdout.write(`Valid JSONL records: ${result.legacyRecords + result.chainedRecords}\n`);
    if (result.chainStarted) {
      process.stdout.write(`Hash chain: verified (${result.chainedRecords} chained records)\n`);
      process.stdout.write(`Head: ${result.headHash}\n`);
    } else {
      process.stdout.write(`Hash chain: not started (${result.legacyRecords} legacy records only)\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown verification failure';
    process.stderr.write(`Audit verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
