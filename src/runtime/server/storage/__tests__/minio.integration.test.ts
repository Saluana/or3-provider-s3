import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { H3Event } from 'h3';
import {
    DeleteObjectsCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { S3StorageGatewayAdapter } from '../s3-storage-gateway-adapter';

/**
 * Optional compatibility test suite.
 *
 * This is intentionally skipped by default.
 * Enable by setting OR3_S3_INTEGRATION_TESTS=true and configuring:
 * - OR3_STORAGE_S3_ENDPOINT
 * - OR3_STORAGE_S3_REGION
 * - OR3_STORAGE_S3_BUCKET
 * - OR3_STORAGE_S3_ACCESS_KEY_ID
 * - OR3_STORAGE_S3_SECRET_ACCESS_KEY
 *
 * Then run: bunx vitest run src/runtime/server/storage/__tests__/minio.integration.test.ts
 */

function envOrThrow(key: string): string {
    const value = (process.env[key] ?? '').trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
}

function maybeEnv(key: string): string | undefined {
    const value = (process.env[key] ?? '').trim();
    return value || undefined;
}

function sha256HashOf(bytes: Uint8Array): string {
    const hex = createHash('sha256').update(bytes).digest('hex');
    return `sha256:${hex}`;
}

describe('minio integration (opt-in)', () => {
    const enabled = process.env.OR3_S3_INTEGRATION_TESTS === 'true';

    if (!enabled) {
        it('skipped (set OR3_S3_INTEGRATION_TESTS=true to enable)', () => {});
        return;
    }

    it('presign → PUT → commit → presign → GET roundtrip', async () => {
        const endpoint = maybeEnv('OR3_STORAGE_S3_ENDPOINT');
        const region = envOrThrow('OR3_STORAGE_S3_REGION');
        const bucket = envOrThrow('OR3_STORAGE_S3_BUCKET');
        const accessKeyId = envOrThrow('OR3_STORAGE_S3_ACCESS_KEY_ID');
        const secretAccessKey = envOrThrow('OR3_STORAGE_S3_SECRET_ACCESS_KEY');
        const sessionToken = maybeEnv('OR3_STORAGE_S3_SESSION_TOKEN');

        const client = new S3Client({
            region,
            endpoint,
            forcePathStyle: process.env.OR3_STORAGE_S3_FORCE_PATH_STYLE === 'true',
            credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken,
            },
        });

        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint,
                region,
                bucket,
                accessKeyId,
                secretAccessKey,
                sessionToken,
                forcePathStyle: process.env.OR3_STORAGE_S3_FORCE_PATH_STYLE === 'true',
                keyPrefix: '',
                urlTtlSeconds: 60,
                requireChecksum: process.env.OR3_STORAGE_S3_REQUIRE_CHECKSUM === 'true',
            },
            { client }
        );

        // Fake PNG bytes (content correctness isn't validated by OR3; hash is).
        const bytes = new TextEncoder().encode('or3-s3-integration');
        const hash = sha256HashOf(bytes);
        const workspaceId = 'ws_s3_test';

        const presignUp = await adapter.presignUpload({} as unknown as H3Event, {
            workspaceId,
            hash,
            mimeType: 'image/png',
            sizeBytes: bytes.byteLength,
        });

        const putRes = await fetch(presignUp.url, {
            method: presignUp.method ?? 'PUT',
            headers: presignUp.headers,
            body: bytes,
        });
        expect(putRes.ok).toBe(true);

        await adapter.commit({} as unknown as H3Event, {
            workspace_id: workspaceId,
            hash,
            storage_id: presignUp.storageId,
            storage_provider_id: 's3',
            mime_type: 'image/png',
            size_bytes: bytes.byteLength,
            name: 'integration.png',
            kind: 'image',
        });

        const presignDown = await adapter.presignDownload({} as unknown as H3Event, {
            workspaceId,
            hash,
        });

        const getRes = await fetch(presignDown.url, {
            method: presignDown.method ?? 'GET',
            headers: presignDown.headers,
        });
        expect(getRes.ok).toBe(true);
        const downloaded = new Uint8Array(await getRes.arrayBuffer());
        expect(sha256HashOf(downloaded)).toBe(hash);

        // Cleanup best-effort.
        const objectKey = presignUp.storageId!;
        await client
            .send(
                new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                        Objects: [
                            { Key: objectKey },
                            { Key: `${objectKey}.meta.json` },
                        ],
                        Quiet: true,
                    },
                })
            )
            .catch(() => {});
    });
});
