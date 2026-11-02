// One-time setup: stores the token in your Worker, deploys it and registers it in your agents.
import { homedir } from "node:os";
import { registerAgents } from "./lib/agents.mjs";
import {
  ask,
  askHidden,
  fetchAccounts,
  generateKey,
  isTokenValid,
  printAgentResults,
  putSecrets,
  updateRequestsRepoKey,
  waitForServer,
  wrangler,
  writeState,
} from "./lib/common.mjs";

async function ensureWranglerLogin() {
  if (process.env.CLOUDFLARE_API_TOKEN) return;
  const { code } = await wrangler(["whoami", "--json"], { capture: true });
  if (code === 0) return;
  console.log("Log in to Cloudflare so this script can deploy the Worker. A browser window will open.");
  const login = await wrangler(["login"], { interactive: true });
  if (login.code !== 0) throw new Error("wrangler login failed");
}

async function chooseAccount(accounts) {
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    return ask("This token cannot list accounts. Paste your account ID (from the dashboard): ");
  }
  accounts.forEach((account, index) => console.log(`  [${index + 1}] ${account.name} (${account.id})`));
  const choice = accounts[Number(await ask("Which account should host the Worker and be the default? ")) - 1];
  if (!choice) throw new Error("no such account");
  return choice.id;
}

async function deploy(accountId) {
  console.log("Deploying the Worker...");
  // Output is captured to read the URL. stdin stays closed, so Wrangler creates the KV namespace itself instead of prompting.
  const { code, stdout, stderr } = await wrangler(["deploy"], { capture: true, accountId });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (code !== 0) throw new Error("wrangler deploy failed, see the output above");
  const found = /https:\/\/[^\s]+\.workers\.dev/.exec(stdout)?.[0];
  return found ?? ask("Could not read the Worker URL from the output. Paste it (https://...): ");
}

async function main() {
  await ensureWranglerLogin();

  console.log("Create a token at https://dash.cloudflare.com/profile/api-tokens with only the permissions your agents need.");
  const token = await askHidden("Paste the Cloudflare API token, then press Enter (shown as *): ");
  if (!token) throw new Error("empty token");

  const accountId = await chooseAccount(await fetchAccounts(token));
  if (!accountId) throw new Error("an account ID is required");
  if (!(await isTokenValid(token, accountId))) throw new Error("Cloudflare rejected this token, nothing was deployed");
  console.log("Token verified.");

  const baseUrl = (await deploy(accountId)).replace(/\/$/, "");
  const url = `${baseUrl}/mcp`;
  const key = generateKey();

  console.log("Storing secrets in the Worker...");
  await putSecrets({ CLOUDFLARE_API_TOKEN: token, MCP_ACCESS_KEY: key, CLOUDFLARE_ACCOUNT_ID: accountId }, accountId);
  writeState({ url, accountId });

  console.log("Waiting for the server...");
  const status = await waitForServer(url, key);
  console.log(`Server is up. Token status: ${status.token}`);

  console.log("Registering with your agents:");
  printAgentResults(registerAgents({ home: homedir(), url, key }));
  updateRequestsRepoKey(key);

  console.log(`
Done. Restart any agent that is already open.

MCP URL:    ${url}
Access key: ${key}

The access key is shown only here. Keep it in a password manager: it is what you
type when a web client such as claude.ai asks you to authorize. Anyone who has it
can use your Cloudflare token. To replace it, run: npm run rotate-key`);
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  process.exit(1);
});
