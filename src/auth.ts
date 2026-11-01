import type { Env } from "./env";

const MIN_KEY_LENGTH = 32;

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export function isConfigured(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN) && (env.MCP_ACCESS_KEY?.length ?? 0) >= MIN_KEY_LENGTH;
}

/** Hashing first gives equal lengths, which timingSafeEqual requires. */
export async function keyMatches(candidate: string, env: Env): Promise<boolean> {
  if (!env.MCP_ACCESS_KEY) return false;
  const [a, b] = await Promise.all([sha256(candidate), sha256(env.MCP_ACCESS_KEY)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function keyFingerprint(env: Env): Promise<string> {
  const digest = new Uint8Array(await sha256(env.MCP_ACCESS_KEY ?? ""));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isRateLimited(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key });
  return !success;
}

export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  return match ? match[1].trim() : null;
}
