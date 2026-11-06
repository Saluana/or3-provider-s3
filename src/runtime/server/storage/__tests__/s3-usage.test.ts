import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { H3Event } from 'h3';
import { s3StorageAdminAdapter } from '../../admin/adapters/storage-s3';

// Failures: cross-workspace listing, mistaken ownership after restore, unknown
// retained sizes reported as zero, unbounded/repeated cursors, or destructive I/O.
const mocks = vi.hoisted(() => ({ send: vi.fn(), query: vi.fn(), sync: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async importOriginal => ({
    ...await importOriginal<typeof import('@aws-sdk/client-s3')>(),
    S3Client: class { send = mocks.send; },
}));
vi.mock('~~/server/sync/gateway/registry', () => ({ getActiveSyncGatewayAdapter: mocks.sync }));
const hashes = ['a', 'b', 'c'].map(c => `sha256:${c.repeat(64)}`);
const prefix = 'test/ws1/';
const context = { session: { workspace: { id: 'ws1' } } };
async function observe(payload?: Record<string, unknown>) {
    return s3StorageAdminAdapter.runAction!({} as H3Event, 'storage.usage', payload, context as never) as Promise<{
        canonical: { activeMetadataBytes: number | null; retainedDeletedMetadataBytes: number | null; reservedUploadBytes: number | null };
        objectStore: { complete: boolean; objectBytes: number | null; categories: Record<string, { files: number; apparentBytes: number | null }> };
        warnings: string[];
    }>;
}

beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, { OR3_STORAGE_S3_REGION: 'us-east-1', OR3_STORAGE_S3_BUCKET: 'bucket',
        OR3_STORAGE_S3_ACCESS_KEY_ID: 'fixture', OR3_STORAGE_S3_SECRET_ACCESS_KEY: 'fixture', OR3_STORAGE_S3_KEY_PREFIX: 'test/' });
    (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({ auth: { enabled: true }, storage: { enabled: true, provider: 's3' } });
    mocks.sync.mockReturnValue({ capabilities: { retainedStorageMetadata: 'v1' }, queryCanonicalStorage: mocks.query });
    mocks.query.mockImplementation(async (_event, input) => ({ hasMore: false, items: input.kind === 'live_metadata'
        ? [{ kind: 'metadata', hash: hashes[0], sizeBytes: 3, storageId: prefix + hashes[0] }]
        : input.kind === 'retained_metadata'
            ? [{ kind: 'retained_metadata', hash: hashes[1], sizeBytes: 7, storageId: prefix + hashes[1] }]
            : [{ kind: 'reservation', reservationId: 'intent', hash: hashes[2], sizeBytes: 11, expiresAt: Math.floor(Date.now() / 1000) + 60 }] }));
    mocks.send.mockImplementation(async command => {
        if (!(command instanceof ListObjectsV2Command)) throw new Error('Unexpected storage mutation or unbounded object read');
        return { IsTruncated: false, Contents: [
            { Key: prefix + hashes[0], Size: 3 }, { Key: prefix + hashes[1], Size: 7 },
            { Key: prefix + hashes[1] + '.meta.json', Size: 2 }, { Key: prefix + hashes[2], Size: 4 },
        ] };
    });
});

describe('S3 admin usage observations', () => {
    it('exposes workspace usage and separates canonical bytes from stored objects without mutation', async () => {
        expect((await s3StorageAdminAdapter.getStatus({} as H3Event, {} as never)).actions)
            .toContainEqual(expect.objectContaining({ id: 'storage.usage' }));
        expect(await observe()).toMatchObject({
            canonical: { activeMetadataBytes: 3, retainedDeletedMetadataBytes: 7, reservedUploadBytes: 11 },
            objectStore: { complete: true, objectBytes: 16, categories: {
                activeBlobs: { files: 1, apparentBytes: 3 }, retainedDeletedBlobs: { files: 1, apparentBytes: 7 },
                sidecars: { files: 1, apparentBytes: 2 }, unclassifiedFiles: { files: 1, apparentBytes: 4 },
            } },
        });
        expect(mocks.send.mock.calls[0]![0].input.Prefix).toBe(prefix);
        expect(mocks.query.mock.calls.every(([, input]) => input.scope.workspaceId === 'ws1')).toBe(true);
    });

    it('keeps unknown retained sizes and foreign identities explicit', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({ hasMore: false, items: input.kind === 'retained_metadata'
            ? [{ kind: 'retained_metadata', hash: hashes[1], storageId: 'other/' + hashes[1] }]
            : [] }));
        const result = await observe();
        expect(result.canonical.retainedDeletedMetadataBytes).toBeNull();
        expect(result.objectStore.categories.retainedDeletedBlobs?.files).toBe(0);
        expect(result.objectStore.categories.unclassifiedFiles?.files).toBe(3);
    });

    it.each(['limit', 'cursor', 'foreign', 'denied'])('reports partial object observations for %s', async mode => {
        mocks.send.mockImplementation(async command => {
            if (mode === 'denied') throw new Error('Access denied');
            return { IsTruncated: true, NextContinuationToken: 'repeat', Contents: [
                { Key: (mode === 'foreign' ? 'other/' : prefix) + hashes[0] + (command.input.ContinuationToken ? '.meta.json' : ''), Size: 3 },
            ] };
        });
        const result = await observe(mode === 'limit' ? { limit: 1 } : undefined);
        expect(result.objectStore.complete).toBe(false);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(mocks.send.mock.calls.length).toBeLessThanOrEqual(2);
        if (mode === 'foreign') expect(result.objectStore.objectBytes).toBe(0);
        if (mode === 'denied') expect(result.objectStore.objectBytes).toBeNull();
    });

    it('does not classify blobs when canonical pages repeat or overlap', async () => {
        mocks.query.mockImplementation(async (_event, input) => ({ hasMore: input.kind === 'live_metadata',
            ...(input.kind === 'live_metadata' ? { nextCursor: 'repeat' } : {}),
            items: input.kind === 'active_reservations' ? [] : [{ kind: input.kind === 'live_metadata' ? 'metadata' : 'retained_metadata',
                hash: hashes[0], sizeBytes: 3, storageId: prefix + hashes[0] }] }));
        const result = await observe();
        expect(result.canonical.activeMetadataBytes).toBeNull();
        expect(result.objectStore.categories.activeBlobs?.files).toBe(0);
        expect(result.objectStore.categories.retainedDeletedBlobs?.files).toBe(0);
        expect(mocks.query.mock.calls.length).toBeLessThanOrEqual(4);
    });
});
