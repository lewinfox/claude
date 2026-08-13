# Deploying to Fly.io

The SQLite index lives on a Fly volume mounted at `/data`. Everything else is
stateless.

## 1. Create the app

```bash
fly launch --no-deploy --name my-jukebox --region lhr
```

Answer no when it offers to set up Postgres, Redis or a Tigris bucket — none are
needed. `fly.toml` in this directory already has the right settings; edit `app`
and `primary_region`, and set `AWS_REGION` under `[env]` to your bucket's region.

**Put the app in the same region as the bucket.** Bulk zips pull whole objects
from S3 into the machine before streaming them out, so a cross-region app pays
that in latency and transfer cost on every zip.

## 2. Create the volume

The volume must exist before the first deploy, in the same region as the app:

```bash
fly volumes create jukebox_data --region lhr --size 1
```

1GB is generous. The metadata for 5,000 tracks is a couple of MB; stored cover
art dominates, and it is deduplicated by content hash so an album's tracks share
one blob. Roughly 50–100MB for a library that size. You can grow it later with
`fly volumes extend`, but not shrink it.

## 3. Set secrets

Never put these in `fly.toml` — it is committed to the repo.

```bash
fly secrets set \
  APP_PASSWORD="$(openssl rand -base64 18)" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  AWS_ACCESS_KEY_ID=AKIA... \
  AWS_SECRET_ACCESS_KEY=...
```

`S3_BUCKET` and `S3_PREFIX` are already in `fly.toml` under `[env]` — neither is
a secret, so they don't belong here.

Print the password somewhere you'll see it before you lose it — Fly will not show
it back to you.

The IAM credentials need exactly the read-only policy in
[`aws-setup.md`](aws-setup.md). Fly runs outside AWS, so this has to be an IAM
user access key; there is no role to assume.

## 4. Deploy

```bash
fly deploy
fly scale count 1     # never more than 1, see below
```

Then `fly open` and log in with `APP_PASSWORD`.

## The one rule: exactly one machine

A Fly volume attaches to a single machine. Scale to two and the second gets its
*own, empty* volume — you end up with two divergent SQLite indexes, and requests
land on whichever machine the proxy picks. Sessions break, search results differ
between refreshes, and re-indexing runs twice against S3.

`max_machines_running = 1` in `fly.toml` guards the autoscaler, but `fly scale
count` overrides it, so don't. If you ever need real redundancy, the index is
disposable — the right move is a second app with its own volume, not a second
machine on this one.

## Volume ownership

Fly mounts a fresh volume owned by `root`, but the app runs as the unprivileged
`node` user. `docker-entrypoint.sh` starts as root, `chown`s the data directory,
then drops privileges via `gosu`. Without that, SQLite fails to open the database
on first boot with `SQLITE_CANTOPEN`. This is handled — it's noted here because
it is the thing that breaks if the entrypoint is ever bypassed.

## Suspend and the sync schedule

`auto_stop_machines = 'suspend'` lets the machine suspend when idle and resume on
the next request, which is cheap and wakes in well under a second.

The trade-off is that **`SYNC_INTERVAL_MINUTES` only ticks while the machine is
awake.** A suspended jukebox is not re-indexing hourly. In practice this barely
matters: `SYNC_ON_START` runs a sync when the machine resumes, and the Re-index
button forces one. If you add music often and want the index reliably fresh, set
`min_machines_running = 1` and accept paying for an always-on machine.

## Sizing

`shared-cpu-1x` with 512MB is comfortable:

- Zip streaming holds one object's chunks at a time, so memory is flat whether
  you download 10 tracks or 5,000.
- Indexing reads 256KB per file with a concurrency of 8 — about 2MB in flight.
- Node plus better-sqlite3 idles around 80–100MB.

Indexing 5,000 tracks on one shared CPU takes a few minutes on the first boot.
It happens in the background; the UI is usable while it runs and shows progress
in the header.

## Bandwidth

Worth understanding, because it is the one thing that can surprise you on the
bill:

- **Playback** goes browser → S3 directly via presigned URLs. It does not touch
  Fly, and costs you nothing in Fly bandwidth.
- **Single downloads** are the same redirect. Also free of Fly bandwidth.
- **Bulk zips** stream through the machine: S3 → Fly (AWS egress) → browser (Fly
  egress). A 2GB zip costs you 2GB of both.

If you mostly stream and occasionally grab a zip, this is negligible. If you plan
to bulk-download the whole library regularly, consider a bucket on Cloudflare R2
instead — no egress fees, and the app already supports it via `S3_ENDPOINT`.

## Operating it

```bash
fly logs                      # sync progress, zip requests, errors
fly ssh console               # poke around
fly ssh console -C "ls -la /data"
fly status                    # confirm one machine, volume attached
```

**Losing the volume is not a disaster.** The index is derived entirely from the
bucket; destroy it and the app rebuilds on next start. The only thing you lose is
a few minutes of indexing.

Rotating the password is `fly secrets set APP_PASSWORD=...`, which restarts the
machine. Changing `SESSION_SECRET` additionally logs out every existing session,
which is what you want if a password has leaked.
