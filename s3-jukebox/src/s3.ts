import { Readable } from "node:stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

export const s3 = new S3Client({
  region: config.region,
  ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  forcePathStyle: config.forcePathStyle,
});

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  lastModified: string | null;
}

function hasAudioExtension(key: string): boolean {
  const lower = key.toLowerCase();
  return config.extensions.some((ext) => lower.endsWith(ext));
}

/** Walks the whole bucket (or prefix), yielding audio objects a page at a time. */
export async function* listAudioObjects(): AsyncGenerator<ListedObject[]> {
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    const page = (response.Contents ?? [])
      .filter((obj: _Object): obj is _Object & { Key: string } =>
        Boolean(obj.Key) && hasAudioExtension(obj.Key!),
      )
      .map((obj) => ({
        key: obj.Key,
        size: obj.Size ?? 0,
        // ETags come back quoted; strip so comparisons are stable.
        etag: (obj.ETag ?? "").replace(/^"|"$/g, ""),
        lastModified: obj.LastModified?.toISOString() ?? null,
      }));

    if (page.length > 0) yield page;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** Reads the first `length` bytes of an object — enough for ID3 tags. */
export async function readHead(key: string, length: number): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Range: `bytes=0-${length - 1}`,
    }),
  );

  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as Readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * A stream that does not touch S3 until something actually reads from it. This
 * lets the zip builder queue thousands of entries without opening thousands of
 * connections up front.
 */
export function lazyObjectStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      yield* response.Body as Readable;
    })(),
  );
}

/**
 * A time-limited URL the browser can hit directly, so audio never passes
 * through this container. Passing `downloadAs` signs a Content-Disposition
 * override, which is the only reliable way to force a cross-origin download.
 */
export function presign(key: string, downloadAs?: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ...(downloadAs
      ? { ResponseContentDisposition: contentDisposition(downloadAs) }
      : {}),
  });
  return getSignedUrl(s3, command, { expiresIn: config.presignExpirySeconds });
}

/** RFC 5987 encoding, so non-ASCII filenames survive the round trip. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
