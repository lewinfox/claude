import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

export interface TrackRow {
  id: number;
  key: string;
  size: number;
  etag: string;
  last_modified: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: number | null;
  track_no: number | null;
  disc_no: number | null;
  duration: number | null;
  bitrate: number | null;
  cover_hash: string | null;
  indexed_at: string;
}

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  etag          TEXT NOT NULL,
  last_modified TEXT,
  title         TEXT,
  artist        TEXT,
  album         TEXT,
  album_artist  TEXT,
  genre         TEXT,
  year          INTEGER,
  track_no      INTEGER,
  disc_no       INTEGER,
  duration      REAL,
  bitrate       INTEGER,
  cover_hash    TEXT,
  indexed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tracks_sort ON tracks (artist, album, disc_no, track_no, title);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks (album);

CREATE TABLE IF NOT EXISTS covers (
  hash TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, artist, album, album_artist, genre, key,
  content='tracks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre, key)
  VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre, new.key);
END;

CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre, key)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre, old.key);
END;

CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre, key)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre, old.key);
  INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre, key)
  VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre, new.key);
END;
`);

export function getMeta(key: string): string | null {
  const row = db.prepare<[string], { value: string | null }>(
    "SELECT value FROM meta WHERE key = ?",
  ).get(key);
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Turns free text into an FTS5 MATCH expression. Every term is quoted (so
 * punctuation can't be read as query syntax) and given a prefix wildcard, and
 * terms are ANDed together.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/"/g, '""'));
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" AND ");
}
