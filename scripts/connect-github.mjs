// Lets agents that only have a GitHub connector use Cloudflare, through a private requests repository.
// Run after npm run setup. Safe to rerun: it updates the template and the stored key.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readState, setRequestsRepoKey, writeState } from "./lib/common.mjs";

const REPO_NAME = "cf-gateway-requests";
const LABELS = [
  ["approved", "0e8a16", "Owner approved this request"],
  ["needs-approval", "fbca04", "Waiting for the owner"],
  ["done", "2ea44f", "Request completed"],
  ["failed", "d73a4a", "Request failed"],
];

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ensurePrivateRepo(repo) {
  const view = spawnSync("gh", ["repo", "view", repo, "--json", "isPrivate", "--jq", ".isPrivate"], { encoding: "utf8" });
  if (view.status !== 0) {
    gh("repo", "create", repo, "--private", "--description", "Cloudflare requests for agents that only have a GitHub connector");
    console.log(`Created private repository ${repo}`);
    return;
  }
  if (view.stdout.trim() !== "true") throw new Error(`${repo} exists and is not private. Make it private first.`);
}

function syncTemplate(repo, login, userId) {
  const folder = mkdtempSync(join(tmpdir(), "cfgw-requests-"));
  try {
    git(folder, "clone", "--quiet", `https://github.com/${repo}.git`, ".");
    git(folder, "checkout", "-q", "-B", "main");
    cpSync(join(ROOT, "templates", "requests-repo"), folder, { recursive: true });
    git(folder, "add", "-A");
    if (!git(folder, "status", "--porcelain")) {
      console.log("Template is up to date.");
      return;
    }
    git(folder, "-c", `user.name=${login}`, "-c", `user.email=${userId}+${login}@users.noreply.github.com`, "commit", "-q", "-m", "Update Cloudflare gateway");
    git(folder, "push", "-q", "-u", "origin", "main");
    console.log("Template pushed.");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The key is read locally and goes straight to gh over stdin. It is never printed. */
function readAccessKey() {
  const file = join(homedir(), ".claude.json");
  if (existsSync(file)) {
    const header = JSON.parse(readFileSync(file, "utf8")).mcpServers?.["cf-gateway"]?.headers?.Authorization;
    if (header) return header.replace(/^Bearer /, "");
  }
  throw new Error("could not find the access key in ~/.claude.json. Run: npm run rotate-key, then run this again.");
}

function main() {
  const skipSecret = process.argv.includes("--skip-secret");
  const state = readState();
  if (!state?.url) throw new Error("no .setup-state.json found. Run npm run setup first, in this folder.");

  const login = gh("api", "user", "--jq", ".login");
  const userId = gh("api", "user", "--jq", ".id");
  const repo = `${login}/${REPO_NAME}`;

  ensurePrivateRepo(repo);
  syncTemplate(repo, login, userId);
  for (const [name, color, description] of LABELS) gh("label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force");
  gh("variable", "set", "MCP_URL", "--repo", repo, "--body", state.url);
  writeState({ requestsRepo: repo });

  if (skipSecret) {
    console.log("Skipped the access key (--skip-secret). Requests will fail until you run this without the flag.");
    return;
  }
  setRequestsRepoKey(repo, readAccessKey());
  console.log(`
Done. Stored the access key as an Actions secret in ${repo}.

Next: make sure your GitHub connector can read and write this repository, because
connectors are often limited to selected repositories.
Then tell any agent: read the README of ${repo} to use Cloudflare.`);
}

try {
  main();
} catch (error) {
  console.error(`\nFailed: ${error.stderr?.toString().trim() || error.message}`);
  process.exit(1);
}
