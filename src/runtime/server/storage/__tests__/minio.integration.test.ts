import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { H3Event } from 'h3';
import {
    DeleteObjectsCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { S3StorageGatewayAdapter } from '../s3-storage-gateway-adapter';
import type { UploadIntentReservationRequest } from '~~/server/sync/gateway/types';

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

const describeMinioIntegration = process.env.OR3_S3_INTEGRATION_TESTS === 'true'
    ? describe
    : describe.skip;

describeMinioIntegration('minio integration (opt-in)', () => {
    it.each([
        { mimeType: 'image/png', kind: 'image' as const, content: 'or3-s3-image', disposition: 'inline', hashForm: 'uppercase' },
        { mimeType: 'application/pdf', kind: 'pdf' as const, content: 'or3-s3-pdf', disposition: 'inline', hashForm: 'bare' },
        { mimeType: 'text/plain', kind: 'file' as const, content: '', disposition: 'attachment', hashForm: 'canonical' },
    ])('presign → PUT → commit → canonical GET for $mimeType ($hashForm hash)', async ({ mimeType, kind, content, disposition, hashForm }) => {
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
        let failMarkerWrite = false;
        client.middlewareStack.add((next, context) => async (args) => {
            if (failMarkerWrite && context.commandName === 'PutObjectCommand' &&
                (args.input as { Key?: string }).Key?.endsWith('.meta.json')) {
                failMarkerWrite = false;
                throw new Error('Simulated transient marker write failure');
            }
            return next(args);
        }, { step: 'initialize' });
        let failConsumption = kind === 'image';
        let now = Date.now();
        const reservations = new Map<string, UploadIntentReservationRequest & { storageId?: string }>();

        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint,
                region,
                bucket,
                accessKeyId,
                secretAccessKey,
                sessionToken,
                forcePathStyle: process.env.OR3_STORAGE_S3_FORCE_PATH_STYLE === 'true',
                keyPrefix: (maybeEnv('OR3_STORAGE_S3_KEY_PREFIX') ?? '').replace(/\/?$/, '/').replace(/^\/$/, ''),
                urlTtlSeconds: 60,
                requireChecksum: true,
            },
            {
                client,
                now: () => now,
                getSyncGateway: () => ({
                    async reserveUploadIntent(_event, input) {
                        reservations.set(input.intentId, { ...input });
                    },
                    async consumeUploadIntent(_event, input) {
                        const reservation = reservations.get(input.intentId);
                        if (!reservation || reservation.workspaceId !== input.workspaceId ||
                            reservation.hash !== input.hash || reservation.mimeType !== input.mimeType ||
                            reservation.sizeBytes !== input.sizeBytes ||
                            (reservation.storageId !== undefined && reservation.storageId !== input.storageId)) {
                            throw Object.assign(new Error('Upload intent mismatched'), { statusCode: 409 });
                        }
                        if (reservation.expiresAt <= Math.floor(now / 1000)) {
                            throw Object.assign(new Error('Upload intent expired'), { statusCode: 409 });
                        }
                        if (failConsumption) {
                            failConsumption = false;
                            throw Object.assign(new Error('Temporary sync failure'), { statusCode: 503 });
                        }
                        reservation.storageId = input.storageId;
                    },
                }),
            }
        );

        // The provider validates the hash, size and MIME, not the file format.
        const bytes = new TextEncoder().encode(content);
        const canonicalHash = sha256HashOf(bytes);
        const hash = hashForm === 'uppercase' ? canonicalHash.toUpperCase()
            : hashForm === 'bare' ? canonicalHash.slice('sha256:'.length) : canonicalHash;
        const workspaceId = `ws_s3_test_${crypto.randomUUID().replaceAll('-', '')}`;

        let presignUp = await adapter.presignUpload({} as unknown as H3Event, {
            workspaceId,
            hash,
            mimeType,
            sizeBytes: bytes.byteLength,
        });

        try {
            if (bytes.byteLength > 0) {
                const mutated = bytes.slice();
                mutated[0] = mutated[0]! ^ 1;
                const rejected = await fetch(presignUp.url, {
                    method: 'PUT', headers: presignUp.headers, body: mutated,
                });
                expect(rejected.status).toBe(400);
            }
            const putRes = await fetch(presignUp.url, {
                method: presignUp.method ?? 'PUT',
                headers: presignUp.headers,
                body: bytes,
            });
            expect(putRes.ok).toBe(true);

            await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash }))
                .rejects.toMatchObject({ statusCode: 404 });
            const commitInput = {
                workspace_id: workspaceId,
                intent_id: presignUp.intentId,
                hash,
                storage_id: presignUp.storageId,
                storage_provider_id: 's3',
                mime_type: mimeType,
                size_bytes: bytes.byteLength,
                name: 'integration',
                kind,
            };
            if (kind === 'image') {
                // An expired active reservation cannot publish a marker.
                now = presignUp.expiresAt! + 1;
                await expect(adapter.commit({} as H3Event, commitInput))
                    .rejects.toMatchObject({ statusCode: 409 });
                await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash: canonicalHash }))
                    .rejects.toMatchObject({ statusCode: 404 });
                now = Date.now();
                presignUp = await adapter.presignUpload({} as H3Event, {
                    workspaceId, hash, mimeType, sizeBytes: bytes.byteLength,
                });
                expect((await fetch(presignUp.url, {
                    method: 'PUT', headers: presignUp.headers, body: bytes,
                })).ok).toBe(true);
                commitInput.intent_id = presignUp.intentId;
                await expect(adapter.commit({} as H3Event, commitInput))
                    .rejects.toMatchObject({ statusCode: 503 });
                await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash: canonicalHash }))
                    .rejects.toMatchObject({ statusCode: 404 });
                failMarkerWrite = true;
                await expect(adapter.commit({} as H3Event, commitInput))
                    .rejects.toMatchObject({ statusCode: 502 });
                await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash: canonicalHash }))
                    .rejects.toMatchObject({ statusCode: 404 });
                // An expired consumed receipt cannot create an uncharged commit.
                now = presignUp.expiresAt! + 1;
                await expect(adapter.commit({} as H3Event, commitInput))
                    .rejects.toMatchObject({ statusCode: 409 });
                await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash: canonicalHash }))
                    .rejects.toMatchObject({ statusCode: 404 });
                presignUp = await adapter.presignUpload({} as H3Event, {
                    workspaceId, hash, mimeType, sizeBytes: bytes.byteLength,
                });
                expect((await fetch(presignUp.url, {
                    method: 'PUT', headers: presignUp.headers, body: bytes,
                })).ok).toBe(true);
                commitInput.intent_id = presignUp.intentId;
            }
            if (kind === 'pdf') {
                failMarkerWrite = true;
                await expect(adapter.commit({} as H3Event, commitInput))
                    .rejects.toMatchObject({ statusCode: 502 });
                await expect(adapter.presignDownload({} as H3Event, { workspaceId, hash: canonicalHash }))
                    .rejects.toMatchObject({ statusCode: 404 });
            }
            await Promise.all([
                adapter.commit({} as H3Event, commitInput),
                adapter.commit({} as H3Event, commitInput),
            ]);
            now = Date.now();
            // A bad commit payload must never erase an existing committed object.
            await expect(adapter.commit({} as H3Event, { ...commitInput, size_bytes: bytes.byteLength + 1 }))
                .rejects.toMatchObject({ statusCode: 400 });
            await expect(adapter.deleteObject({} as H3Event, { workspaceId, hash }))
                .rejects.toMatchObject({ statusCode: 503 });
            expect(await adapter.gc({} as H3Event, { workspace_id: workspaceId, retention_seconds: 0 }))
                .toMatchObject({ status: 'disabled', reason: 'deletion_coordination_required' });

            const presignDown = await adapter.presignDownload({} as unknown as H3Event, {
                workspaceId,
                hash: canonicalHash,
                mimeType,
                disposition,
                filename: 'integration',
            });

            const getRes = await fetch(presignDown.url, {
                method: presignDown.method ?? 'GET',
                headers: presignDown.headers,
            });
            expect(getRes.ok).toBe(true);
            expect(getRes.headers.get('content-type')).toBe(kind === 'file' ? 'application/octet-stream' : mimeType);
            expect(getRes.headers.get('content-disposition')).toContain(disposition);
            const downloaded = new Uint8Array(await getRes.arrayBuffer());
            expect(sha256HashOf(downloaded)).toBe(canonicalHash);

            if (kind === 'image') {
                const repeatedUpload = await adapter.presignUpload({} as H3Event, {
                    workspaceId, hash: canonicalHash, mimeType, sizeBytes: bytes.byteLength,
                });
                const repeatedPut = await fetch(repeatedUpload.url, {
                    method: 'PUT', headers: repeatedUpload.headers, body: bytes,
                });
                expect(repeatedPut.ok).toBe(true);
                const repeatedCommit = { ...commitInput, hash: canonicalHash, intent_id: repeatedUpload.intentId };
                await adapter.commit({} as H3Event, repeatedCommit);

                // A conflicting marker must not authorize a different object scope.
                await client.send(new PutObjectCommand({
                    Bucket: bucket, Key: `${presignUp.storageId}.meta.json`,
                    Body: JSON.stringify({ workspace_id: 'other-workspace' }),
                    ContentType: 'application/json',
                }));
                await expect(adapter.commit({} as H3Event, repeatedCommit))
                    .rejects.toMatchObject({ statusCode: 409 });
            }

        } finally {
            // Only the isolated test fixture is removed, including on failure.
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
                );
            client.destroy();
        }
    });
});
