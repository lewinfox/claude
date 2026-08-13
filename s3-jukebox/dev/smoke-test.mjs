/**
 * Smoke test against a running instance. Exercises the paths that are awkward
 * to eyeball — the presigned redirect, range requests, zip structure, and the
 * auth boundary — and prints a pass/fail line for each.
 *
 *   npm run smoke                          # offline dev server, password "dev"
 *   BASE_URL=http://localhost:8080 PASSWORD=... npm run smoke
 *
 * Read-only: it never writes to the bucket or the index.
 */
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const PASSWORD = process.env.PASSWORD ?? "dev";

let cookie = "";
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function api(path, options = {}) {
  return fetch(`${BASE}${path}`, {
    ...options,
    redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
}

/** Reads the entry count out of a zip's end-of-central-directory record. */
function zipEntryCount(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.readUInt16LE(i + 10);
  }
  return -1;
}

console.log(`\nSmoke test against ${BASE}\n`);

/* --- auth ---------------------------------------------------------------- */

console.log("auth");
try {
  const anon = await api("/api/tracks");
  check("unauthenticated request is rejected", anon.status === 401, `got ${anon.status}`);
} catch (err) {
  console.log(`  FAIL  server unreachable — ${err.message}`);
  console.log(`\nIs it running? Try: npm run fake-s3  &&  npm run dev:offline\n`);
  process.exit(1);
}

const bad = await api("/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: `${PASSWORD}-wrong` }),
});
check("wrong password is rejected", bad.status === 401, `got ${bad.status}`);

const login = await api("/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
check("login succeeds", login.status === 200, `got ${login.status}`);
cookie = (login.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
if (login.status !== 200) {
  console.log(`\nWrong password? Pass it with PASSWORD=... npm run smoke\n`);
  process.exit(1);
}

/* --- library ------------------------------------------------------------- */

console.log("\nlibrary");
const stats = await (await api("/api/stats")).json();
check("library is indexed", stats.tracks > 0, `${stats.tracks} tracks, ${stats.artists} artists`);
if (stats.sync.running) console.log("  note  a sync is still running; counts will grow");

const listing = await (await api("/api/tracks?limit=5&sort=artist")).json();
check("tracks are listed", listing.tracks.length > 0, `${listing.total} total`);

const track = listing.tracks[0];
if (!track) {
  console.log("\nNo tracks indexed — nothing further to test.\n");
  process.exit(1);
}

const term = (track.artist ?? track.title ?? "").split(/\s+/)[0] ?? "";
if (term) {
  const found = await (await api(`/api/tracks?q=${encodeURIComponent(term)}`)).json();
  check("full-text search returns hits", found.total > 0, `"${term}" -> ${found.total}`);
}

const nonsense = await (await api("/api/tracks?q=%22zzz*%20AND%20(")).json();
check("hostile search input is handled", typeof nonsense.total === "number");

/* --- playback ------------------------------------------------------------ */

console.log("\nplayback");
const stream = await api(`/api/tracks/${track.id}/stream`);
const target = stream.headers.get("location") ?? "";
check("stream redirects to a presigned URL", stream.status === 302 && target.includes("X-Amz-Signature"));
check("redirect is not cached", (stream.headers.get("cache-control") ?? "").includes("no-store"));

if (target) {
  const ranged = await fetch(target, { headers: { range: "bytes=0-99" } });
  const body = await ranged.arrayBuffer();
  check(
    "S3 serves range requests (seeking works)",
    ranged.status === 206 && body.byteLength === 100,
    `${ranged.status}, ${body.byteLength} bytes`,
  );
}

const download = await api(`/api/tracks/${track.id}/download`);
check(
  "download forces a save dialog",
  (download.headers.get("location") ?? "").includes("response-content-disposition"),
);

const withCover = listing.tracks.find((t) => t.cover_hash);
if (withCover) {
  const cover = await api(`/api/tracks/${withCover.id}/cover`);
  check(
    "cover art is served",
    cover.status === 200 && (cover.headers.get("content-type") ?? "").startsWith("image/"),
  );
} else {
  console.log("  skip  no cover art in this sample");
}

/* --- downloads ----------------------------------------------------------- */

console.log("\ndownloads");
const ids = listing.tracks.slice(0, 2).map((t) => t.id);
const zip = await api("/api/zip", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ids: JSON.stringify(ids) }),
});
const buffer = Buffer.from(await zip.arrayBuffer());
check("zip responds", zip.status === 200, zip.headers.get("content-disposition") ?? "");
check("zip is well formed", buffer.subarray(0, 4).toString("hex") === "504b0304");
check("zip holds every selected track", zipEntryCount(buffer) === ids.length, `${zipEntryCount(buffer)} of ${ids.length}`);

const empty = await api("/api/zip", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ids: "[]" }),
});
check("empty selection is refused", empty.status === 400, `got ${empty.status}`);

/* --- session ------------------------------------------------------------- */

console.log("\nsession");
const forged = await fetch(`${BASE}/api/tracks`, {
  redirect: "manual",
  headers: { cookie: "jukebox_session=1786645807000.deadbeefdeadbeef" },
});
check("forged session cookie is rejected", forged.status === 401, `got ${forged.status}`);

const logout = await api("/api/logout", { method: "POST" });
const cleared = (logout.headers.getSetCookie() ?? []).some(
  (c) => c.startsWith("jukebox_session=;") && /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c),
);
check("logout clears the browser cookie", cleared);

// Sessions are stateless signed cookies: logout tells the browser to forget
// one, it does not revoke it server-side. A cookie captured before logout stays
// valid until SESSION_MAX_AGE_SECONDS. Asserted here so the behaviour is
// visible rather than assumed — rotate SESSION_SECRET to kill live sessions.
const replayed = await fetch(`${BASE}/api/tracks`, { redirect: "manual", headers: { cookie } });
check(
  "a captured cookie still works after logout (known, stateless sessions)",
  replayed.status === 200,
  `got ${replayed.status}`,
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
