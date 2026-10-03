import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import {
    HeadObjectCommand,
    type HeadObjectCommandOutput,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { S3StorageGatewayAdapter } from '../s3-storage-gateway-adapter';

const HASH = `sha256:${'a'.repeat(64)}`;
const CHECKSUM = Buffer.from('a'.repeat(64), 'hex').toString('base64');
const INTENT_ID = 'intent-1';

const signedUrlMock = vi.hoisted(() => vi.fn(async () => 'https://signed.example'));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: signedUrlMock,
}));

function makeAdapter(overrides: Partial<ConstructorParameters<typeof S3StorageGatewayAdapter>[0]> = {}) {
    const send = vi.fn(async (command: unknown): Promise<Partial<HeadObjectCommandOutput>> => {
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

    it('allows a zero-byte upload', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.presignUpload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            mimeType: 'application/octet-stream',
            sizeBytes: 0,
        })).resolves.toMatchObject({ method: 'PUT', storageId: `ws1/${HASH}` });
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

    it('presigns download with canonical safe response headers', async () => {
        const { adapter } = makeAdapter();
        const result = await adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            disposition: 'attachment',
            mimeType: 'text/html',
            filename: '../../evil\r\n.html',
            expiresInMs: 1000,
        });

        expect(result.method).toBe('GET');
        expect(result.storageId).toBe(`ws1/${HASH}`);
        expect(result.expiresAt).toBe(1_000_000 + 1 * 1000);
        expect(signedUrlMock).toHaveBeenCalled();
        const command = (signedUrlMock.mock.calls.at(-1) as unknown[])[1] as GetObjectCommand;
        expect(command.input.ResponseContentType).toBe('application/octet-stream');
        expect(command.input.ResponseContentDisposition).toBe(
            "attachment; filename*=UTF-8''.._.._evil__.html",
        );
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

    it('blocks deletion of an existing blob or marker without coordination', async () => {
        const { adapter, send } = makeAdapter();
        await expect(adapter.deleteObject({} as H3Event, {
            workspaceId: 'ws1', hash: HASH, storageId: `ws1/${HASH}`,
        })).rejects.toMatchObject({ statusCode: 503 });
        expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
    });

    it('succeeds for an already absent blob and marker but propagates verification errors', async () => {
        const { adapter, send } = makeAdapter();
        send.mockRejectedValue(Object.assign(new Error('missing'), { name: 'NotFound' }));
        await expect(adapter.deleteObject({} as H3Event, { workspaceId: 'ws1', hash: HASH }))
            .resolves.toBeUndefined();
        send.mockRejectedValue(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } }));
        await expect(adapter.deleteObject({} as H3Event, { workspaceId: 'ws1', hash: HASH }))
            .rejects.toMatchObject({ statusCode: 502 });
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

    it('commit retrieves the stored checksum before writing the marker', async () => {
        const { adapter, send } = makeAdapter();
        const originalSend = send.getMockImplementation()!;
        send.mockImplementation(async (command: unknown) => {
            const result = await originalSend(command);
            if (command instanceof HeadObjectCommand && command.input.ChecksumMode !== 'ENABLED') {
                return { ...result, ChecksumSHA256: undefined };
            }
            return result;
        });
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

    it('commit rejects uploads missing content length without deleting the stored blob', async () => {
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

        expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
    });

    it('commit rejects uploads missing content type without deleting the stored blob', async () => {
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

        expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
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

    it.each([false, true])('gc is disabled even with canonical queries available=%s', async (canonicalAvailable) => {
        const { adapter, send } = makeAdapter();
        const queryCanonicalStorage = vi.fn(async () => ({ items: [], hasMore: false }));
        const gcAdapter = new S3StorageGatewayAdapter({
            region: 'us-east-1', bucket: 'bucket', accessKeyId: 'ak', secretAccessKey: 'sk',
            forcePathStyle: false, keyPrefix: '', urlTtlSeconds: 900, requireChecksum: true,
        }, { client: { send }, getSyncGateway: () => canonicalAvailable ? { queryCanonicalStorage } : undefined });
        expect(await gcAdapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: 1, limit: 10,
        })).toEqual({ deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' });
        expect(send).not.toHaveBeenCalled();
        expect(queryCanonicalStorage).not.toHaveBeenCalled();
        await expect(adapter.gc({} as H3Event, {
            workspace_id: '../other', retention_seconds: 1,
        })).rejects.toMatchObject({ statusCode: 400 });
        await expect(adapter.gc({} as H3Event, {
            workspace_id: 'ws1', retention_seconds: -1,
        })).rejects.toMatchObject({ statusCode: 400 });
    });
});
