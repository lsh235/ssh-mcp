import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
const httpsUrl = z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required');
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
const prompt = z.string().min(1).max(256);
const valueSource = z.union([
  z.object({env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)}).strict(),
  z.object({file:z.string().startsWith('/')}).strict()
]);
const postLogin = z.object({
  steps:z.array(z.object({expect:prompt,valueFrom:valueSource}).strict()).min(1).max(8),
  ready:prompt,
  lineEnding:z.enum(['lf','cr','crlf']).default('lf'),
  timeoutMs:z.number().int().min(100).max(30000).default(10000)
}).strict();
export const configSchema = z.object({
  host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(8787),
  publicUrl: z.url().default('http://127.0.0.1:8787/mcp'),
  allowedHosts: z.array(z.string()).min(1).default(['127.0.0.1', 'localhost']),
  allowedOrigins: z.array(z.url()).default([]),
  stateDir: z.string().default('.state'),
  audit: z.object({
    maxFileBytes: z.number().int().min(16384).max(1073741824).default(10485760)
  }).prefault({}),
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('token'), tokenEnv: z.string().default('SHELL_MCP_TOKEN'), principal: z.string().min(1).default('owner') }),
    z.object({ mode: z.literal('oauth'), issuer: httpsUrl, audience: z.string().min(1), jwksUrl: httpsUrl,
      subjects: z.array(z.string().min(1)).min(1), requiredScopes: z.array(z.string()).default(['shell:use']) })
  ]),
  limits: z.object({
    maxSessions: z.number().int().min(1).max(32).default(4),
    maxOutputBytes: z.number().int().min(1024).max(10485760).default(1048576),
    maxCommandMs: z.number().int().min(100).max(1800000).default(1800000),
    idleMs: z.number().int().min(1000).default(1800000),
    retentionMs: z.number().int().min(1000).default(86400000),
    maxInputBytes: z.number().int().min(1).max(10485760).default(1048576),
    maxInputMessages: z.number().int().min(1).max(1024).default(128),
    pollMs: z.number().int().min(50).max(5000).default(250)
  }).prefault({}),
  targets: z.record(identifier, z.object({
    description: z.string().default('SSH development target'),
    sshAlias: identifier,
    sshConfig: z.string().optional(),
    postLogin: postLogin.optional(),
    principals: z.array(z.string().min(1)).min(1),
    workspaces: z.record(identifier, z.string().startsWith('/')).refine(v => Object.keys(v).length > 0)
  }))
});
export type Config = z.infer<typeof configSchema>;
export type Target = Config['targets'][string];
export function parseConfig(value: unknown): Config {
  const config = configSchema.parse(value);
  const url = new URL(config.publicUrl);
  if (url.pathname !== '/mcp' || url.search || url.hash) throw new Error('publicUrl must end in /mcp');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback) throw new Error('Bind to loopback; publish through the supplied HTTPS reverse proxy');
  if (config.auth.mode === 'oauth' && url.protocol !== 'https:') throw new Error('OAuth requires an HTTPS publicUrl');
  config.stateDir = resolve(config.stateDir);
  return config;
}
export function loadConfig(path: string) { return parseConfig(JSON.parse(readFileSync(path, 'utf8'))); }
