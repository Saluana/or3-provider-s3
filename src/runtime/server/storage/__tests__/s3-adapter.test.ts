import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import {
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { S3StorageGatewayAdapter } from '../s3-storage-gateway-adapter';

const HASH = `sha256:${'a'.repeat(64)}`;
const HASH_2 = `sha256:${'b'.repeat(64)}`;

const signedUrlMock = vi.hoisted(() => vi.fn(async () => 'https://signed.example'));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: signedUrlMock,
}));

function makeAdapter(overrides: Partial<ConstructorParameters<typeof S3StorageGatewayAdapter>[0]> = {}) {
    const send = vi.fn(async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
            return { ContentLength: 3, ContentType: 'image/png', ETag: '"etag"' };
        }
        if (command instanceof PutObjectCommand) {
            return {};
        }
        if (command instanceof DeleteObjectCommand) {
            return {};
        }
        if (command instanceof ListObjectsV2Command) {
            return { IsTruncated: false, Contents: [] };
        }
        if (command instanceof DeleteObjectsCommand) {
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
        expect(result.storageId).toBe(`ws1/${HASH}`);
        expect(result.expiresAt).toBe(1_000_000 + 5 * 1000);
        expect(signedUrlMock).toHaveBeenCalled();
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

    it('rejects download when provided storage_id mismatches derived key', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.presignDownload({} as H3Event, {
            workspaceId: 'ws1',
            hash: HASH,
            storageId: `ws2/${HASH}`,
        })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('commit validates head and writes marker', async () => {
        const { adapter, send } = makeAdapter();
        await adapter.commit({} as H3Event, {
            workspace_id: 'ws1',
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

    it('gc deletes stale uncommitted objects', async () => {
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof ListObjectsV2Command) {
                return {
                    IsTruncated: false,
                    Contents: [
                        { Key: `ws1/${HASH}`, LastModified: new Date(1) },
                    ],
                };
            }
            if (command instanceof DeleteObjectsCommand) {
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
                now: () => 10_000,
            }
        );

        const result = await adapter.gc({} as H3Event, {
            workspace_id: 'ws1',
            retention_seconds: 1,
            limit: 10,
        });

        expect(result.deleted_count).toBe(1);
        expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectsCommand));
    });

    it('gc stops paging when combined stale candidates already satisfy limit', async () => {
        const send = vi.fn(async (command: unknown) => {
            if (command instanceof ListObjectsV2Command) {
                if (!command.input.ContinuationToken) {
                    return {
                        IsTruncated: true,
                        NextContinuationToken: 'next-token',
                        Contents: [
                            { Key: `ws1/${HASH_2}`, LastModified: new Date(1) },
                            { Key: 'ws1/missing.meta.json', LastModified: new Date(1) },
                        ],
                    };
                }
                return {
                    IsTruncated: false,
                    Contents: [
                        { Key: 'ws1/extra', LastModified: new Date(1) },
                    ],
                };
            }
            if (command instanceof DeleteObjectsCommand) {
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
                now: () => 10_000,
            }
        );

        const result = await adapter.gc({} as H3Event, {
            workspace_id: 'ws1',
            retention_seconds: 1,
            limit: 2,
        });

        const listCalls = send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command);
        expect(listCalls).toHaveLength(1);
        expect(result.deleted_count).toBe(2);
    });
});
