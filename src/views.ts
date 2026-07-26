import type { AdminIdentity } from "./auth/access";
import type { Env } from "./config";
import { DEFAULT_SOURCE_NAME } from "./config";
import { listProviders } from "./providers/registry";
import type { ConnectionSummary } from "./storage/connections";
import { getPublicBaseUrl } from "./utils/urls";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export function rootPage(env: Env): string {
  const baseUrl = getPublicBaseUrl(env.PUBLIC_BASE_URL);
  const sourceName = env.SOURCE_NAME?.trim() || DEFAULT_SOURCE_NAME;
  const installUrl = `hottub://source?url=${encodeURIComponent(baseUrl.toString().replace(/\/$/u, ""))}`;
  const providers = listProviders();
  const cards = providers
    .map(
      (provider) => `<article class="card">
        <div class="card-heading">
          <h2>${escapeHtml(provider.name)}</h2>
          <span class="badge ${provider.status === "active" ? "active" : provider.status === "degraded" ? "degraded" : "restricted"}">${escapeHtml(provider.status)}</span>
        </div>
        <p>${escapeHtml(provider.channel.description ?? "")}</p>
        <dl>
          <div><dt>Public browsing</dt><dd>${provider.capabilities.publicBrowse ? "Available" : "Unavailable"}</dd></div>
          <div><dt>Account connection</dt><dd>${provider.capabilities.authenticatedAccess ? "Supported" : "Not supported"}</dd></div>
          <div><dt>Integration</dt><dd>${escapeHtml(provider.integration)}</dd></div>
        </dl>
      </article>`,
    )
    .join("");
  const adminIpConfigured = Boolean(env.ADMIN_ALLOWED_IPS?.trim());

  return page(
    sourceName,
    `<header>
      <p class="eyebrow">Cloudflare Worker · Hot Tub API</p>
      <h1>${escapeHtml(sourceName)}</h1>
      <p class="lead">One source with six provider channels, public browsing, search, creator profiles where available, and normal Hot Tub playback extraction.</p>
      <div class="actions">
        <a class="primary" href="${escapeHtml(installUrl)}">Add to Hot Tub</a>
        <a href="/account">Source details</a>
      </div>
    </header>
    <section class="summary">
      <div><span>Source URL</span><code>${escapeHtml(baseUrl.toString().replace(/\/$/u, ""))}</code></div>
      <div><span>Browsable providers</span><strong>${providers.filter((provider) => provider.capabilities.publicBrowse).length} of ${providers.length}</strong></div>
      <div><span>Admin restriction</span><strong>${adminIpConfigured ? "VPN IP allowlist" : "Not configured"}</strong></div>
    </section>
    <section>
      <div class="section-heading">
        <p class="eyebrow">Provider status</p>
        <h2>Live capability reporting</h2>
      </div>
      <div class="grid">${cards}</div>
    </section>
    <footer>
      <a href="/health">Health</a>
      <span>Media is never proxied or permanently stored.</span>
    </footer>`,
  );
}

export function accountPage(
  env: Env,
  identity: AdminIdentity,
  connections: ConnectionSummary[],
  csrfToken: string,
): string {
  const providers = listProviders();
  const connectionRows =
    connections.length === 0
      ? `<p class="empty">There is nothing to connect here. Hot Tub's source API has no provider-login callback, and these providers do not publish a delegated account API that this Worker can use safely.</p>`
      : connections
          .map(
            (connection) => `<article class="card">
              <div class="card-heading">
                <h2>${escapeHtml(connection.providerId)}</h2>
                <span class="badge active">connected</span>
              </div>
              <dl>
                <div><dt>Token expiry</dt><dd>${escapeHtml(connection.tokenExpiresAt ?? "Not supplied")}</dd></div>
                <div><dt>Last sync</dt><dd>${escapeHtml(connection.lastSyncAt ?? "Never")}</dd></div>
                <div><dt>Last error</dt><dd>${escapeHtml(connection.lastError ?? "None")}</dd></div>
              </dl>
              <form method="post" action="/account/disconnect">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="providerId" value="${escapeHtml(connection.providerId)}">
                <button class="danger" type="submit">Disconnect</button>
              </form>
            </article>`,
          )
          .join("");
  const capabilityRows = providers
    .map(
      (provider) => `<tr>
        <th scope="row">${escapeHtml(provider.name)}</th>
        <td>${provider.capabilities.publicBrowse ? "Yes" : "No"}</td>
        <td>${provider.capabilities.publicSearch ? "Yes" : "No"}</td>
        <td>${provider.capabilities.uploaderBrowse ? "Yes" : "No"}</td>
        <td>${provider.capabilities.authenticatedAccess ? "Yes" : "No"}</td>
        <td>${escapeHtml(provider.status)}</td>
      </tr>`,
    )
    .join("");

  return page(
    "Source details",
    `<header class="compact">
      <a class="back" href="/">← Source home</a>
      <p class="eyebrow">Restricted to the approved VPN IP</p>
      <h1>Source control</h1>
      <p class="lead">Connected from approved address ${escapeHtml(identity.sourceIp)}. This page reports server-side connections; it is not required for Hot Tub favourites, history, or queues.</p>
    </header>
    <section>
      <div class="section-heading"><p class="eyebrow">Connections</p><h2>Provider account grants</h2></div>
      <div class="grid">${connectionRows}</div>
    </section>
    <section>
      <div class="section-heading"><p class="eyebrow">Capabilities</p><h2>What this source supplies</h2></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Provider</th><th>Browse</th><th>Search</th><th>Creators</th><th>Account</th><th>Status</th></tr></thead>
          <tbody>${capabilityRows}</tbody>
        </table>
      </div>
      <p class="note">Hot Tub itself keeps favourites, watch history, and queues locally on your iPhone. Once video browsing works, those app features work without configuring this page. The Worker's separate D1 library is not part of Hot Tub's source protocol and does not synchronise back to providers.</p>
    </section>
    <footer>
      <a href="/">Source home</a>
      <span>${escapeHtml(env.SOURCE_NAME?.trim() || DEFAULT_SOURCE_NAME)}</span>
    </footer>`,
  );
}

export const appCss = `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #090b10;
  color: #f5f7fb;
  --panel: #11151d;
  --line: #242b37;
  --muted: #98a2b3;
  --accent: #ff6b35;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 85% 0%, #242033 0, transparent 36rem), #090b10; }
main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 40px; }
header { padding: 72px 0 64px; max-width: 800px; }
header.compact { padding-top: 20px; }
h1 { font-size: clamp(2.7rem, 8vw, 5.8rem); letter-spacing: -0.065em; line-height: .92; margin: 12px 0 24px; }
h2 { letter-spacing: -.03em; margin: 0; }
p { color: var(--muted); line-height: 1.65; }
.lead { font-size: 1.15rem; max-width: 690px; }
.eyebrow { text-transform: uppercase; letter-spacing: .16em; color: var(--accent); font-size: .72rem; font-weight: 800; }
.actions { display: flex; gap: 12px; margin-top: 32px; flex-wrap: wrap; }
a, button { color: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; text-decoration: none; background: #141925; font: inherit; cursor: pointer; }
a:hover, button:hover { border-color: #596274; }
a.primary { background: var(--accent); border-color: var(--accent); color: #120a06; font-weight: 800; }
a.back { display: inline-block; margin-bottom: 32px; background: transparent; }
.summary { display: grid; grid-template-columns: 2fr 1fr 1fr; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; margin-bottom: 80px; }
.summary > div { padding: 20px; border-right: 1px solid var(--line); display: grid; gap: 8px; }
.summary > div:last-child { border: 0; }
.summary span, dt { color: var(--muted); font-size: .78rem; }
code { overflow-wrap: anywhere; color: #d7dfeb; }
.section-heading { margin: 0 0 24px; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.card { border: 1px solid var(--line); border-radius: 16px; padding: 22px; background: color-mix(in srgb, var(--panel) 92%, transparent); }
.card-heading { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
.badge { border-radius: 999px; padding: 5px 9px; font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 800; }
.badge.active { background: #153d2e; color: #70e1ae; }
.badge.degraded { background: #3e3217; color: #ffd97a; }
.badge.restricted { background: #42291e; color: #ffb38f; }
dl { display: grid; gap: 9px; margin: 20px 0 0; }
dl div { display: flex; justify-content: space-between; gap: 16px; padding-top: 9px; border-top: 1px solid var(--line); }
dd { margin: 0; text-align: right; }
section + section { margin-top: 72px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; }
table { width: 100%; border-collapse: collapse; min-width: 680px; }
th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--line); }
thead { background: #151a24; }
.note, .empty { border-left: 3px solid var(--accent); padding-left: 16px; }
form { margin-top: 20px; }
button.danger { border-color: #67322f; color: #ffaaa3; }
footer { margin-top: 80px; padding-top: 24px; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 16px; color: var(--muted); }
footer a { padding: 8px 10px; }
@media (max-width: 820px) {
  main { padding-top: 24px; }
  header { padding: 48px 0; }
  .summary, .grid { grid-template-columns: 1fr; }
  .summary > div { border-right: 0; border-bottom: 1px solid var(--line); }
  footer { align-items: flex-start; flex-direction: column; }
}
`;
