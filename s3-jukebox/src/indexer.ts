import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { parseBuffer } from "music-metadata";
import { config } from "./config.js";
import { db, setMeta, type TrackRow } from "./db.js";
import { listAudioObjects, readHead, type ListedObject } from "./s3.js";

export interface SyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  scanned: number;
  indexed: number;
  removed: number;
  failed: number;
  error: string | null;
}

const status: SyncStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  scanned: 0,
  indexed: 0,
  removed: 0,
  failed: 0,
  error: null,
};

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

interface Tags {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  duration: number | null;
  bitrate: number | null;
  cover: { hash: string; mime: string; data: Buffer } | null;
}

function emptyTags(key: string): Tags {
  return {
    title: basename(key, extname(key)),
    artist: null,
    album: null,
    albumArtist: null,
    genre: null,
    year: null,
    trackNo: null,
    discNo: null,
    duration: null,
    bitrate: null,
    cover: null,
  };
}

/**
 * Parses ID3 data out of a partial file. The buffer is only the head of the
 * object, so a full-duration scan will hit an unexpected EOF — we ask for
 * duration first and fall back to a tags-only parse if that upsets the parser.
 */
async function readTags(key: string, totalSize: number): Promise<Tags> {
  const head = await readHead(key, Math.min(config.tagReadBytes, totalSize));
  const fileInfo = { mimeType: "audio/mpeg", size: totalSize };

  let metadata;
  try {
    metadata = await parseBuffer(head, fileInfo, { duration: true });
  } catch {
    try {
      metadata = await parseBuffer(head, fileInfo, { duration: false });
    } catch {
      return emptyTags(key);
    }
  }

  const { common, format } = metadata;
  const picture = common.picture?.[0];
  let cover: Tags["cover"] = null;
  if (picture && picture.data.length > 0 && picture.data.length <= config.maxCoverBytes) {
    const data = Buffer.from(picture.data);
    cover = {
      hash: createHash("sha256").update(data).digest("hex"),
      mime: picture.format || "image/jpeg",
      data,
    };
  }

  return {
    title: common.title?.trim() || basename(key, extname(key)),
    artist: common.artist?.trim() || null,
    album: common.album?.trim() || null,
    albumArtist: common.albumartist?.trim() || null,
    genre: common.genre?.join(", ") || null,
    year: common.year ?? null,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    duration: format.duration ?? null,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    cover,
  };
}

const selectExisting = db.prepare<[string], Pick<TrackRow, "id" | "etag" | "size">>(
  "SELECT id, etag, size FROM tracks WHERE key = ?",
);

const upsertTrack = db.prepare(`
INSERT INTO tracks (
  key, size, etag, last_modified, title, artist, album, album_artist,
  genre, year, track_no, disc_no, duration, bitrate, cover_hash, indexed_at
) VALUES (
  @key, @size, @etag, @last_modified, @title, @artist, @album, @album_artist,
  @genre, @year, @track_no, @disc_no, @duration, @bitrate, @cover_hash, @indexed_at
)
ON CONFLICT(key) DO UPDATE SET
  size = excluded.size,
  etag = excluded.etag,
  last_modified = excluded.last_modified,
  title = excluded.title,
  artist = excluded.artist,
  album = excluded.album,
  album_artist = excluded.album_artist,
  genre = excluded.genre,
  year = excluded.year,
  track_no = excluded.track_no,
  disc_no = excluded.disc_no,
  duration = excluded.duration,
  bitrate = excluded.bitrate,
  cover_hash = excluded.cover_hash,
  indexed_at = excluded.indexed_at
`);

const insertCover = db.prepare(
  "INSERT INTO covers (hash, mime, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING",
);

function persist(object: ListedObject, tags: Tags): void {
  if (tags.cover) {
    // Deduplicated by content hash, so an album's tracks share one blob.
    insertCover.run(tags.cover.hash, tags.cover.mime, tags.cover.data);
  }
  upsertTrack.run({
    key: object.key,
    size: object.size,
    etag: object.etag,
    last_modified: object.lastModified,
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    album_artist: tags.albumArtist,
    genre: tags.genre,
    year: tags.year,
    track_no: tags.trackNo,
    disc_no: tags.discNo,
    duration: tags.duration,
    bitrate: tags.bitrate,
    cover_hash: tags.cover?.hash ?? null,
    indexed_at: new Date().toISOString(),
  });
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Reconciles SQLite with the bucket. Objects whose ETag and size are unchanged
 * are left alone, so re-runs only pay for genuinely new or modified files.
 */
export async function sync(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<SyncStatus> {
  if (status.running) return getSyncStatus();

  Object.assign(status, {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    scanned: 0,
    indexed: 0,
    removed: 0,
    failed: 0,
    error: null,
  });

  const seen = new Set<string>();

  try {
    for await (const page of listAudioObjects()) {
      const stale: ListedObject[] = [];

      for (const object of page) {
        seen.add(object.key);
        status.scanned++;
        const existing = selectExisting.get(object.key);
        if (!existing || existing.etag !== object.etag || existing.size !== object.size) {
          stale.push(object);
        }
      }

      await mapLimit(stale, config.indexConcurrency, async (object) => {
        try {
          const tags = await readTags(object.key, object.size);
          persist(object, tags);
          status.indexed++;
        } catch (err) {
          status.failed++;
          log.warn(`Failed to index ${object.key}: ${(err as Error).message}`);
        }
      });
    }

    // Anything in the DB the bucket no longer has.
    const knownKeys = db
      .prepare<[], { key: string }>("SELECT key FROM tracks")
      .all()
      .map((row) => row.key);
    const gone = knownKeys.filter((key) => !seen.has(key));
    if (gone.length > 0) {
      const remove = db.prepare("DELETE FROM tracks WHERE key = ?");
      const removeAll = db.transaction((keys: string[]) => {
        for (const key of keys) remove.run(key);
      });
      removeAll(gone);
      status.removed = gone.length;
    }

    // Drop cover blobs no track references any more.
    db.exec("DELETE FROM covers WHERE hash NOT IN (SELECT cover_hash FROM tracks WHERE cover_hash IS NOT NULL)");

    setMeta("last_sync_at", new Date().toISOString());
    log.info(
      `Sync complete: ${status.scanned} scanned, ${status.indexed} indexed, ${status.removed} removed, ${status.failed} failed`,
    );
  } catch (err) {
    status.error = (err as Error).message;
    log.warn(`Sync failed: ${status.error}`);
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }

  return getSyncStatus();
}
