import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import type {
    CanonicalStorageQueryRequest,
    CanonicalStorageQueryResponse,
} from '~~/server/sync/gateway/types';
import {
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { S3StorageGatewayAdapter } from '../s3-storage-gateway-adapter';
import { verifyStorageReferenceContract } from '~~/shared/testing/contracts/storage';

const HASH = `sha256:${'a'.repeat(64)}`;
const CHECKSUM = Buffer.from('a'.repeat(64), 'hex').toString('base64');
const INTENT_ID = 'intent-1';

const signedUrlMock = vi.hoisted(() => vi.fn(async () => 'https://signed.example'));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: signedUrlMock,
}));

function makeAdapter(overrides: Partial<ConstructorParameters<typeof S3StorageGatewayAdapter>[0]> = {}) {
    const send = vi.fn(async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
            return {
                ContentLength: 3,
                ContentType: 'image/png',
                ChecksumSHA256: CHECKSUM,
                Metadata: {
                    'or3-workspace': 'ws1',
                    'or3-hash': HASH,
                    'or3-intent': INTENT_ID,
                    'or3-intent-expires': '1000001',
                },
                ETag: '"etag"',
            };
        }
        if (command instanceof PutObjectCommand) {
            return {};
        }
        if (command instanceof DeleteObjectCommand) {
            return {};
        }
        return {};
    });

    const adapter = new S3StorageGatewayAdapter(
        {
            endpoint: undefined,
            region: 'us-east-1',
            bucket: 'bucket',
            accessKeyId: 'ak',
            secretAccessKey: 'sk',
            sessionToken: undefined,
            forcePathStyle: false,
            keyPrefix: '',
            urlTtlSeconds: 900,
            requireChecksum: false,
            ...overrides,
        },
        {
            client: { send },
            now: () => 1_000_000,
            randomId: () => INTENT_ID,
            getSyncGateway: () => undefined,
        }
    );

    return { adapter, send };
}

describe('S3StorageGatewayAdapter', () => {
    beforeEach(() => {
        signedUrlMock.mockClear();
    });

    it('presigns upload with PUT and content-type header', async () => {
        const { adapter } = makeAdapter();
        const result = await adapter.presignUpload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            mimeType: 'image/png',
            sizeBytes: 3,
            expiresInMs: 5000,
        });

        expect(result.method).toBe('PUT');
        expect(result.headers?.['Content-Type']).toBe('image/png');
        expect(result.headers?.['Content-Length']).toBe('3');
        expect(result.headers?.['x-amz-checksum-sha256']).toBeDefined();
        expect(result.storageId).toBe(`ws1/${HASH}`);
        expect(result.intentId).toBe(INTENT_ID);
        expect(result.expiresAt).toBe(1_000_000 + 5 * 1000);
        expect(signedUrlMock).toHaveBeenCalled();
        const signedCommand = (signedUrlMock.mock.calls[0] as unknown[])[1] as PutObjectCommand;
        expect(signedCommand.input.ContentLength).toBe(3);
        expect(signedCommand.input.ChecksumSHA256).toBe(result.headers?.['x-amz-checksum-sha256']);
    });

    it('rejects oversized uploads before issuing a signed URL', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.presignUpload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            mimeType: 'application/octet-stream',
            sizeBytes: 100 * 1024 * 1024 + 1,
        })).rejects.toMatchObject({ statusCode: 413 });
        expect(signedUrlMock).not.toHaveBeenCalled();
    });

    it('persists quota reservation before signing and binds the returned intent', async () => {
        const reserveUploadIntent = vi.fn(async () => undefined);
        const adapter = new S3StorageGatewayAdapter({
            region: 'us-east-1', bucket: 'bucket', accessKeyId: 'ak', secretAccessKey: 'sk',
            forcePathStyle: false, keyPrefix: '', urlTtlSeconds: 900, requireChecksum: true,
        }, {
            client: { send: vi.fn(async () => ({})) }, now: () => 1_000_000,
            randomId: () => INTENT_ID,
            getSyncGateway: () => ({ reserveUploadIntent }),
        });
        await expect(adapter.presignUpload({} as H3Event, {
            workspaceId: 'ws1', hash: HASH, mimeType: 'image/png', sizeBytes: 3,
            workspaceQuotaBytes: 100,
        })).resolves.toMatchObject({ intentId: INTENT_ID });
        expect(reserveUploadIntent).toHaveBeenCalledWith(expect.anything(), {
            intentId: INTENT_ID, workspaceId: 'ws1', hash: HASH, mimeType: 'image/png',
            sizeBytes: 3, expiresAt: 1900, workspaceQuotaBytes: 100,
        });
    });

    it('fails closed when quota is configured without atomic reservation support', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.presignUpload({} as H3Event, {
            workspaceId: 'ws1', hash: HASH, mimeType: 'image/png', sizeBytes: 3,
            workspaceQuotaBytes: 100,
        })).rejects.toMatchObject({ statusCode: 503 });
        expect(signedUrlMock).not.toHaveBeenCalled();
    });

    it('presigns download and forwards disposition', async () => {
        const { adapter } = makeAdapter();
        const result = await adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            disposition: 'attachment',
            expiresInMs: 1000,
        });

        expect(result.method).toBe('GET');
        expect(result.storageId).toBe(`ws1/${HASH}`);
        expect(result.expiresAt).toBe(1_000_000 + 1 * 1000);
        expect(signedUrlMock).toHaveBeenCalled();
    });

    it('caps caller-requested signed URLs at one hour', async () => {
        const { adapter } = makeAdapter({ urlTtlSeconds: 3600 });
        const result = await adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            expiresInMs: 24 * 60 * 60 * 1000,
        });

        expect(result.expiresAt).toBe(1_000_000 + 3600 * 1000);
        const signedCall = signedUrlMock.mock.calls.at(-1) as unknown[] | undefined;
        expect(signedCall?.[2]).toEqual({ expiresIn: 3600 });
    });

    it('rejects download when provided storage_id mismatches derived key', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            storageId: `ws2/${HASH}`,
        })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a raw object without a committed marker', async () => {
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand && command.input.Key?.endsWith('.meta.json')) {
                throw Object.assign(new Error('missing marker'), { name: 'NotFound' });
            }
            return {};
        });
        const adapter = new S3StorageGatewayAdapter({
            region: 'us-east-1', bucket: 'bucket', accessKeyId: 'ak', secretAccessKey: 'sk',
            forcePathStyle: false, keyPrefix: '', urlTtlSeconds: 900, requireChecksum: true,
        }, {
            client: { send },
        });

        await expect(adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
        })).rejects.toMatchObject({ statusCode: 404 });
        expect(signedUrlMock).not.toHaveBeenCalled();
    });

    it('deletes the derived blob and marker and remains idempotent on retry', async () => {
        const { adapter, send } = makeAdapter();
        const input = {
            workspaceId: 'ws1',
            hash: HASH,
            storageId: `ws1/${HASH}`,
        };

        await expect(adapter.deleteObject({} as H3Event, input)).resolves.toBeUndefined();
        await expect(adapter.deleteObject({} as H3Event, input)).resolves.toBeUndefined();

        const keys = send.mock.calls
            .map(([command]) => command)
            .filter((command) => command instanceof DeleteObjectCommand)
            .map((command) => command.input.Key);
        expect(keys).toEqual([
            `ws1/${HASH}`,
            `ws1/${HASH}.meta.json`,
            `ws1/${HASH}`,
            `ws1/${HASH}.meta.json`,
        ]);
    });

    it('rejects a mismatched delete storage_id before issuing an S3 command', async () => {
        const { adapter, send } = makeAdapter();
        await expect(adapter.deleteObject({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            storageId: `ws2/${HASH}`,
        })).rejects.toMatchObject({ statusCode: 400 });
        expect(send).not.toHaveBeenCalled();
    });

    it('commit validates head and writes marker', async () => {
        const { adapter, send } = makeAdapter();
        await adapter.commit({} as H3Event, {
            workspace_id: 'ws1',
            intent_id: INTENT_ID,
            hash: HASH,
            storage_id: `ws1/${HASH}`,
            storage_provider_id: 's3',
            mime_type: 'image/png',
            size_bytes: 3,
            name: 'a.png',
            kind: 'image',
        });

        expect(send).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
        expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('commit rejects uploads missing content length and deletes blob best-effort', async () => {
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return { ContentType: 'image/png', ETag: '"etag"' };
            }
            if (command instanceof DeleteObjectCommand) {
                return {};
            }
            return {};
        });

        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint: undefined,
                region: 'us-east-1',
                bucket: 'bucket',
                accessKeyId: 'ak',
                secretAccessKey: 'sk',
                sessionToken: undefined,
                forcePathStyle: false,
                keyPrefix: '',
                urlTtlSeconds: 900,
                requireChecksum: false,
            },
            {
                client: { send },
                now: () => 1_000_000,
            }
        );

        await expect(adapter.commit({} as H3Event, {
            workspace_id: 'ws1',
            intent_id: INTENT_ID,
            hash: HASH,
            storage_id: `ws1/${HASH}`,
            storage_provider_id: 's3',
            mime_type: 'image/png',
            size_bytes: 3,
            name: 'a.png',
            kind: 'image',
        })).rejects.toMatchObject({ statusCode: 400 });

        expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('commit rejects uploads missing content type and deletes blob best-effort', async () => {
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return { ContentLength: 3, ETag: '"etag"' };
            }
            if (command instanceof DeleteObjectCommand) {
                return {};
            }
            return {};
        });

        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint: undefined,
                region: 'us-east-1',
                bucket: 'bucket',
                accessKeyId: 'ak',
                secretAccessKey: 'sk',
                sessionToken: undefined,
                forcePathStyle: false,
                keyPrefix: '',
                urlTtlSeconds: 900,
                requireChecksum: false,
            },
            {
                client: { send },
                now: () => 1_000_000,
            }
        );

        await expect(adapter.commit({} as H3Event, {
            workspace_id: 'ws1',
            intent_id: INTENT_ID,
            hash: HASH,
            storage_id: `ws1/${HASH}`,
            storage_provider_id: 's3',
            mime_type: 'image/png',
            size_bytes: 3,
            name: 'a.png',
            kind: 'image',
        })).rejects.toMatchObject({ statusCode: 400 });

        expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('rejects expired intents and object checksum mutation before marker creation', async () => {
        const commitInput = {
            workspace_id: 'ws1', intent_id: INTENT_ID, hash: HASH,
            storage_id: `ws1/${HASH}`, storage_provider_id: 's3', mime_type: 'image/png',
            size_bytes: 3, name: 'a.png', kind: 'image' as const,
        };
        const expired = makeAdapter();
        expired.send.mockImplementation(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) return {
                ContentLength: 3, ContentType: 'image/png', ChecksumSHA256: CHECKSUM,
                Metadata: {
                    'or3-workspace': 'ws1', 'or3-hash': HASH, 'or3-intent': INTENT_ID,
                    'or3-intent-expires': '999999',
                },
                ETag: '"etag"',
            };
            return {};
        });
        await expect(expired.adapter.commit({} as H3Event, commitInput))
            .rejects.toMatchObject({ statusCode: 410 });
        expect(expired.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);

        const mutated = makeAdapter();
        mutated.send.mockImplementation(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) return {
                ContentLength: 3, ContentType: 'image/png', ChecksumSHA256: 'wrong',
                Metadata: {
                    'or3-workspace': 'ws1', 'or3-hash': HASH, 'or3-intent': INTENT_ID,
                    'or3-intent-expires': '1000001',
                },
                ETag: '"etag"',
            };
            return {};
        });
        await expect(mutated.adapter.commit({} as H3Event, commitInput))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    it('atomically consumes an S3 upload intent exactly once under concurrent commits', async () => {
        let markerWritten = false;
        const consumeUploadIntent = vi.fn(async () => undefined);
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) return {
                ContentLength: 3, ContentType: 'image/png', ChecksumSHA256: CHECKSUM,
                Metadata: {
                    'or3-workspace': 'ws1', 'or3-hash': HASH, 'or3-intent': INTENT_ID,
                    'or3-intent-expires': '1000001',
                },
            };
            if (command instanceof PutObjectCommand) {
                expect(command.input.IfNoneMatch).toBe('*');
                if (markerWritten) throw { $metadata: { httpStatusCode: 412 } };
                markerWritten = true;
            }
            return {};
        });
        const adapter = new S3StorageGatewayAdapter({
            region: 'us-east-1', bucket: 'bucket', accessKeyId: 'ak', secretAccessKey: 'sk',
            forcePathStyle: false, keyPrefix: '', urlTtlSeconds: 900, requireChecksum: true,
        }, {
            client: { send }, now: () => 1_000_000, randomId: () => INTENT_ID,
            getSyncGateway: () => ({ consumeUploadIntent }),
        });
        const input = {
            workspace_id: 'ws1', intent_id: INTENT_ID, hash: HASH,
            storage_id: `ws1/${HASH}`, storage_provider_id: 's3', mime_type: 'image/png',
            size_bytes: 3, name: 'a.png', kind: 'image' as const,
        };
        const outcomes = await Promise.allSettled([
            adapter.commit({} as H3Event, input),
            adapter.commit({} as H3Event, input),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        expect(consumeUploadIntent).toHaveBeenCalledTimes(1);
    });

    it('gc fails closed without canonical storage capability and issues no S3 requests', async () => {
        const send = vi.fn(async () => {
            throw new Error('GC must not issue an S3 command');
        });

        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint: undefined,
                region: 'us-east-1',
                bucket: 'bucket',
                accessKeyId: 'ak',
                secretAccessKey: 'sk',
                sessionToken: undefined,
                forcePathStyle: false,
                keyPrefix: '',
                urlTtlSeconds: 900,
                requireChecksum: false,
            },
            {
                client: { send },
                now: () => 10_000,
                getSyncGateway: () => undefined,
            }
        );

        const result = await adapter.gc({} as H3Event, {
            workspace_id: 'ws1',
            retention_seconds: 1,
            limit: 10,
        });

        expect(result).toEqual({
            deleted_count: 0,
            status: 'disabled',
            reason: 'canonical_reference_state_required',
        });
        expect(send).not.toHaveBeenCalled();
    });

    it('gc still validates its request before returning the disabled status', async () => {
        const send = vi.fn();
        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint: undefined,
                region: 'us-east-1',
                bucket: 'bucket',
                accessKeyId: 'ak',
                secretAccessKey: 'sk',
                sessionToken: undefined,
                forcePathStyle: false,
                keyPrefix: '',
                urlTtlSeconds: 900,
                requireChecksum: false,
            },
            { client: { send }, getSyncGateway: () => undefined }
        );

        await expect(adapter.gc({} as H3Event, {
            workspace_id: 'ws1',
            retention_seconds: -1,
        })).rejects.toMatchObject({ statusCode: 400 });
        expect(send).not.toHaveBeenCalled();
    });

    function makeGcAdapter(input: {
        listedKeys: string[][];
        existingKeys: string[];
        modifiedAt?: Record<string, Date>;
        canonical?: (kind: string, hash: string) => boolean;
    }) {
        let listPage = 0;
        const deletedKeys: string[] = [];
        const old = new Date(1_000);
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof ListObjectsV2Command) {
                const keys = input.listedKeys[listPage] ?? [];
                listPage += 1;
                return {
                    Contents: keys.map((Key) => ({ Key, LastModified: old })),
                    IsTruncated: listPage < input.listedKeys.length,
                    NextContinuationToken: listPage < input.listedKeys.length ? `page-${listPage}` : undefined,
                };
            }
            if (command instanceof HeadObjectCommand) {
                const key = command.input.Key as string;
                if (!input.existingKeys.includes(key)) {
                    throw Object.assign(new Error('missing'), { name: 'NotFound' });
                }
                return {
                    LastModified: input.modifiedAt?.[key] ?? old,
                    ContentLength: 3,
                    ContentType: 'image/png',
                };
            }
            if (command instanceof DeleteObjectCommand) {
                deletedKeys.push(command.input.Key as string);
                return {};
            }
            return {};
        });
        const queryCanonicalStorage = vi.fn(async (
            _event: H3Event,
            request: CanonicalStorageQueryRequest,
        ): Promise<CanonicalStorageQueryResponse> => {
            if (!input.canonical?.(request.kind, request.hash as string)) {
                return { items: [], hasMore: false };
            }
            return request.kind === 'live_metadata'
                ? {
                    items: [{
                        kind: 'metadata',
                        hash: request.hash as string,
                        sizeBytes: 3,
                        updatedAt: 1,
                    }],
                    hasMore: false,
                }
                : {
                    items: [{
                        kind: 'reference',
                        hash: request.hash as string,
                        sourceTable: 'messages',
                        sourceId: 'message-1',
                    }],
                    hasMore: false,
                };
        });
        const adapter = new S3StorageGatewayAdapter(
            {
                endpoint: undefined,
                region: 'us-east-1',
                bucket: 'bucket',
                accessKeyId: 'ak',
                secretAccessKey: 'sk',
                sessionToken: undefined,
                forcePathStyle: false,
                keyPrefix: '',
                urlTtlSeconds: 900,
                requireChecksum: false,
            },
            {
                client: { send },
                now: () => 100_000,
                getSyncGateway: () => ({ queryCanonicalStorage }),
            }
        );
        return { adapter, send, deletedKeys, queryCanonicalStorage };
    }

    it('does not delete an old blob when its newer marker is on a later listing page', async () => {
        const objectKey = `ws1/${HASH}`;
        const markerKey = `${objectKey}.meta.json`;
        const { adapter, send, deletedKeys } = makeGcAdapter({
            listedKeys: [[objectKey], [markerKey]],
            existingKeys: [objectKey, markerKey],
            modifiedAt: { [markerKey]: new Date(100_000) },
        });

        await expect(adapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: 1, limit: 1,
        })).resolves.toEqual({ deleted_count: 0, scanned_count: 1, status: 'completed' });

        expect(send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command)).toHaveLength(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.objectContaining({ Key: markerKey }),
        }));
        expect(deletedKeys).toEqual([]);
    });

    it('does not delete an old marker when its newer blob is on a later listing page', async () => {
        const objectKey = `ws1/${HASH}`;
        const markerKey = `${objectKey}.meta.json`;
        const { adapter, send, deletedKeys } = makeGcAdapter({
            listedKeys: [[markerKey], [objectKey]],
            existingKeys: [objectKey, markerKey],
            modifiedAt: { [objectKey]: new Date(100_000) },
        });

        await expect(adapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: 1, limit: 1,
        })).resolves.toMatchObject({ deleted_count: 0, scanned_count: 1 });

        expect(send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command)).toHaveLength(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.objectContaining({ Key: objectKey }),
        }));
        expect(deletedKeys).toEqual([]);
    });

    it('deletes an unreferenced committed blob and marker together', async () => {
        const objectKey = `ws1/${HASH}`;
        const markerKey = `${objectKey}.meta.json`;
        const { adapter, deletedKeys, queryCanonicalStorage } = makeGcAdapter({
            listedKeys: [[objectKey, markerKey]],
            existingKeys: [objectKey, markerKey],
        });

        await expect(adapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: 1, limit: 10,
        })).resolves.toEqual({ deleted_count: 1, scanned_count: 1, status: 'completed' });

        expect(deletedKeys).toEqual([objectKey, markerKey]);
        expect(queryCanonicalStorage).toHaveBeenCalledTimes(4);
        for (const call of queryCanonicalStorage.mock.calls) {
            expect(call[1]).toMatchObject({
                scope: { workspaceId: 'ws1' },
                hash: HASH,
                limit: 100,
            });
        }
    });

    it('keeps a committed pair with a canonical reference edge', async () => {
        const objectKey = `ws1/${HASH}`;
        const markerKey = `${objectKey}.meta.json`;
        const { adapter, deletedKeys } = makeGcAdapter({
            listedKeys: [[objectKey, markerKey]],
            existingKeys: [objectKey, markerKey],
            canonical: (kind) => kind === 'reference_edges',
        });

        await adapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: 1, limit: 10,
        });
        expect(deletedKeys).toEqual([]);
    });

    it('executes the shared canonical reference contract', async () => {
        const references = new Set<string>();
        const deleted: string[] = [];
        await verifyStorageReferenceContract({
            name: 's3',
            async put() {},
            async reference(hash) { references.add(hash); },
            async collect() {
                for (const hash of [HASH, `sha256:${'b'.repeat(64)}`]) {
                    const objectKey = `ws1/${hash}`;
                    const markerKey = `${objectKey}.meta.json`;
                    const harness = makeGcAdapter({
                        listedKeys: [[objectKey, markerKey]],
                        existingKeys: [objectKey, markerKey],
                        canonical: (kind, candidate) =>
                            kind === 'reference_edges' && references.has(
                                candidate === HASH ? 'live' : 'orphan'
                            ),
                    });
                    await harness.adapter.gc({} as H3Event, {
                        workspace_id: 'ws1', retention_seconds: 1, limit: 10,
                    });
                    if (harness.deletedKeys.length > 0) deleted.push(hash === HASH ? 'live' : 'orphan');
                }
                return deleted;
            },
        });
    });
});
