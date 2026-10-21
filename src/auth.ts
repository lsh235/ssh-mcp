import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { assert, Fault } from './core.js';

export class Authenticator {
  private token?: Buffer;
  private keys?: JWTVerifyGetKey;
  constructor(private config: Config, keys?: JWTVerifyGetKey) {
    if(config.auth.mode==='token') {
      const token=process.env[config.auth.tokenEnv]; assert(token&&Buffer.byteLength(token)>=32,'CONFIG_ERROR','Token environment variable must contain at least 32 bytes');
      this.token=Buffer.from(token);
    } else this.keys=keys??createRemoteJWKSet(new URL(config.auth.jwksUrl),{timeoutDuration:5000,cooldownDuration:30000});
  }
  async verify(header?: string): Promise<AuthInfo> {
    assert(typeof header==='string'&&header.startsWith('Bearer '),'UNAUTHENTICATED','Bearer authentication required');
    const token=header.slice(7); assert(token.length<=16384,'UNAUTHENTICATED','Invalid token');
    if(this.config.auth.mode==='token') {
      const candidate=Buffer.from(token);
      assert(candidate.length===this.token!.length&&timingSafeEqual(candidate,this.token!),'UNAUTHENTICATED','Invalid token');
      return {token,clientId:this.config.auth.principal,scopes:['shell:use'],extra:{principal:this.config.auth.principal}};
    }
    try {
      const {payload}=await jwtVerify(token,this.keys!,{issuer:this.config.auth.issuer,audience:this.config.auth.audience,algorithms:['RS256','ES256','EdDSA'],requiredClaims:['sub','exp','iat']});
      assert(payload.sub&&this.config.auth.subjects.includes(payload.sub),'UNAUTHENTICATED','Subject is not permitted');
      const scopes=typeof payload.scope==='string'?payload.scope.split(' '):[];
      assert(this.config.auth.requiredScopes.every(s=>scopes.includes(s)),'INSUFFICIENT_SCOPE','Required scope is missing');
      return {token,clientId:payload.sub,scopes,expiresAt:payload.exp,extra:{principal:payload.sub}};
    } catch(error) { if(error instanceof Fault)throw error; throw new Fault('UNAUTHENTICATED','Invalid or expired access token'); }
  }
  metadata() {
    assert(this.config.auth.mode==='oauth','NOT_FOUND','OAuth is not configured');
    return {resource:this.config.publicUrl,authorization_servers:[this.config.auth.issuer],scopes_supported:this.config.auth.requiredScopes,bearer_methods_supported:['header']};
  }
  challenge() {
    return this.config.auth.mode==='oauth'?`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp',this.config.publicUrl)}", scope="${this.config.auth.requiredScopes.join(' ')}"`:'Bearer realm="shell-mcp"';
  }
}
