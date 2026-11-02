// Runs one Cloudflare request from an issue through the MCP Worker and posts the result back.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APPROVED = "approved";
const NEEDS_APPROVAL = "needs-approval";
const DONE = "done";
const FAILED = "failed";
const MAX_RESULT_CHARS = 60_000;
const TOOLS = new Set(["cloudflare_status", "cloudflare_request", "cloudflare_deploy_worker"]);

/** Accepts a fenced JSON block or a bare JSON body. Throws with a message meant for the requester. */
export function parseRequest(body) {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(body ?? "");
  let request;
  try {
    request = JSON.parse(fenced ? fenced[1] : body);
  } catch {
    throw new Error('The issue body must be JSON, for example {"method":"GET","path":"/zones"}.');
  }
  if (request === null || typeof request !== "object") throw new Error("The request must be a JSON object.");
  if (request.tool !== undefined) {
    if (!TOOLS.has(request.tool)) throw new Error(`Unknown tool. Allowed: ${[...TOOLS].join(", ")}.`);
    return { tool: request.tool, arguments: request.arguments ?? {} };
  }
  if (typeof request.path !== "string") throw new Error('The request needs a "path", or a "tool".');
  const { path, query, body: requestBody, content_type } = request;
  const method = String(request.method ?? "GET").toUpperCase();
  return { tool: "cloudflare_request", arguments: { method, path, query, body: requestBody, content_type } };
}

export function isReadOnly(request) {
  if (request.tool === "cloudflare_status") return true;
  return request.tool === "cloudflare_request" && request.arguments.method === "GET";
}

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  return "`".repeat(longest + 1);
}

function createGithub({ repository, token, fetchImpl }) {
  async function api(method, path, body) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-gateway-requests",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  return {
    getIssue: (number) => api("GET", `/issues/${number}`),
    getEvents: (number) => api("GET", `/issues/${number}/events?per_page=100`),
    comment: (number, body) => api("POST", `/issues/${number}/comments`, { body }),
    addLabel: (number, label) => api("POST", `/issues/${number}/labels`, { labels: [label] }),
    removeLabel: (number, label) => api("DELETE", `/issues/${number}/labels/${encodeURIComponent(label)}`),
    close: (number) => api("PATCH", `/issues/${number}`, { state: "closed" }),
  };
}

async function callTool(request, { url, key, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: request.tool, arguments: request.arguments } }),
  });
  if (response.status === 401) {
    return { isError: true, text: "The gateway rejected the access key. The owner should run: npm run connect-github" };
  }
  if (!response.ok) return { isError: true, text: `The gateway returned HTTP ${response.status}.` };
  const { result, error } = await response.json();
  if (error) return { isError: true, text: error.message };
  return { isError: Boolean(result.isError), text: result.content[0].text };
}

/**
 * The label must come from the owner directly. A connector acting through a GitHub App is
 * marked as such on the event, so an agent cannot approve its own request that way.
 */
async function isApprovedByOwner(event, github) {
  const { sender, repository, issue } = event;
  if (sender.type !== "User" || sender.login !== repository.owner.login) return false;
  const labeled = (await github.getEvents(issue.number)).filter((item) => item.event === "labeled" && item.label?.name === APPROVED);
  const latest = labeled.at(-1);
  return Boolean(latest) && latest.actor?.login === repository.owner.login && !latest.performed_via_github_app;
}

/** Returns what happened, for logs and tests. */
export async function run({ event, env, fetchImpl = fetch }) {
  // Public, anyone could open an issue and use the Cloudflare token.
  if (event.repository.private !== true) return "refused: repository is not private";

  const { number } = event.issue;
  const github = createGithub({ repository: event.repository.full_name, token: env.GITHUB_TOKEN, fetchImpl });
  const labels = (await github.getIssue(number)).labels.map((label) => label.name);
  if (labels.includes(DONE) || labels.includes(FAILED)) return "skipped: already handled";

  const finish = async (text, failed) => {
    const clean = env.MCP_ACCESS_KEY ? text.replaceAll(env.MCP_ACCESS_KEY, "[REDACTED]") : text;
    const shown = clean.length > MAX_RESULT_CHARS ? `${clean.slice(0, MAX_RESULT_CHARS)}\n[truncated: narrow the request with per_page or filters]` : clean;
    const marks = fence(shown);
    await github.comment(number, `${failed ? "Request failed." : "Result:"}\n\n${marks}\n${shown}\n${marks}`);
    await github.addLabel(number, failed ? FAILED : DONE);
    await github.close(number);
    return failed ? "failed" : "done";
  };

  let request;
  try {
    request = parseRequest(event.issue.body);
  } catch (error) {
    return finish(error.message, true);
  }

  const readOnly = isReadOnly(request);
  const requireApproval = env.REQUIRE_APPROVAL !== "false";
  if (!readOnly && requireApproval) {
    if (event.action === "opened") {
      await github.addLabel(number, NEEDS_APPROVAL);
      await github.comment(number, `This request changes Cloudflare, so it is waiting for the owner. Owner: add the \`${APPROVED}\` label to run it.`);
      return "waiting for approval";
    }
    if (!(await isApprovedByOwner(event, github))) {
      await github.removeLabel(number, APPROVED);
      await github.comment(number, `The \`${APPROVED}\` label only counts when the owner adds it directly on GitHub. It was removed, and the request did not run.`);
      return "refused: not approved by owner";
    }
    if (labels.includes(NEEDS_APPROVAL)) await github.removeLabel(number, NEEDS_APPROVAL);
  } else if (event.action === "labeled") {
    // This request already ran, or is running, from its "opened" event.
    return "skipped: no approval needed";
  }

  if (!env.MCP_URL || !env.MCP_ACCESS_KEY) return finish("The gateway is not configured. The owner should run: npm run connect-github", true);
  try {
    const { text, isError } = await callTool(request, { url: env.MCP_URL, key: env.MCP_ACCESS_KEY, fetchImpl });
    return await finish(text, isError);
  } catch (error) {
    return finish(`Could not reach the gateway: ${error.message}`, true);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  console.log(await run({ event, env: process.env }));
}
