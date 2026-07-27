/**
 * Checks that channels return watch pages Hot Tub can actually extract.
 *
 * The integration suite proves a channel *lists*. It does not prove anything
 * *plays*, and those are different failures: forty-nine channels once shipped
 * having been verified only for listing, and roughly a fifth of them turned out
 * to have no extractor at all, which reaches the operator as "video
 * unavailable" rather than as a broken channel.
 *
 * Hot Tub extracts playback from `Video.url` itself, and its `formats[]` schema
 * is yt-dlp's format dict field for field, so yt-dlp is used here as the
 * closest available stand-in for the app's extractor.
 *
 * Usage: node scripts/check-playability.mjs [channel ...]
 *
 * Exit code is non-zero only when a channel has *no extractor at all*, which is
 * a property of the site and cannot be caused by where this runs. Network-shaped
 * failures — 403, 410, anti-bot interstitials — are reported but never fail the
 * run: a datacentre address gets served differently from a phone on a VPN, and
 * treating that as a broken channel would condemn working ones. Pornhub, a
 * featured channel, fails exactly that way from GitHub's runners.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const UPSTREAM = "https://hottub.spacemoehre.de/api/videos";
const SAMPLES_PER_CHANNEL = 3;
const CONCURRENCY = 4;

/** yt-dlp has no extractor registered for this hostname at all. */
const NO_EXTRACTOR = /Unsupported URL/i;

async function sampleUrls(channel) {
  try {
    const response = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, page: 1, pageSize: SAMPLES_PER_CHANNEL }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    return (body.items ?? []).map((item) => item.url).filter(Boolean);
  } catch {
    return [];
  }
}

async function extractable(url) {
  try {
    const { stdout } = await run(
      "yt-dlp",
      [
        "--simulate",
        "--no-warnings",
        "--quiet",
        "--print",
        "%(extractor)s",
        "--socket-timeout",
        "20",
        "--retries",
        "1",
        url,
      ],
      { timeout: 90_000 },
    );
    return { ok: Boolean(stdout.trim()), extractor: stdout.trim().split("\n")[0] ?? "" };
  } catch (error) {
    const stderr = String(error.stderr ?? error.message ?? "");
    return { ok: false, reason: stderr.trim().split("\n").at(-1)?.slice(0, 120) ?? "unknown" };
  }
}

async function checkChannel(channel) {
  const urls = await sampleUrls(channel);
  if (urls.length === 0) return { channel, verdict: "no-samples" };

  const results = [];
  for (const url of urls) results.push(await extractable(url));
  const playable = results.filter((result) => result.ok);
  if (playable.length > 0) {
    return { channel, verdict: "playable", detail: playable[0].extractor };
  }
  // Only a missing extractor is a property of the site rather than of this
  // machine's address, so only that is treated as a hard failure.
  const missing = results.every((result) => NO_EXTRACTOR.test(result.reason ?? ""));
  return {
    channel,
    verdict: missing ? "no-extractor" : "unverified",
    detail: results[0]?.reason ?? "",
  };
}

async function main() {
  const requested = process.argv.slice(2);
  const channels = requested.length > 0 ? requested : (await import("./channel-ids.mjs")).default;

  const results = [];
  for (let index = 0; index < channels.length; index += CONCURRENCY) {
    results.push(
      ...(await Promise.all(channels.slice(index, index + CONCURRENCY).map(checkChannel))),
    );
  }

  const broken = results.filter((result) => result.verdict === "no-extractor");
  const unverified = results.filter((result) => result.verdict === "unverified");
  const playable = results.filter((result) => result.verdict === "playable");

  for (const result of results) {
    console.log(`${result.verdict.padEnd(13)} ${result.channel.padEnd(16)} ${result.detail ?? ""}`);
  }
  console.log(
    `\n${playable.length} playable, ${unverified.length} unverified from this address, ${broken.length} with no extractor`,
  );

  if (unverified.length > 0) {
    console.log(
      "\nUnverified means the site refused this runner, not that the channel is broken.\n" +
        "Pornhub fails this way from GitHub's network while working fine on a phone.",
    );
  }
  if (broken.length > 0) {
    console.log(`\nNo extractor exists for: ${broken.map((r) => r.channel).join(", ")}`);
    console.log("Those channels can never play in Hot Tub and should be removed.");
    process.exitCode = 1;
  }
}

await main();
