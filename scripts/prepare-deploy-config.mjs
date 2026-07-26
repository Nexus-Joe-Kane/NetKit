import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const databaseName = process.env.D1_DATABASE_NAME || "hot-tub";
const outputPath = process.argv[2] || ".generated.wrangler.jsonc";

if (!accountId || !apiToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`;
const headers = {
  Authorization: `Bearer ${apiToken}`,
  "Content-Type": "application/json",
};

async function cloudflare(path = "", init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    const details = body.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare D1 request failed: ${details}`);
  }
  return body.result;
}

const databases = await cloudflare("?per_page=100");
let database = databases.find((candidate) => candidate.name === databaseName);

if (!database) {
  database = await cloudflare("", {
    method: "POST",
    body: JSON.stringify({ name: databaseName }),
  });
  console.log(`Created D1 database ${databaseName}.`);
} else {
  console.log(`Using existing D1 database ${databaseName}.`);
}

// Parse JSONC (JSON with Comments and trailing commas)
function parseJsonc(text) {
  let withoutComments = text
    .replace(/\/\/.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // Remove multi-line comments
  // Remove trailing commas before closing brackets/braces
  withoutComments = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutComments);
}

const config = parseJsonc(await readFile("wrangler.jsonc", "utf8"));
const binding = config.d1_databases?.find((candidate) => candidate.binding === "DB");
if (!binding) {
  throw new Error("wrangler.jsonc does not contain the DB D1 binding.");
}
binding.database_name = databaseName;
binding.database_id = database.uuid;

const teamDomain = process.env.ADMIN_ACCESS_TEAM_DOMAIN;
const audience = process.env.ADMIN_ACCESS_AUDIENCE;
if (teamDomain) config.vars.ADMIN_ACCESS_TEAM_DOMAIN = teamDomain;
if (audience) config.vars.ADMIN_ACCESS_AUDIENCE = audience;

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Prepared ${outputPath}.`);
