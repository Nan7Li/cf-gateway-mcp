import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_FILE = join(ROOT, ".setup-state.json");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const API = "https://api.cloudflare.com/client/v4";

export function generateKey() {
  return randomBytes(32).toString("base64url");
}

export function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Echoes * per character: with no feedback at all, people cannot tell whether a paste landed. */
export function askHidden(question) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
      const rl = createInterface({ input: process.stdin, output: muted, terminal: false });
      rl.question("", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer.trim());
      });
    });
  }
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let value = "";
    const erase = (count) => stdout.write("\b \b".repeat(count));
    const onData = (chunk) => {
      // Terminals may wrap a paste in bracketed-paste markers.
      for (const char of chunk.replace(/\x1b\[20[01]~/g, "")) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          stdin.pause();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u0015") {
          erase(value.length);
          value = "";
        } else if (char === "\u007f" || char === "\b") {
          if (value) {
            erase(1);
            value = value.slice(0, -1);
          }
        } else if (char >= " ") {
          value += char;
          stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Runs the project's Wrangler without a shell. Secrets only ever travel through `input`. */
export function wrangler(args, { input, capture = false, interactive = false, accountId } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
    const stdin = interactive ? "inherit" : input === undefined ? "ignore" : "pipe";
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT,
      env,
      stdio: [stdin, capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Sends secrets over stdin, so they never reach a file, an argument list or shell history. */
export async function putSecrets(secrets, accountId) {
  const { code } = await wrangler(["secret", "bulk"], { input: JSON.stringify(secrets), accountId });
  if (code !== 0) throw new Error("wrangler secret bulk failed, see the output above");
}

async function cfGet(token, path) {
  const response = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export async function fetchAccounts(token) {
  const { status, body } = await cfGet(token, "/accounts?per_page=50");
  return status === 200 ? (body.result ?? []).map(({ id, name }) => ({ id, name })) : [];
}

export async function isTokenValid(token, accountId) {
  if ((await cfGet(token, "/user/tokens/verify")).status === 200) return true;
  return Boolean(accountId) && (await cfGet(token, `/accounts/${encodeURIComponent(accountId)}/tokens/verify`)).status === 200;
}

async function mcpCall(url, key, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

/** New secrets take a moment to reach the edge, so retry for up to a minute. */
export async function waitForServer(url, key) {
  const initialize = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cf-gateway-setup", version: "1" },
  };
  let last = "no response";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const { status } = await mcpCall(url, key, "initialize", initialize);
      if (status === 200) {
        const { body } = await mcpCall(url, key, "tools/call", { name: "cloudflare_status", arguments: {} });
        return JSON.parse(body.result.content[0].text);
      }
      last = `HTTP ${status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`the server did not become ready (${last})`);
}

export function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
}

/** Holds no secrets: only where things live, for rotate-key and connect-github. Merges into what is there. */
export function writeState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), ...state }, null, 2)}\n`);
}

/** Sends the key over stdin, so it never reaches an argument list. */
export function setRequestsRepoKey(repo, key) {
  const result = spawnSync("gh", ["secret", "set", "MCP_ACCESS_KEY", "--repo", repo], { input: key, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not store the key in ${repo}: ${result.stderr.trim()}`);
}

/** A new access key would otherwise silently break the requests repository. */
export function updateRequestsRepoKey(key) {
  const repo = readState()?.requestsRepo;
  if (!repo) return;
  setRequestsRepoKey(repo, key);
  console.log(`  OK      GitHub requests repository: ${repo}`);
}

export function printAgentResults(results) {
  for (const { agent, status, detail } of results) {
    console.log(`  ${status === "ok" ? "OK     " : status === "skipped" ? "SKIP   " : "FAILED "} ${agent}${detail ? `: ${detail}` : ""}`);
  }
}
