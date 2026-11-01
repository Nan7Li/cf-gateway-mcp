import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bearerToken, isConfigured, isRateLimited, keyFingerprint, keyMatches } from "./auth";
import type { Env, GrantProps } from "./env";
import { defaultHandler } from "./oauth";
import { createServer } from "./tools";

const REGISTER_PATH = "/oauth/register";

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless server: there are no sessions to stream to or delete.
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await createServer(env).connect(transport);
  return transport.handleRequest(request);
}

const providers = new Map<string, OAuthProvider<Env>>();

/** The provider needs this server's public URL, which is only known once a request arrives. */
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = createProvider(origin);
    providers.set(origin, provider);
  }
  return provider;
}

const createProvider = (origin: string) => new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request, env, ctx) {
      const { keyFingerprint: granted } = (ctx as unknown as { props: GrantProps }).props;
      if (granted !== (await keyFingerprint(env))) {
        return new Response("Access key was rotated. Authorize again.", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        });
      }
      return handleMcp(request, env);
    },
  },
  defaultHandler: defaultHandler as ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: REGISTER_PATH,
  scopesSupported: ["cloudflare"],
  resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fail closed: without both secrets nothing, including OAuth approval, may work.
    if (!isConfigured(env)) {
      return new Response("cf-gateway-mcp is not configured. Set CLOUDFLARE_API_TOKEN and MCP_ACCESS_KEY (at least 32 characters).\n", { status: 503 });
    }

    const { pathname, origin } = new URL(request.url);
    const provider = providerFor(origin);
    // Registration is open by design of OAuth, so stop strangers from filling KV with clients.
    if (pathname === REGISTER_PATH && (await isRateLimited(request, env))) {
      return new Response("Too many requests", { status: 429 });
    }
    if (pathname !== "/mcp") return provider.fetch(request, env, ctx);

    const bearer = bearerToken(request);
    if (bearer && (await keyMatches(bearer, env))) return handleMcp(request, env);

    const response = await provider.fetch(request, env, ctx);
    // A 401 without a bearer token is the normal start of OAuth discovery, so only count real attempts.
    if (bearer && response.status === 401 && (await isRateLimited(request, env))) {
      return new Response("Too many failed attempts", { status: 429 });
    }
    return response;
  },
};
