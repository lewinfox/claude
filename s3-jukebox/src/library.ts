import { db, toFtsQuery, type TrackRow } from "./db.js";

export type SortKey = "relevance" | "artist" | "title" | "album" | "recent" | "duration";

const SORT_SQL: Record<Exclude<SortKey, "relevance">, string> = {
  artist: "tracks.artist COLLATE NOCASE, tracks.album COLLATE NOCASE, tracks.disc_no, tracks.track_no, tracks.title COLLATE NOCASE",
  title: "tracks.title COLLATE NOCASE",
  album: "tracks.album COLLATE NOCASE, tracks.disc_no, tracks.track_no",
  recent: "tracks.last_modified DESC",
  duration: "tracks.duration DESC",
};

export interface SearchOptions {
  q?: string;
  sort?: SortKey;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  tracks: TrackRow[];
}

function orderBy(sort: SortKey, searching: boolean): string {
  if (sort === "relevance") {
    return searching ? "bm25(tracks_fts)" : SORT_SQL.artist;
  }
  return SORT_SQL[sort];
}

export function search(options: SearchOptions = {}): SearchResult {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const sort = options.sort ?? "relevance";
  const match = options.q ? toFtsQuery(options.q) : null;

  if (match) {
    const total = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM tracks_fts WHERE tracks_fts MATCH ?",
      )
      .get(match)!.n;

    const tracks = db
      .prepare<[string, number, number], TrackRow>(
        `SELECT tracks.* FROM tracks_fts
         JOIN tracks ON tracks.id = tracks_fts.rowid
         WHERE tracks_fts MATCH ?
         ORDER BY ${orderBy(sort, true)}
         LIMIT ? OFFSET ?`,
      )
      .all(match, limit, offset);

    return { total, tracks };
  }

  const total = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM tracks").get()!.n;
  const tracks = db
    .prepare<[number, number], TrackRow>(
      `SELECT * FROM tracks ORDER BY ${orderBy(sort, false)} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);

  return { total, tracks };
}

/** Every track matching a query, ignoring pagination — used for "zip all results". */
export function allMatching(q: string | undefined, cap: number): TrackRow[] {
  const match = q ? toFtsQuery(q) : null;
  if (match) {
    return db
      .prepare<[string, number], TrackRow>(
        `SELECT tracks.* FROM tracks_fts
         JOIN tracks ON tracks.id = tracks_fts.rowid
         WHERE tracks_fts MATCH ?
         ORDER BY ${SORT_SQL.artist}
         LIMIT ?`,
      )
      .all(match, cap);
  }
  return db
    .prepare<[number], TrackRow>(
      `SELECT * FROM tracks ORDER BY ${SORT_SQL.artist} LIMIT ?`,
    )
    .all(cap);
}

export function getTrack(id: number): TrackRow | undefined {
  return db.prepare<[number], TrackRow>("SELECT * FROM tracks WHERE id = ?").get(id);
}

/** Preserves the order the caller asked for, so zip contents match the UI. */
export function getTracks(ids: number[]): TrackRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare<number[], TrackRow>(`SELECT * FROM tracks WHERE id IN (${placeholders})`)
    .all(...ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is TrackRow => Boolean(row));
}

export function getCover(hash: string): { mime: string; data: Buffer } | undefined {
  return db
    .prepare<[string], { mime: string; data: Buffer }>(
      "SELECT mime, data FROM covers WHERE hash = ?",
    )
    .get(hash);
}

export function stats(): { tracks: number; totalBytes: number; totalDuration: number; artists: number; albums: number } {
  const row = db
    .prepare<[], { tracks: number; totalBytes: number | null; totalDuration: number | null }>(
      "SELECT COUNT(*) AS tracks, SUM(size) AS totalBytes, SUM(duration) AS totalDuration FROM tracks",
    )
    .get()!;
  const artists = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(DISTINCT COALESCE(album_artist, artist)) AS n FROM tracks WHERE COALESCE(album_artist, artist) IS NOT NULL",
    )
    .get()!.n;
  const albums = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(DISTINCT album) AS n FROM tracks WHERE album IS NOT NULL",
    )
    .get()!.n;

  return {
    tracks: row.tracks,
    totalBytes: row.totalBytes ?? 0,
    totalDuration: row.totalDuration ?? 0,
    artists,
    albums,
  };
}
