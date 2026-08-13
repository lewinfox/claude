# s3-jukebox

A small container that puts a searchable web player in front of a **private** S3
bucket full of MP3s. Search by artist/album/title, play in the browser, download
tracks individually or as a streamed zip.

The bucket is never made public. The app holds read-only credentials and mints
short-lived presigned URLs, so audio streams straight from S3 to the browser and
never passes through the container.

## Run it

```bash
docker build -t s3-jukebox .

docker run -d --name jukebox \
  -p 8080:8080 \
  -v jukebox-data:/data \
  --env-file .env \
  s3-jukebox
```

Copy `.env.example` to `.env` first and fill in `APP_PASSWORD`, `S3_BUCKET`,
`AWS_REGION` and credentials.

Then open <http://localhost:8080> and log in with `APP_PASSWORD`.

## S3 permissions

The app needs read access and nothing else. This policy is scoped to
`s3://lewinfox-music/library/` — attach it to the IAM user whose access key you
give the container:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListLibrary",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::lewinfox-music",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["library/", "library/*"]
        }
      }
    },
    {
      "Sid": "ReadTracks",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::lewinfox-music/library/*"
    }
  ]
}
```

Matching config: `S3_BUCKET=lewinfox-music` and `S3_PREFIX=library/`.

Two things to watch:

- The actions take **different resource ARNs** — `ListBucket` acts on the bucket,
  `GetObject` on the objects inside it. Using the same ARN for both is the usual
  cause of "it indexes nothing" or "it indexes fine but playback 403s".
- The `s3:prefix` condition lists **both** `library/` and `library/*`. The app
  lists with `Prefix=library/` exactly, which the bare `library/*` pattern would
  reject on some paths — leaving you with an empty library and a 403 in the logs.

Drop the `Condition` and use `arn:aws:s3:::lewinfox-music/*` if you'd rather the
app see the whole bucket, and clear `S3_PREFIX`.

**Leave Block Public Access fully on.** No public bucket policy, no static
website hosting and no CORS rule are needed — playback and downloads are
navigations to presigned URLs, not `fetch` calls, so the browser never runs a
CORS check.

[`docs/aws-setup.md`](docs/aws-setup.md) has the rest: credential choice for
running on vs. off AWS, how presigned URL lifetime differs between IAM user keys
and role credentials, indexing costs, and the CORS rule you would need if the UI
ever grows waveforms.

## Deploy to Fly.io

`fly.toml` is set up for a single machine with a volume mounted at `/data` for
the SQLite index:

```bash
fly launch --no-deploy --name my-jukebox --region syd
fly volumes create jukebox_data --region syd --size 1
fly secrets set APP_PASSWORD=... SESSION_SECRET=... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
fly deploy
```

The bucket and prefix are already in `fly.toml` under `[env]`; only the password
and AWS keys are secrets.

**Run exactly one machine.** A Fly volume attaches to a single machine, so
scaling up gives the second one its own empty index. Full walkthrough, sizing
and bandwidth notes in [`docs/fly-deploy.md`](docs/fly-deploy.md).

## Develop

### Without AWS

`dev/fake-s3.mjs` is a small S3-compatible server that serves synthetic MP3s
built in memory — real ID3v2.3 tags and valid MPEG frames, so indexing, tag
parsing and browser playback all behave as they do against real S3. No account,
no credentials, no bucket.

```bash
npm install
npm run fake-s3      # terminal 1
npm run dev:offline  # terminal 2
```

Open <http://localhost:8080> and log in with `dev`. Three albums, one track
deliberately missing cover art and one file with no tags at all, so the fallback
paths are visible.

To run the *container* against it, point it at the host:

```bash
docker build -t s3-jukebox .
docker run --rm -p 8080:8080 \
  -e APP_PASSWORD=dev \
  -e S3_BUCKET=lewinfox-music -e S3_PREFIX=library/ \
  -e S3_ENDPOINT=http://host.docker.internal:9099 -e S3_FORCE_PATH_STYLE=true \
  -e AWS_REGION=ap-southeast-2 -e AWS_ACCESS_KEY_ID=dev -e AWS_SECRET_ACCESS_KEY=dev \
  --add-host=host.docker.internal:host-gateway \
  s3-jukebox
```

### Against the real bucket

```bash
cp .env.example .env    # then set APP_PASSWORD and pick a credential source
npm run dev
```

`npm run dev` loads `.env` itself and keeps the index in `./data/jukebox.db`, so
nothing needs setting on the command line. Anything already exported in your
shell still wins over the file.

For credentials, **prefer an existing AWS CLI profile** — set `AWS_PROFILE` in
`.env` and no keys end up in a file at all. Explicit
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` work too; that's what the deployed
container uses. Either way the credentials only need the read-only policy above.

Access is read-only, so there is nothing local development can damage in the
bucket. The first run does fetch tag data for every track — a 256KB ranged read
each, a few minutes and a few cents for a library of this size. That index then
persists in `./data`, and later runs only look at what changed.

`npm run typecheck` for types, `npm run build` to compile.

## How it works

**Indexing.** On startup (and hourly, and on demand via the Re-index button) the
app pages through `ListObjectsV2`, then for each new or changed key issues a
ranged `GetObject` for the first 256KB — enough to parse ID3 tags, cover art and
duration without downloading the file. Results go into SQLite with an FTS5 index
over artist/album/title. Objects whose ETag and size are unchanged are skipped,
so re-syncs are cheap.

**Playback.** `<audio>` points at `/api/tracks/:id/stream`, which 302s to a
presigned S3 URL. S3 serves range requests natively, so seeking works, and the
container serves no audio bytes.

**Single downloads** use the same redirect with a signed
`response-content-disposition` override, which is the only reliable way to force
a save dialog cross-origin.

**Bulk downloads** stream a zip built on the fly. Entries are stored
uncompressed (MP3s don't compress) and each S3 read starts only when the
archiver reaches that entry, so memory stays flat whether you grab 10 tracks or
5,000. This is the one path where audio does transit the container.

**Cover art** is extracted from ID3 APIC frames and deduplicated by content
hash, so an album's tracks share one stored blob.

## Configuration

Everything is environment variables — see [`.env.example`](.env.example) for the
annotated list. The ones you're most likely to touch:

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_PASSWORD` | — | Required. The single shared password. |
| `S3_BUCKET` | — | Required. |
| `SESSION_SECRET` | random | Set it, or restarts log everyone out. |
| `S3_PREFIX` | (none) | Index only part of the bucket. |
| `DB_PATH` | `/data/jukebox.db` | Mount a volume or re-index on every start. |
| `PRESIGN_EXPIRY_SECONDS` | `3600` | How long playback links stay valid. |
| `SYNC_INTERVAL_MINUTES` | `60` | `0` disables background re-indexing. |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS. |

## Caveats

- **Auth is one shared password.** Fine behind a private URL or a VPN; it is not
  multi-user and has no rate limiting beyond a fixed delay on failed logins. Put
  it behind Tailscale or Cloudflare Access if it faces the internet.
- **Presigned URLs are bearer tokens.** Anyone with the link can fetch that
  object until it expires.
- **The SQLite index is disposable.** Lose it and the app rebuilds it from the
  bucket on next start.
- **Tags are trusted as-is.** Badly tagged files sort and search badly; the app
  does no cleanup or MusicBrainz lookups.
