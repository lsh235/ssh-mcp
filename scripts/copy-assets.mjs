import { cpSync } from 'node:fs';
cpSync('src/runner', 'dist/runner', { recursive: true, filter: p => !p.endsWith('.ts') });
