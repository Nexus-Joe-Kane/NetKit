/**
 * Channel IDs the playability check sweeps by default. Generated from the
 * registry rather than hand-maintained, so a channel added tomorrow is checked
 * without anyone remembering to list it here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "providers", "community.ts"), "utf8");
const community = [...source.matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gm)].map((match) => match[1]);

export default ["xhamster", "xvideos", "pornhub", "eporner", ...community];
