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

Needs Node 22 or newer (the dev server relies on `--env-file-if-exists`), and
Docker only if you want to exercise the container itself.

```bash
npm install
```

There are three ways to run it, in increasing order of realism.

### 1. Without AWS

`dev/fake-s3.mjs` is a small S3-compatible server that serves synthetic MP3s
built in memory — real ID3v2.3 tags and valid MPEG frames, so indexing, tag
parsing and browser playback all behave as they do against real S3. No account,
no credentials, no bucket.

`dev/fake-s3.mjs` is a small S3-compatible server that serves synthetic MP3s
built in memory — real ID3v2.3 tags and valid MPEG frames, so indexing, tag
parsing and browser playback all behave as they do against real S3. No account,
no credentials, no bucket.

```bash
npm run fake-s3      # terminal 1
npm run dev:offline  # terminal 2
```

Open <http://localhost:8080> and log in with `dev`. Three albums, one track
deliberately missing cover art and one file with no tags at all, so the fallback
paths are visible rather than theoretical. Source changes reload automatically;
the fake bucket does not, so restart it if you edit the fixture.

### 2. Against the real bucket

```bash
cp .env.example .env    # then set APP_PASSWORD and pick a credential source
npm run dev
```

`npm run dev` reads `.env` itself and keeps the index in `./data/jukebox.db`, so
nothing needs setting on the command line. Anything already exported in your
shell still wins over the file.

For credentials, **prefer an existing AWS CLI profile** — put `AWS_PROFILE` in
`.env` and no keys end up in a file at all. Explicit
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` work too; that's what the deployed
container uses. Either way they need only the read-only policy above.

Access is read-only, so nothing local development does can damage the bucket. The
first run fetches tag data for every track — a 256KB ranged read each, a few
minutes and a few cents for a library this size. The index then persists in
`./data`, and later runs only look at what changed. Delete `./data` to force a
full rebuild.

### 3. The container, against the real bucket

Closest to production, and the only way to catch problems in the image itself.
Rather than copying keys into the environment, mount your AWS config read-only:

```bash
docker build -t s3-jukebox .

docker run --rm -p 8080:8080 \
  -v jukebox-dev-data:/data \
  -v ~/.aws:/aws:ro \
  -e AWS_SHARED_CREDENTIALS_FILE=/aws/credentials \
  -e AWS_CONFIG_FILE=/aws/config \
  -e AWS_PROFILE=your-profile \
  -e AWS_REGION=ap-southeast-2 \
  -e S3_BUCKET=lewinfox-music -e S3_PREFIX=library/ \
  -e APP_PASSWORD=dev \
  s3-jukebox
```

Pointing `AWS_SHARED_CREDENTIALS_FILE` at the mount rather than relying on
`~/.aws` inside the container is deliberate: the app runs as the unprivileged
`node` user, so `$HOME` is `/home/node`, not your host home directory. Naming the
files explicitly avoids depending on how the entrypoint resolves `HOME`.

**This only works for profiles with static keys.** An SSO profile or one using
`credential_process` will fail inside the container — SSO needs the cached token
under `~/.aws/sso/cache` refreshed by the `aws` CLI, and `credential_process`
shells out to a binary that isn't in the image. If your profile is either of
those, run `aws configure export-credentials --profile your-profile --format env`
on the host and pass the resulting variables with `-e` instead.

To point the container at the *fake* bucket instead, reach back to the host:

```bash
docker run --rm -p 8080:8080 \
  -e APP_PASSWORD=dev \
  -e S3_BUCKET=lewinfox-music -e S3_PREFIX=library/ \
  -e S3_ENDPOINT=http://host.docker.internal:9099 -e S3_FORCE_PATH_STYLE=true \
  -e AWS_REGION=ap-southeast-2 -e AWS_ACCESS_KEY_ID=dev -e AWS_SECRET_ACCESS_KEY=dev \
  --add-host=host.docker.internal:host-gateway \
  s3-jukebox
```

### Testing it

With a server running, `npm run smoke` exercises the paths that are awkward to
check by eye — the presigned redirect, range requests (so seeking works), zip
structure, and the auth boundary:

```bash
npm run smoke                                    # offline server, password "dev"
PASSWORD=your-password npm run smoke             # against the real bucket
BASE_URL=https://my-jukebox.fly.dev PASSWORD=... npm run smoke
```

It is read-only — it never writes to the bucket or the index — so it is safe to
point at a deployed instance. It exits non-zero if anything fails.

For the UI itself there is no automated coverage; open the app and click around.
The offline fixture is built to make the awkward cases visible: a track with no
cover art, a file with no tags, and albums long enough to page through.

`npm run typecheck` for types, `npm run build` to compile.

### When something doesn't work

| Symptom | Cause |
| --- | --- |
| `Missing required environment variable: APP_PASSWORD` | No `.env`, or you're in the wrong directory. |
| Library stays empty, `AccessDenied` in logs | `s3:ListBucket` missing, or the `s3:prefix` condition doesn't allow `library/`. |
| Indexes fine, playback 403s | `s3:GetObject` resource ARN is wrong — it needs the `/*` suffix. |
| `PermanentRedirect`, or every request is slow | `AWS_REGION` doesn't match the bucket. The SDK follows the redirect, at the cost of a round trip each time. |
| Playback links die after a few minutes | Role/SSO credentials expiring before `PRESIGN_EXPIRY_SECONDS`. Lower it. |
| Logged out on every restart | `SESSION_SECRET` unset, so a random one is generated at boot. |
| `SQLITE_CANTOPEN` in the container | The data directory isn't writable — the entrypoint was bypassed, or `DB_PATH` points outside the volume. |

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
- **Sessions are stateless and logout is client-side.** The session cookie is a
  signed timestamp, so "Log out" tells the browser to discard it but does not
  revoke it — a cookie captured beforehand keeps working until
  `SESSION_MAX_AGE_SECONDS` (30 days by default). To kill live sessions, rotate
  `SESSION_SECRET`. Shorten the max age if that window bothers you.
- **The SQLite index is disposable.** Lose it and the app rebuilds it from the
  bucket on next start.
- **Tags are trusted as-is.** Badly tagged files sort and search badly; the app
  does no cleanup or MusicBrainz lookups.
