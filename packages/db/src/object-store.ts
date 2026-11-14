import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * The object store (ADR-013, ADR-039): one interface for uploads, downloads and the workers' reads.
 * Keys are made by the platform (`ws/<workspaceId>/files/<fileId>`), never taken from a client.
 */
export interface ObjectStore {
  /** A URL the browser can PUT exactly `size` bytes of `mime` to, for `ttlSeconds`. */
  presignPut(key: string, input: { mime: string; size: number; ttlSeconds: number }): Promise<string>;
  presignGet(key: string, input: { ttlSeconds: number; downloadName?: string }): Promise<string>;
  /** Size and type of a stored object, or undefined when there is none. */
  head(key: string): Promise<{ size: number; mime: string | undefined } | undefined>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, mime: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface S3StoreConfig {
  endpoint: string;
  /** Where browsers reach the store; presigned URLs use it. Defaults to `endpoint`. */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3 API (RustFS locally, any S3-compatible store in production). Path-style, as RustFS needs. */
export function s3ObjectStore(c: S3StoreConfig): ObjectStore {
  const client = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: c.region,
      forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  const inner = client(c.endpoint);
  const outer = c.publicEndpoint && c.publicEndpoint !== c.endpoint ? client(c.publicEndpoint) : inner;
  return {
    presignPut: (key, { mime, size, ttlSeconds }) =>
      getSignedUrl(
        outer,
        new PutObjectCommand({ Bucket: c.bucket, Key: key, ContentType: mime, ContentLength: size }),
        {
          expiresIn: ttlSeconds,
        },
      ),
    presignGet: (key, { ttlSeconds, downloadName }) =>
      getSignedUrl(
        outer,
        new GetObjectCommand({
          Bucket: c.bucket,
          Key: key,
          ...(downloadName
            ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
            : {}),
        }),
        { expiresIn: ttlSeconds },
      ),
    async head(key) {
      try {
        const r = await inner.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0), mime: r.ContentType };
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return undefined;
        throw e;
      }
    },
    async get(key) {
      const r = await inner.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
      return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
    },
    async put(key, body, mime) {
      await inner.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: body, ContentType: mime }));
    },
    async delete(key) {
      await inner.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
  };
}

/** For tests: keeps objects in memory; presigned URLs are `memory://` addresses nothing can open. */
export function memoryObjectStore(): ObjectStore & { objects: Map<string, { body: Uint8Array; mime: string }> } {
  const objects = new Map<string, { body: Uint8Array; mime: string }>();
  return {
    objects,
    presignPut: async (key, { mime, size }) => `memory://put/${key}?type=${encodeURIComponent(mime)}&size=${size}`,
    presignGet: async (key) => `memory://get/${key}`,
    head: async (key) => {
      const o = objects.get(key);
      return o ? { size: o.body.byteLength, mime: o.mime } : undefined;
    },
    get: async (key) => {
      const o = objects.get(key);
      if (!o) throw new Error(`no object at ${key}`);
      return o.body;
    },
    put: async (key, body, mime) => void objects.set(key, { body, mime }),
    delete: async (key) => void objects.delete(key),
  };
}
