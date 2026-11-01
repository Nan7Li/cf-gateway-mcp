import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCloudflare, defaultAccountId, isTokenValid, listAccounts, scrub, truncate } from "./cloudflare";
import type { Env } from "./env";

const MODULE_TYPES: Record<string, string> = {
  js: "application/javascript+module",
  mjs: "application/javascript+module",
  cjs: "application/javascript",
  py: "text/x-python",
  json: "application/json",
  txt: "text/plain",
  html: "text/plain",
  sql: "text/plain",
};

const PERMISSION_HINT =
  "The token lacks this permission. Tell the user which permission to add at https://dash.cloudflare.com/profile/api-tokens (editing keeps the same token, so nothing else changes).";

function reply(env: Env, text: string, isError = false) {
  return { content: [{ type: "text" as const, text: truncate(scrub(text, env)) }], isError };
}

function replyFromApi(env: Env, status: number, text: string) {
  if (status < 400) return reply(env, text);
  const hint = status === 403 ? `\n${PERMISSION_HINT}` : "";
  return reply(env, `HTTP ${status}\n${text}${hint}`, true);
}

/** Tool failures must come back as results, with secrets removed, not as thrown protocol errors. */
function guarded<Args>(env: Env, handler: (args: Args) => Promise<ReturnType<typeof reply>>) {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return reply(env, error instanceof Error ? error.message : String(error), true);
    }
  };
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "cf-gateway-mcp", version: "0.1.0" });

  server.registerTool(
    "cloudflare_status",
    {
      description: "Check that the stored Cloudflare API token works and list the accounts it can use. Start here to find the account ID.",
      annotations: { readOnlyHint: true },
    },
    guarded(env, async () => {
      const accounts = await listAccounts(env);
      const accountId = defaultAccountId(env, accounts);
      const valid = await isTokenValid(env, accountId);
      const summary = { token: valid ? "active" : "invalid", default_account_id: accountId, accounts };
      return reply(env, JSON.stringify(summary, null, 2), !valid);
    }),
  );

  server.registerTool(
    "cloudflare_request",
    {
      description:
        "Call any Cloudflare API endpoint using the stored token. See https://developers.cloudflare.com/api/ for endpoints. Example: method GET, path /zones.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().describe("Path after https://api.cloudflare.com/client/v4, starting with /. Example: /zones/abc/dns_records"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query string parameters"),
        body: z.unknown().optional().describe("Request body. Objects and arrays are sent as JSON, strings as they are."),
        content_type: z.string().optional().describe("Content-Type for the body. Defaults to application/json."),
      },
    },
    guarded(env, async ({ method, path, query, body, content_type }) => {
      const hasBody = body !== undefined && body !== null;
      const { status, text } = await callCloudflare(env, method, path, {
        query,
        body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
        contentType: hasBody ? (content_type ?? "application/json") : undefined,
      });
      return replyFromApi(env, status, text);
    }),
  );

  server.registerTool(
    "cloudflare_deploy_worker",
    {
      description:
        "Deploy a bundled Worker through the API, for agents that cannot run wrangler with the token. Bundle locally first with: npx wrangler deploy --dry-run --outdir dist. Then pass the output files as modules. Text modules only.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("Worker name"),
        main_module: z.string().describe("Name of the entry module, e.g. index.js"),
        modules: z.array(z.object({ name: z.string().min(1), content: z.string() })).min(1),
        compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        compatibility_flags: z.array(z.string()).optional(),
        bindings: z.array(z.record(z.string(), z.unknown())).optional().describe("Worker bindings in the Cloudflare API format"),
        keep_bindings: z.array(z.string()).optional().describe('Binding types to keep from the current version, e.g. ["secret_text"]. Without this, existing secrets are removed.'),
        account_id: z.string().optional().describe("Defaults to the account shown by cloudflare_status"),
      },
    },
    guarded(env, async ({ name, main_module, modules, compatibility_date, compatibility_flags, bindings, keep_bindings, account_id }) => {
      const accountId = account_id ?? defaultAccountId(env, await listAccounts(env));
      if (!accountId) throw new Error("No default account. Pass account_id, see cloudflare_status.");
      if (!modules.some((module) => module.name === main_module)) throw new Error(`main_module ${main_module} is not in modules`);

      const form = new FormData();
      form.append(
        "metadata",
        JSON.stringify({
          main_module,
          compatibility_date,
          compatibility_flags,
          bindings: bindings ?? [],
          keep_bindings,
        }),
      );
      for (const module of modules) {
        const type = MODULE_TYPES[module.name.split(".").pop()?.toLowerCase() ?? ""];
        if (!type) throw new Error(`Unsupported module type: ${module.name}. Allowed: ${Object.keys(MODULE_TYPES).join(", ")}`);
        form.append(module.name, new File([module.content], module.name, { type }));
      }

      const path = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${name}`;
      const { status, text } = await callCloudflare(env, "PUT", path, { body: form });
      return replyFromApi(env, status, text);
    }),
  );

  return server;
}
