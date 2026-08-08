# or3-provider-s3

S3-compatible storage provider for [OR3 Chat](https://github.com/or3-chat/or3-chat) — blob uploads and downloads through server-signed presigned URLs.

## What It Provides

- Registers a server-side `StorageGatewayAdapter` with ID `s3`.
- Generates short-lived presigned `PUT` and `GET` URLs for direct browser-to-S3 transfer.
- Keeps S3 credentials **server-only** — they never reach the browser.
- Binds every upload to a declared SHA-256 checksum and exact content length.
- Verifies uploads on commit (size, MIME type, checksum, intent expiry) before accepting them.
- Works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, and other S3-compatible hosts.

**This is a storage-only provider.** It does not provide auth or sync. Pair it with an auth provider and a sync provider for a complete stack.

## Install

```bash
bun add or3-provider-s3
```

Local sibling package (development):

```bash
bun add or3-provider-s3@link:../or3-provider-s3
```

## Enable the Module

Add `or3-provider-s3/nuxt` to the generated provider modules list (host app):

```ts
// or3.providers.generated.ts
export const or3ProviderModules: readonly string[] = [
    "or3-provider-s3/nuxt",
    // ... other providers
];
```

Or add it directly in `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
    modules: [
        'or3-provider-s3/nuxt',
        // ... other providers
    ],
});
```

The adapter only registers when the host app has auth and storage enabled and the storage provider is set to `s3`. The host gates are `auth.enabled`, `storage.enabled`, and `storage.provider` (set via `SSR_AUTH_ENABLED`, `OR3_STORAGE_ENABLED`, and `NUXT_PUBLIC_STORAGE_PROVIDER=s3`). If the provider is selected but its config is invalid, startup fails with a descriptive error.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OR3_STORAGE_S3_REGION` | **Yes** | — | AWS region for the bucket |
| `OR3_STORAGE_S3_BUCKET` | **Yes** | — | S3 bucket name |
| `OR3_STORAGE_S3_ACCESS_KEY_ID` | **Yes** | — | Access key ID (server-only) |
| `OR3_STORAGE_S3_SECRET_ACCESS_KEY` | **Yes** | — | Secret access key (server-only) |
| `OR3_STORAGE_S3_ENDPOINT` | No | AWS default | Custom endpoint URL (R2, MinIO, B2). Must be HTTPS unless `OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true` |
| `OR3_STORAGE_S3_SESSION_TOKEN` | No | — | Session token for temporary credentials |
| `OR3_STORAGE_S3_FORCE_PATH_STYLE` | No | `false` | Use path-style URLs instead of virtual-hosted. Required by MinIO and many S3-compatible hosts |
| `OR3_STORAGE_S3_KEY_PREFIX` | No | `''` | Key prefix inside the bucket. Leading/trailing slashes are trimmed and a trailing slash is added |
| `OR3_STORAGE_S3_URL_TTL_SECONDS` | No | `900` | Presigned URL lifetime in seconds. Integer from 1 to 3600 |
| `OR3_STORAGE_S3_REQUIRE_CHECKSUM` | No | `true` | Checksum enforcement is mandatory. Setting it to `false` is rejected at startup |
| `OR3_STORAGE_S3_ALLOW_INSECURE_HTTP` | No | `false` | Set `true` to allow an `http://` endpoint (development only) |
| `OR3_STRICT_CONFIG` | No | `false` (`true` when `NODE_ENV=production`) | Force strict config validation at startup |

Notes:

- A missing required `OR3_STORAGE_S3_*` variable is a startup error when the `s3` provider is selected (for example `Missing OR3_STORAGE_S3_BUCKET.`).
- `OR3_STORAGE_S3_ENDPOINT` must be a valid URL. An empty value is allowed (uses the AWS default endpoint).
- `OR3_STORAGE_S3_URL_TTL_SECONDS` values outside 1–3600 are rejected at startup.
- `OR3_S3_INTEGRATION_TESTS=true` enables the optional MinIO round-trip test suite only. It is not a runtime setting.

## How It Works

The provider implements the storage gateway contract. The host app's presign, commit, and delete routes call into it; file bytes always move directly between the browser and S3.

```
Client
  │
  ├─ POST /api/storage/presign-upload   ──► presignUpload()
  │                                        returns signed PUT URL + required
  │                                        headers (Content-Length,
  │                                        x-amz-checksum-sha256), intent_id
  │
  ├─ PUT  https://bucket/.../<key>      ──► direct to S3 using the signed URL
  │
  ├─ POST /api/storage/commit           ──► commit(): HEAD the object, verify
  │                                        size, MIME, checksum, intent expiry,
  │                                        then write <key>.meta.json marker
  │
  ├─ POST /api/storage/presign-download ──► presignDownload(): signed GET URL
  │
  └─ GET  https://bucket/.../<key>      ──► direct from S3 using the signed URL
```

Deletes are server-side: `deleteObject` derives the key from the workspace and hash, rejects a mismatched `storage_id`, and idempotently removes the blob and its commit marker.

### Object Layout

```
<keyPrefix><workspaceId>/sha256:<64 hex>            ← content-addressed blob
<keyPrefix><workspaceId>/sha256:<64 hex>.meta.json  ← commit marker
```

Keys are derived, not client-chosen. The object key is always `<prefix><workspace>/<hash>`, so a client cannot target arbitrary paths.

## Security

- **Server-only credentials.** The `S3Client` is built with your access key and secret inside the Nitro server. The browser only ever receives signed URLs.
- **Short-lived URLs.** Signed URLs default to 15 minutes. The hard cap is one hour, even if a caller asks for longer.
- **Operation scope.** A signed `PUT` URL can only upload; a signed `GET` URL can only download.
- **Key validation.** Workspace IDs must match `[a-zA-Z0-9_-]+` and hashes must be canonical `sha256:<64 hex>`. A caller-supplied `storage_id` that does not match the derived key is rejected with 400 on download, commit, and delete.
- **Upload binding.** Presigned uploads require the declared `Content-Length` and an `x-amz-checksum-sha256` header. Commit verifies the stored object's size, MIME type, checksum, workspace/hash/intent metadata, and intent expiry (410 when expired). Any mismatch deletes the uploaded blob and fails the commit.
- **Single commit.** The commit marker is written with `IfNoneMatch: *`, so a commit succeeds exactly once. A duplicate commit returns 409.
- **Intent model.** Uploads are tied to a server-issued `intent_id`. Optional workspace quotas require the active sync provider to support atomic upload-intent reservation; without it, a quota request fails with 503 rather than silently skipping the check.
- **Size cap.** Uploads larger than 100 MB are rejected with 413 before any URL is signed.
- **HTTPS by default.** Plain-HTTP endpoints fail startup unless `OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true` is set explicitly (local development only).

## Bucket CORS (required)

Uploads and downloads are direct browser-to-S3 requests, so the bucket must allow CORS from your OR3 origin:

- Methods: `GET`, `PUT`, `HEAD`
- Allowed headers: `Content-Type`, `x-amz-*`
- Expose headers: `ETag`, `Content-Length`
- Allowed origins: your OR3 site origin(s)

The exact CORS JSON varies by host; AWS, R2, MinIO, and B2 all support equivalent rules.

## Checksum Behavior

Uploads always require the `x-amz-checksum-sha256` header and a signed `Content-Length`. Both are returned with the presigned upload response, and the commit verifies the stored object's checksum against the declared hash. A startup warning reminds you to confirm your S3 host supports both headers; disabling enforcement (`OR3_STORAGE_S3_REQUIRE_CHECKSUM=false`) is rejected.

## Garbage Collection Safety

Destructive blob GC only runs when the active sync provider supplies canonical, workspace-scoped materialized reference state (via `queryCanonicalStorage`). Without that capability, GC fails closed:

```json
{ "deleted_count": 0, "status": "disabled", "reason": "canonical_reference_state_required" }
```

No S3 listing or delete commands are issued in that case. When the capability exists, GC:

- lists a bounded set of candidates (500 max, at most 10 listing pages),
- HEADs both the blob and its commit marker so listing order is never treated as evidence of a missing counterpart,
- skips anything whose `LastModified` is missing or newer than the retention cutoff,
- checks canonical `live_metadata` and `reference_edges` for every candidate, and rechecks immediately before each delete to close the mark/sweep race,
- deletes blob and marker together, and reports `status: "completed"` with `deleted_count`.

Liveness is always derived from canonical materialized reference state, never reconstructed from partial object listings.

## Backup

S3 is the durable backup. The bucket holds every committed blob plus its `.meta.json` marker; the content-addressed key (`sha256:<hash>`) lets you verify object integrity. Protect the bucket with:

- versioning or bucket-level backup/export on the S3 host, and
- lifecycle rules only if you first confirm they cannot remove objects GC still needs.

Do not delete `.meta.json` markers independently of their blobs.

## Development

```bash
bun run test        # Unit tests (vitest)
bun run type-check  # TypeScript check
bun run build       # Build the nuxt module
```

Additional scripts: `bun run lint` and `bun run type-check:standalone`. An opt-in MinIO round-trip suite runs when `OR3_S3_INTEGRATION_TESTS=true` and the `OR3_STORAGE_S3_*` variables point at a test bucket.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Startup: `Missing OR3_STORAGE_S3_REGION.` / `BUCKET` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` | A required env var is not set | Set the missing variable and restart |
| Startup: `OR3_STORAGE_S3_ENDPOINT must use HTTPS unless OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true` | Plain-HTTP endpoint for local dev | Set `OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true` for local MinIO only |
| Startup: `OR3_STORAGE_S3_URL_TTL_SECONDS must be between 1 and 3600` | TTL outside the allowed range or not an integer | Set the TTL to an integer from 1 to 3600 |
| Browser PUT fails with a CORS error | Bucket CORS does not allow the origin/headers | Add `GET`, `PUT`, `HEAD`, `Content-Type` and `x-amz-*` headers, and expose `ETag` and `Content-Length` (see Bucket CORS) |
| Commit: `Uploaded file not found` (404) | Nothing was uploaded, often because the browser PUT was blocked | Check bucket CORS and that the client sent the returned headers |
| Commit: `Uploaded object checksum mismatch` / `size mismatch` / `content-type mismatch` (400) | Bytes, size, or MIME changed between presign and PUT | Re-upload using the exact size and type from presign; the failed object is deleted automatically |
| Commit: `Upload intent expired` (410) | Commit happened after the upload URL expired | Presign again and upload before the TTL passes |
| Commit: `Upload intent already consumed` (409) | The same upload was committed twice | Treat as success; the first commit won the race |
| Upload: 413 `Upload exceeds ... byte limit` | File larger than 100 MB | Keep uploads under the 100 MB cap |
| Quota request fails with 503 | Workspace quota needs atomic reservation support from the sync provider | Use a sync provider that exposes `reserveUploadIntent`, or skip the quota field |
| Download fails with a signature error | Clock skew or a URL used after expiry | Check server/client clocks; presign a fresh URL |
| `S3 HEAD failed` / `S3 commit marker write failed` (502) | Endpoint, region, bucket, or credentials mismatch, or the key lacks `GetObject`/`PutObject`/`HeadObject`/`DeleteObject` permissions | Verify endpoint/region/bucket and the access key's bucket policy |
| Uploads work but download URLs 404 | `OR3_STORAGE_S3_KEY_PREFIX` changed between upload and download | Keep the prefix stable; keys are derived from it |

## Compatibility

Works with any auth/sync provider combo — this package only handles storage. Tested against AWS S3, Cloudflare R2, MinIO, and Backblaze B2-style hosts via the `endpoint`/`forcePathStyle` options. Hosts must support presigned PUT with `x-amz-checksum-sha256` and a signed `Content-Length`.

See the host documentation for the full cloud setup: `public/_documentation/cloud/provider-s3.md` in the OR3 Chat repo.
