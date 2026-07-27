import type { AdminIdentity } from "./auth/access";
import type { Env } from "./config";
import { DEFAULT_SOURCE_NAME } from "./config";
import { listProviders } from "./providers/registry";
import type { ConnectionSummary } from "./storage/connections";
import type {
  FollowedUploaderRow,
  LocalVideoRow,
  PlaylistItemRow,
  PlaylistRow,
} from "./storage/library";
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
        <a href="/library">Local library</a>
        <a href="/account">Source details</a>
      </div>
    </header>
    <section class="summary">
      <div><span>Source URL</span><code>${escapeHtml(baseUrl.toString().replace(/\/$/u, ""))}</code></div>
      <div><span>Browsable providers</span><strong>${providers.filter((provider) => provider.capabilities.publicBrowse).length} of ${providers.length}</strong></div>
      <div><span>Source access</span><strong>${adminIpConfigured ? "VPN IP only" : "Not configured"}</strong></div>
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

export interface LibraryPageData {
  history: LocalVideoRow[];
  favourites: LocalVideoRow[];
  playlists: PlaylistRow[];
  selectedPlaylist?: PlaylistRow;
  playlistItems: PlaylistItemRow[];
  followed: FollowedUploaderRow[];
  csrfToken: string;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const parts = hours > 0 ? [hours, minutes, remainder] : [minutes, remainder];
  return parts
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 16).replace("T", " ");
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function csrfInput(token: string): string {
  return hiddenField("csrf", token);
}

/** A one-button form; every mutation on this page is a plain POST. */
function actionForm(
  action: string,
  fields: Record<string, string>,
  label: string,
  csrfToken: string,
  danger = false,
): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => hiddenField(name, value))
    .join("");
  return `<form class="inline" method="post" action="${escapeHtml(action)}">
    ${csrfInput(csrfToken)}${inputs}
    <button class="${danger ? "danger" : "quiet"}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function videoRow(
  video: LocalVideoRow,
  csrfToken: string,
  removeAction: string,
  extraFields: Record<string, string> = {},
  trailing = "",
): string {
  // Inline `style` attributes are blocked by the page CSP (`style-src 'self'`),
  // so watch progress is reported as text rather than a styled bar.
  const meta = [
    video.provider_id,
    formatDuration(video.duration),
    formatDate(video.watched_at ?? video.created_at),
  ];
  if (video.progress_seconds && video.duration) {
    const percent = Math.min(100, Math.round((video.progress_seconds / video.duration) * 100));
    meta.push(`${percent}% watched`);
  }
  return `<li class="item">
    <div class="item-body">
      <a class="item-title" href="${escapeHtml(video.video_url)}" rel="noreferrer noopener">${escapeHtml(
        video.title,
      )}</a>
      <p class="item-meta">${meta.map((part) => escapeHtml(String(part))).join(" · ")}</p>
    </div>
    <div class="item-actions">
      ${trailing}
      ${actionForm(
        removeAction,
        { providerId: video.provider_id, videoId: video.video_id, ...extraFields },
        "Remove",
        csrfToken,
        true,
      )}
    </div>
  </li>`;
}

function emptyState(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function playlistPicker(data: LibraryPageData): string {
  if (data.playlists.length === 0) return "";
  return `<nav class="chips">${data.playlists
    .map(
      (playlist) =>
        `<a class="chip${playlist.id === data.selectedPlaylist?.id ? " current" : ""}" href="/library?playlist=${encodeURIComponent(
          playlist.id,
        )}">${escapeHtml(playlist.name)} <span>${playlist.item_count}</span></a>`,
    )
    .join("")}</nav>`;
}

function playlistDetail(data: LibraryPageData): string {
  const playlist = data.selectedPlaylist;
  if (!playlist) return emptyState("No playlists yet. Create one below.");
  const lastIndex = data.playlistItems.length - 1;
  const items = data.playlistItems
    .map((item, index) => {
      const move = (position: number, label: string) =>
        actionForm(
          "/api/local/playlists/items/move",
          {
            playlistId: playlist.id,
            providerId: item.provider_id,
            videoId: item.video_id,
            position: String(position),
          },
          label,
          data.csrfToken,
        );
      const controls = [
        index > 0 ? move(index - 1, "Up") : "",
        index < lastIndex ? move(index + 1, "Down") : "",
      ].join("");
      return videoRow(
        item,
        data.csrfToken,
        "/api/local/playlists/items/remove",
        { playlistId: playlist.id },
        controls,
      );
    })
    .join("");

  return `<div class="panel">
      <div class="panel-heading">
        <div>
          <h3>${escapeHtml(playlist.name)}</h3>
          <p>${escapeHtml(playlist.description ?? "No description")} · ${playlist.item_count} item${
            playlist.item_count === 1 ? "" : "s"
          } · updated ${escapeHtml(formatDate(playlist.updated_at))}</p>
        </div>
        ${actionForm(
          "/api/local/playlists/delete",
          { playlistId: playlist.id },
          "Delete playlist",
          data.csrfToken,
          true,
        )}
      </div>
      ${items ? `<ul class="items">${items}</ul>` : emptyState("This playlist is empty.")}
      <form class="stack" method="post" action="/api/local/playlists/update">
        ${csrfInput(data.csrfToken)}${hiddenField("playlistId", playlist.id)}
        <div class="field-row">
          <label>Rename<input name="name" maxlength="100" placeholder="${escapeHtml(
            playlist.name,
          )}"></label>
          <label>Description<input name="description" maxlength="500" placeholder="${escapeHtml(
            playlist.description ?? "",
          )}"></label>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>`;
}

export function libraryPage(env: Env, data: LibraryPageData): string {
  const history = data.history
    .map((video) => videoRow(video, data.csrfToken, "/api/local/history/remove"))
    .join("");
  const favourites = data.favourites
    .map((video) => videoRow(video, data.csrfToken, "/api/local/favourites/remove"))
    .join("");
  const followed = data.followed
    .map(
      (uploader) => `<li class="item">
        <div class="item-body">
          ${
            uploader.uploader_url
              ? `<a class="item-title" href="${escapeHtml(uploader.uploader_url)}" rel="noreferrer noopener">${escapeHtml(
                  uploader.uploader_name,
                )}</a>`
              : `<span class="item-title">${escapeHtml(uploader.uploader_name)}</span>`
          }
          <p class="item-meta">${escapeHtml(uploader.provider_id)} · followed ${escapeHtml(
            formatDate(uploader.followed_at),
          )}</p>
        </div>
        <div class="item-actions">
          ${actionForm(
            "/api/local/followed-uploaders/remove",
            { providerId: uploader.provider_id, uploaderId: uploader.uploader_id },
            "Unfollow",
            data.csrfToken,
            true,
          )}
        </div>
      </li>`,
    )
    .join("");

  return page(
    "Local library",
    `<header class="compact">
      <a class="back" href="/">← Source home</a>
      <p class="eyebrow">Restricted to the approved VPN IP</p>
      <h1>Local library</h1>
      <p class="lead">The Worker's own D1 history, favourites, playlists, and followed creators. Hot Tub keeps its own copies on the iPhone; nothing here is synchronised back to a provider.</p>
    </header>
    <section>
      <div class="section-heading">
        <p class="eyebrow">Playlists</p>
        <h2>${data.playlists.length} saved playlist${data.playlists.length === 1 ? "" : "s"}</h2>
      </div>
      ${playlistPicker(data)}
      ${playlistDetail(data)}
      <form class="stack" method="post" action="/api/local/playlists">
        ${csrfInput(data.csrfToken)}
        <div class="field-row">
          <label>New playlist<input name="name" maxlength="100" required placeholder="Watch later"></label>
          <label>Description<input name="description" maxlength="500" placeholder="Optional"></label>
          <button type="submit">Create</button>
        </div>
      </form>
    </section>
    <section>
      <div class="section-heading">
        <p class="eyebrow">Favourites</p>
        <h2>${data.favourites.length} saved video${data.favourites.length === 1 ? "" : "s"}</h2>
      </div>
      ${favourites ? `<ul class="items">${favourites}</ul>` : emptyState("No favourites saved yet.")}
    </section>
    <section>
      <div class="section-heading">
        <p class="eyebrow">Followed creators</p>
        <h2>${data.followed.length} creator${data.followed.length === 1 ? "" : "s"}</h2>
      </div>
      ${followed ? `<ul class="items">${followed}</ul>` : emptyState("No creators followed yet.")}
    </section>
    <section>
      <div class="section-heading">
        <p class="eyebrow">History</p>
        <h2>${data.history.length} recent item${data.history.length === 1 ? "" : "s"}</h2>
      </div>
      ${history ? `<ul class="items">${history}</ul>` : emptyState("No watch history recorded yet.")}
      ${
        data.history.length > 0
          ? `<div class="stack">${actionForm(
              "/api/local/history/clear",
              {},
              "Clear all history",
              data.csrfToken,
              true,
            )}</div>`
          : ""
      }
    </section>
    <footer>
      <a href="/">Source home</a>
      <a href="/account">Source details</a>
      <span>${escapeHtml(env.SOURCE_NAME?.trim() || DEFAULT_SOURCE_NAME)}</span>
    </footer>`,
  );
}

export interface AccountPageOptions {
  note?: string;
  encryptionConfigured: boolean;
}

/** Providers where the operator can supply their own signed-in session. */
function connectableProviders() {
  return listProviders().filter((provider) => Boolean(provider.connectSession));
}

function connectSection(csrfToken: string, options: AccountPageOptions): string {
  const providers = connectableProviders();
  if (providers.length === 0) return "";
  if (!options.encryptionConfigured) {
    return `<div class="panel">
      <h3>Connect an account</h3>
      <p class="note">Set the <code>TOKEN_ENCRYPTION_KEYS</code> secret before connecting a provider account. Sessions are stored encrypted, so the key ring has to exist first. See <a href="/">Deployment</a> notes.</p>
    </div>`;
  }
  return providers
    .map(
      (provider) => `<div class="panel">
        <h3>Connect ${escapeHtml(provider.name)}</h3>
        <p>${escapeHtml(provider.name)} publishes no OAuth or delegated-access API. Sign in on your own browser, copy the <code>Cookie</code> header from a request to the site, and paste it below. This Worker never receives your password and never submits the login form.</p>
        <form class="stack" method="post" action="/account/connect">
          ${csrfInput(csrfToken)}${hiddenField("providerId", provider.id)}
          <div class="field-row">
            <label>Session cookie<input name="sessionCookie" maxlength="8000" required placeholder="name=value; other=value"></label>
            <button type="submit">Connect</button>
          </div>
        </form>
        <form class="stack" method="post" action="/account/diagnose">
          ${csrfInput(csrfToken)}${hiddenField("providerId", provider.id)}
          <div class="field-row">
            <label>Diagnose playback for a watch URL<input name="watchUrl" maxlength="2000" required placeholder="https://faphouse.com/videos/..."></label>
            <button type="submit">Run diagnostic</button>
          </div>
        </form>
        <p class="note">Connecting does not enable protected playback on its own. The anonymous watch page carries no playable source, so the diagnostic is how we learn what an entitled session actually returns.</p>
      </div>`,
    )
    .join("");
}

export function accountPage(
  env: Env,
  identity: AdminIdentity,
  connections: ConnectionSummary[],
  csrfToken: string,
  options: AccountPageOptions = { encryptionConfigured: false },
): string {
  const providers = listProviders();
  const connectionRows =
    connections.length === 0
      ? `<p class="empty">No provider account is connected.</p>`
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
    ${options.note ? `<p class="note">${escapeHtml(options.note)}</p>` : ""}
    <section>
      <div class="section-heading"><p class="eyebrow">Connections</p><h2>Provider account grants</h2></div>
      <div class="grid">${connectionRows}</div>
      ${connectSection(csrfToken, options)}
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
      <a href="/library">Local library</a>
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
button.quiet { background: transparent; padding: 8px 12px; font-size: .82rem; }
form.inline { display: inline-block; margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.chip { padding: 8px 12px; font-size: .85rem; }
.chip.current { border-color: var(--accent); color: var(--accent); }
.chip span { color: var(--muted); margin-left: 6px; }
.panel { border: 1px solid var(--line); border-radius: 16px; padding: 22px; background: color-mix(in srgb, var(--panel) 92%, transparent); }
.panel-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; flex-wrap: wrap; }
.panel-heading p { margin: 6px 0 0; font-size: .85rem; }
.items { list-style: none; margin: 20px 0 0; padding: 0; display: grid; gap: 2px; }
.item { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.item-body { min-width: 0; flex: 1 1 320px; }
.item-title { display: inline-block; padding: 0; background: none; border: 0; border-radius: 0; overflow-wrap: anywhere; font-weight: 600; }
.item-title:hover { color: var(--accent); }
.item-meta { margin: 4px 0 0; font-size: .78rem; }
.item-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.stack { display: block; margin-top: 24px; }
.field-row { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
.field-row label { display: grid; gap: 6px; font-size: .78rem; color: var(--muted); flex: 1 1 220px; }
.field-row input { padding: 11px 13px; border-radius: 10px; border: 1px solid var(--line); background: #141925; color: #fff; font: inherit; }
.field-row input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
