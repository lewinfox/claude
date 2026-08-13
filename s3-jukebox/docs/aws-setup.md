# AWS setup

Everything the app needs is read-only. **Block Public Access stays fully
enabled** — the bucket is never made public. The app holds read credentials and
mints short-lived presigned URLs for playback and downloads.

## 1. The IAM policy

Create a customer-managed policy. This is scoped to the library at
`s3://lewinfox-music/library/`:

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

Set `S3_BUCKET=lewinfox-music` and `S3_PREFIX=library/` to match.

The two actions take **different resource ARNs** — `ListBucket` acts on the
bucket itself, `GetObject` on the objects inside it. Putting both on the same
ARN is the usual cause of "it can download but the index is empty" (or vice
versa).

The `s3:prefix` condition allows both `library/` and `library/*` deliberately.
The app pages through `ListObjectsV2` with `Prefix=library/` exactly, and a
condition listing only `library/*` can reject that call — which surfaces as an
empty library and an `AccessDenied` in the logs, not as a policy error.

### Widening it to the whole bucket

Drop the `Condition`, use `arn:aws:s3:::lewinfox-music/*` for `ReadTracks`, and
leave `S3_PREFIX` blank:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListLibrary",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::lewinfox-music"
    },
    {
      "Sid": "ReadTracks",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::lewinfox-music/*"
    }
  ]
}
```

## 2. Credentials

**Running outside AWS** (your NAS, a VPS, a home server) — create an IAM user
with no console access, attach the policy, generate an access key, and pass it
to the container:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-2
```

**Running on AWS** (ECS, EC2, EKS, App Runner) — attach the policy to the task
or instance role instead and leave both key variables unset. The SDK picks the
role up automatically.

### Presigned URL lifetime depends on which you use

- **IAM user access keys** — URLs can live up to 7 days. The app's default is
  1 hour (`PRESIGN_EXPIRY_SECONDS`).
- **Role credentials** — the URL dies when the underlying session token
  expires, which can be sooner than the expiry you asked for. If playback links
  start failing early on a role-based deploy, this is why; lower
  `PRESIGN_EXPIRY_SECONDS` so links are minted fresh more often.

## 3. What you do *not* need

- **No public bucket policy** and no changes to Block Public Access.
- **No static website hosting.**
- **No CORS rule.** `<audio>` playback and downloads are plain navigations, not
  `fetch` calls, so the browser never runs a CORS check. You would only need one
  if the UI later reads audio through the Web Audio API (e.g. for waveforms):

  ```json
  [
    {
      "AllowedOrigins": ["https://jukebox.example.com"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
      "MaxAgeSeconds": 3000
    }
  ]
  ```

- **No write permissions of any kind.** The app never calls `PutObject`,
  `DeleteObject`, or anything else that mutates the bucket. If you want belt and
  braces, add an explicit `Deny` for `s3:Put*` and `s3:Delete*` to the policy.

## 4. Costs worth knowing

- **Indexing** reads only the first 256KB of each new file. For 5,000 tracks
  that is around 1.2GB of `GET` traffic, once — pennies. Re-syncs skip anything
  whose ETag and size are unchanged.
- **Playback** is billed as normal S3 `GET` + egress, direct from S3 to the
  browser. It does not pass through the container.
- **Bulk zips** read full objects through the container, so those bytes are
  billed as egress to wherever the app runs, then again out to your browser if
  the app is hosted remotely.

## 5. S3-compatible alternatives

The app talks plain S3 API, so MinIO, Cloudflare R2 and Backblaze B2 all work.
Set `S3_ENDPOINT` to the service URL and, for MinIO, `S3_FORCE_PATH_STYLE=true`.
Note that R2 has no egress fees, which makes it noticeably cheaper for a
listening-heavy library.
