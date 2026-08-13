import { randomBytes } from "node:crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString("hex");
  console.warn(
    "SESSION_SECRET is not set — generated a random one. Logins will be invalidated on every restart.",
  );
}

export const config = {
  port: int("PORT", 8080),
  host: process.env.HOST ?? "0.0.0.0",

  password: required("APP_PASSWORD"),
  sessionSecret,
  sessionMaxAgeSeconds: int("SESSION_MAX_AGE_SECONDS", 60 * 60 * 24 * 30),

  bucket: required("S3_BUCKET"),
  prefix: process.env.S3_PREFIX ?? "",
  region: process.env.AWS_REGION ?? "us-east-1",
  /** Set for S3-compatible services (MinIO, Cloudflare R2, Backblaze B2). */
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: bool("S3_FORCE_PATH_STYLE", false),

  dbPath: process.env.DB_PATH ?? "/data/jukebox.db",

  /** How long generated playback/download links stay valid. */
  presignExpirySeconds: int("PRESIGN_EXPIRY_SECONDS", 60 * 60),
  /** Bytes read from the head of each object to parse ID3 tags. */
  tagReadBytes: int("TAG_READ_BYTES", 256 * 1024),
  indexConcurrency: int("INDEX_CONCURRENCY", 8),
  /** Set to 0 to disable periodic re-indexing. */
  syncIntervalMinutes: int("SYNC_INTERVAL_MINUTES", 60),
  syncOnStart: bool("SYNC_ON_START", true),

  /** Cover art larger than this is skipped rather than stored in SQLite. */
  maxCoverBytes: int("MAX_COVER_BYTES", 512 * 1024),

  extensions: (process.env.AUDIO_EXTENSIONS ?? ".mp3")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};

export type Config = typeof config;
