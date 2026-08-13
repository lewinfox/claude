import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { clearSession, isAuthenticated, issueSession, passwordMatches } from "./auth.js";
import { config } from "./config.js";
import { getMeta } from "./db.js";
import { getSyncStatus, sync } from "./indexer.js";
import {
  allMatching,
  getCover,
  getTrack,
  getTracks,
  search,
  stats,
  type SortKey,
} from "./library.js";
import { presign } from "./s3.js";
import { streamZip } from "./zip.js";

const MAX_ZIP_ENTRIES = 10_000;
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // "Zip these ids" posts a list that can get long.
  bodyLimit: 4 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(formbody);
await app.register(fastifyStatic, { root: PUBLIC_DIR });

const OPEN_ROUTES = new Set(["/api/login", "/api/me"]);

app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
  const path = request.url.split("?")[0] ?? "";
  if (!path.startsWith("/api/") || OPEN_ROUTES.has(path)) return;
  if (isAuthenticated(request)) return;
  await reply.code(401).send({ error: "unauthorized" });
});

app.get("/api/me", async (request) => ({ authenticated: isAuthenticated(request) }));

app.post("/api/login", async (request, reply) => {
  const body = (request.body ?? {}) as { password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";

  if (!passwordMatches(password)) {
    // Blunt throttle against guessing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return reply.code(401).send({ error: "invalid password" });
  }

  issueSession(reply);
  return { authenticated: true };
});

app.post("/api/logout", async (_request, reply) => {
  clearSession(reply);
  return { authenticated: false };
});

app.get("/api/stats", async () => ({
  ...stats(),
  lastSyncAt: getMeta("last_sync_at"),
  sync: getSyncStatus(),
}));

app.get("/api/tracks", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  return search({
    q: query.q,
    sort: (query.sort as SortKey) || "relevance",
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    offset: query.offset ? Number.parseInt(query.offset, 10) : undefined,
  });
});

/**
 * Playback and download both bounce the browser to a presigned S3 URL, so the
 * audio bytes never transit this process and S3 serves range requests (and
 * therefore seeking) natively.
 */
async function redirectToObject(
  request: FastifyRequest,
  reply: FastifyReply,
  asAttachment: boolean,
) {
  const { id } = request.params as { id: string };
  const track = getTrack(Number.parseInt(id, 10));
  if (!track) return reply.code(404).send({ error: "not found" });

  const filename = track.key.split("/").pop() || "track.mp3";
  const url = await presign(track.key, asAttachment ? filename : undefined);

  // Never cache the redirect: the signed URL behind it expires.
  return reply.header("Cache-Control", "no-store").redirect(url, 302);
}

app.get("/api/tracks/:id/stream", (request, reply) => redirectToObject(request, reply, false));
app.get("/api/tracks/:id/download", (request, reply) => redirectToObject(request, reply, true));

app.get("/api/tracks/:id/cover", async (request, reply) => {
  const { id } = request.params as { id: string };
  const track = getTrack(Number.parseInt(id, 10));
  if (!track?.cover_hash) return reply.code(404).send({ error: "no cover" });

  const cover = getCover(track.cover_hash);
  if (!cover) return reply.code(404).send({ error: "no cover" });

  return reply
    .header("Content-Type", cover.mime)
    // Covers are addressed by content hash, so they can be cached hard.
    .header("Cache-Control", "private, max-age=604800, immutable")
    .send(cover.data);
});

app.post("/api/zip", async (request, reply) => {
  const body = (request.body ?? {}) as { ids?: unknown; all?: unknown; q?: unknown };

  const wantsAll = body.all === true || body.all === "1" || body.all === "true";
  const query = typeof body.q === "string" ? body.q : undefined;

  const tracks = wantsAll
    ? allMatching(query, MAX_ZIP_ENTRIES)
    : getTracks(parseIds(body.ids).slice(0, MAX_ZIP_ENTRIES));

  if (tracks.length === 0) return reply.code(400).send({ error: "no tracks selected" });

  const filename = zipFilename(wantsAll ? query : undefined, tracks.length);
  request.log.info(`Zipping ${tracks.length} tracks as ${filename}`);

  // Take over the socket so archiver can stream directly to it.
  reply.hijack();
  try {
    await streamZip(reply.raw, tracks, filename);
  } catch (err) {
    request.log.error(err);
    if (!reply.raw.headersSent) reply.raw.writeHead(500);
    reply.raw.end();
  }
});

app.post("/api/reindex", async (request) => {
  if (getSyncStatus().running) return { started: false, ...getSyncStatus() };
  // Deliberately not awaited — the UI polls /api/stats for progress.
  void sync(request.log);
  return { started: true, ...getSyncStatus() };
});

function parseIds(raw: unknown): number[] {
  let values: unknown[] = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    // Form posts send a single field; accept JSON or a comma-separated list.
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      values = raw.split(",");
    }
  }
  return values
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function zipFilename(query: string | undefined, count: number): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = query
    ? `-${query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`
    : "";
  return `jukebox${slug}-${count}-tracks-${stamp}.zip`;
}

const start = async () => {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Serving bucket s3://${config.bucket}/${config.prefix}`);

  if (config.syncOnStart) void sync(app.log);

  if (config.syncIntervalMinutes > 0) {
    setInterval(() => void sync(app.log), config.syncIntervalMinutes * 60_000).unref();
  }
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
