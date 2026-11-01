import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  CLOUDFLARE_API_TOKEN?: string;
  MCP_ACCESS_KEY?: string;
  /** Used when the token can see several accounts, or cannot list accounts at all. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Test hook, honoured for local addresses only. See apiBase() in cloudflare.ts. */
  CF_API_BASE?: string;
  OAUTH_KV: KVNamespace;
  AUTH_LIMITER: RateLimit;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface GrantProps {
  /** Hash of the access key at approval time, so rotating the key cuts off existing OAuth grants. */
  keyFingerprint: string;
}
