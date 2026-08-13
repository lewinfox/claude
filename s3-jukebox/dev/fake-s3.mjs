/**
 * A tiny S3-compatible server for local UI work — no AWS account, no
 * credentials, no real bucket. It serves synthetic MP3s built in memory with
 * genuine ID3v2.3 tags and valid MPEG frames, so the indexer, the tag parser
 * and the browser's audio element all behave as they would against real S3.
 *
 * Signatures are not checked. This is a development fixture; never expose it.
 *
 *   node dev/fake-s3.mjs [port]     (default 9099)
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 9099);
// Matches the real layout, so only S3_ENDPOINT differs from production config.
const BUCKET = process.env.FAKE_S3_BUCKET ?? "lewinfox-music";
const PREFIX = process.env.FAKE_S3_PREFIX ?? "library/";

/* ---------- synthetic MP3s ---------- */

const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function textFrame(id, text) {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "latin1")]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function apicFrame(image) {
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from("image/png", "latin1"),
    Buffer.from([0x00, 0x03]), // terminator, picture type 3 (front cover)
    Buffer.from([0x00]), // empty description
    image,
  ]);
  const header = Buffer.alloc(10);
  header.write("APIC", 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function synchsafe(size) {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function id3Tag(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([0x03, 0x00, 0x00]),
    synchsafe(body.length),
    body,
  ]);
}

// MPEG-1 Layer III, 128kbps, 44.1kHz => 417-byte frames, ~26ms each.
function mpegFrames(count) {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

function makeMp3({ title, artist, album, track, year, seconds = 15, cover = true }) {
  const frames = [
    textFrame("TIT2", title),
    textFrame("TPE1", artist),
    textFrame("TALB", album),
    textFrame("TRCK", String(track)),
    textFrame("TYER", String(year)),
    textFrame("TCON", "Electronic"),
  ];
  if (cover) frames.push(apicFrame(COVER_PNG));
  return Buffer.concat([id3Tag(frames), mpegFrames(Math.round(seconds / 0.026122))]);
}

const ALBUMS = [
  {
    artist: "Aphex Twin",
    album: "Selected Ambient Works",
    year: 1992,
    dir: "aphex-twin/selected-ambient",
    tracks: ["Xtal", "Tha", "Pulsewidth", "Ageispolis", "Green Calx"],
  },
  {
    artist: "Boards of Canada",
    album: "Music Has the Right to Children",
    year: 1998,
    dir: "boards-of-canada/music-has-the-right",
    tracks: ["Wildlife Analysis", "An Eagle in Your Mind", "Telephasic Workshop", "Roygbiv"],
  },
  {
    artist: "Burial",
    album: "Untrue",
    year: 2007,
    dir: "burial/untrue",
    tracks: ["Archangel", "Near Dark", "Ghost Hardware", "Etched Headplate"],
  },
];

const objects = new Map();
for (const { artist, album, year, dir, tracks } of ALBUMS) {
  tracks.forEach((title, index) => {
    const n = String(index + 1).padStart(2, "0");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    objects.set(
      `${PREFIX}${dir}/${n}-${slug}.mp3`,
      makeMp3({
        title,
        artist,
        album,
        track: index + 1,
        year,
        seconds: 12 + index * 3,
        // Leave one track art-less so the missing-cover path gets exercised.
        cover: !(artist === "Burial" && index === 3),
      }),
    );
  });
}
// An untagged file and a non-audio file, so both fallbacks get exercised.
objects.set(`${PREFIX}misc/unlabelled-recording.mp3`, Buffer.concat([mpegFrames(400)]));
objects.set(`${PREFIX}misc/notes.txt`, Buffer.from("not audio"));

const LAST_MODIFIED = new Date("2026-01-15T10:00:00Z");

/* ---------- HTTP ---------- */

const xmlEscape = (value) =>
  value.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
  );

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");

  // ListObjectsV2 — the SDK sends the bucket with a trailing slash.
  if ((path === BUCKET || path === `${BUCKET}/`) && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const contents = [...objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(
        ([key, body]) =>
          `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${LAST_MODIFIED.toISOString()}</LastModified><ETag>&quot;${createHash("md5").update(body).digest("hex")}&quot;</ETag><Size>${body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      )
      .join("");

    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
    );
  }

  // GetObject, with range support so seeking works in the browser.
  if (path.startsWith(`${BUCKET}/`)) {
    const body = objects.get(path.slice(BUCKET.length + 1));
    if (!body) {
      res.writeHead(404, { "Content-Type": "application/xml" });
      return res.end("<Error><Code>NoSuchKey</Code></Error>");
    }

    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "audio/mpeg",
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
      });
      return res.end(slice);
    }

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
      ...(url.searchParams.has("response-content-disposition")
        ? { "Content-Disposition": url.searchParams.get("response-content-disposition") }
        : {}),
    });
    return res.end(body);
  }

  res.writeHead(404).end();
}).listen(PORT, "0.0.0.0", () => {
  console.log(`fake-s3: ${objects.size} objects at s3://${BUCKET}/${PREFIX} on port ${PORT}`);
});
