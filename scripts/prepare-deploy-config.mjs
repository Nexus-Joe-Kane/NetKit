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

// Remove `//` and `/* */` comments while respecting string literals, so that
// sequences like the `//` in "https://example.com" are not mistaken for the
// start of a comment.
function stripComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

// Drop trailing commas before a closing `}`/`]`, again respecting string
// literals so commas inside string values are left untouched.
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        continue; // skip the trailing comma
      }
    }
    out += char;
  }
  return out;
}

// Parse JSONC (JSON with comments and trailing commas).
function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
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
