import { extname } from "node:path";
import type { ServerResponse } from "node:http";
import archiver from "archiver";
import type { TrackRow } from "./db.js";
import { lazyObjectStream } from "./s3.js";

/** Zip64 kicks in past these; well below the format's hard limits. */
const ZIP64_BYTES = 3.5 * 1024 ** 3;
const ZIP64_ENTRIES = 60_000;

function safeSegment(value: string): string {
  return value
    .replace(/[/\\]/g, "-")
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Unknown";
}

/** Rebuilds a tidy Artist/Album/NN Title.mp3 path from the tags we indexed. */
function entryName(track: TrackRow): string {
  const ext = extname(track.key) || ".mp3";
  const artist = track.album_artist ?? track.artist;
  const title = track.title ?? track.key.split("/").pop() ?? "track";

  if (!artist && !track.album) {
    // No usable tags — keep the bucket layout instead of inventing one.
    return track.key.split("/").map(safeSegment).join("/");
  }

  const number = track.track_no ? `${String(track.track_no).padStart(2, "0")} ` : "";
  const parts = [safeSegment(artist ?? "Unknown Artist")];
  if (track.album) parts.push(safeSegment(track.album));
  parts.push(`${number}${safeSegment(title)}${ext}`);
  return parts.join("/");
}

function dedupe(names: Set<string>, name: string): string {
  if (!names.has(name)) {
    names.add(name);
    return name;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!names.has(candidate)) {
      names.add(candidate);
      return candidate;
    }
  }
}

/**
 * Streams a zip of the given tracks straight to the response. Entries are
 * stored uncompressed (MP3s don't shrink) and each S3 read only begins when
 * the archiver reaches that entry, so memory stays flat regardless of size.
 */
export async function streamZip(
  response: ServerResponse,
  tracks: TrackRow[],
  filename: string,
): Promise<void> {
  const totalBytes = tracks.reduce((sum, track) => sum + track.size, 0);
  const archive = archiver("zip", {
    store: true,
    forceZip64: totalBytes > ZIP64_BYTES || tracks.length > ZIP64_ENTRIES,
  });

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });

  archive.on("error", (err) => response.destroy(err));
  // If the client cancels the download, stop pulling from S3.
  response.on("close", () => {
    if (!response.writableEnded) archive.abort();
  });

  archive.pipe(response);

  const names = new Set<string>();
  for (const track of tracks) {
    const modified = track.last_modified ? new Date(track.last_modified) : null;
    archive.append(lazyObjectStream(track.key), {
      name: dedupe(names, entryName(track)),
      // Zip timestamps can't predate 1980.
      ...(modified && modified.getFullYear() >= 1980 ? { date: modified } : {}),
    });
  }

  await archive.finalize();
}
