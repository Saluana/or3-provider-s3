import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, ListObjectVersionsCommand, DeleteObjectCommand, DeleteBucketCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb } from '#sqlite-runtime/server/db/kysely';
import { runMigrations } from '#sqlite-runtime/server/db/migrate';
import { SqliteExternalStorageGenerationUploadCoordinator } from '#sqlite-runtime/server/storage/sqlite-generation-upload-coordinator';
import { S3GenerationStore, type S3GenerationSpec } from '../src/runtime/server/storage/s3-generations';
import { createS3GenerationGateway } from '../src/runtime/server/storage/s3-generation-gateway';
import { createApp, eventHandler, readBody, getHeader, toWebHandler, type H3Event } from 'h3';
import { SqliteSyncGatewayAdapter } from '#sqlite-runtime/server/sync/sqlite-sync-gateway-adapter';

// Only identity resolution is replaced. Authorization, canonical queries,
// transaction guards, upload bytes and S3 signatures are real.
vi.mock('~~/server/auth/session', () => ({ resolveSessionContext: async (event: H3Event) => ({
    authenticated: getHeader(event, 'x-user') !== 'anonymous', user: { id: getHeader(event, 'x-user') ?? 'owner' },
    workspace: { id: 'workspace' }, role: getHeader(event, 'x-role') ?? 'owner',
}) }));

// This named network lane fails when not configured; it is never silently skipped.
const envPath = process.env.OR3_GENERATION_TEST_ENV;
if (!envPath) throw new Error('Set OR3_GENERATION_TEST_ENV to a private S3 environment file.');
const env = parseEnv(await readFile(resolve(envPath), 'utf8'));
const client = new S3Client({ endpoint: env.OR3_STORAGE_S3_ENDPOINT, region: env.OR3_STORAGE_S3_REGION || 'us-east-1', forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', maxAttempts: 1,
    credentials: { accessKeyId: env.OR3_STORAGE_S3_ACCESS_KEY_ID!, secretAccessKey: env.OR3_STORAGE_S3_SECRET_ACCESS_KEY! } });
const bucket = `or3-generation-paired-${randomUUID().replaceAll('-', '')}`;
let created = false;
let directory: string;
let store: S3GenerationStore;
let coordinator: SqliteExternalStorageGenerationUploadCoordinator;
let raw: ReturnType<typeof getRawDb>;
let spec: S3GenerationSpec;
const bytes = Buffer.from('verified immutable generation');
let key: { workspaceId: string; hash: string; generationId: string; intentId: string; userId: string };

beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket })); created = true;
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
});
afterAll(async () => {
    try {
        if (created) {
            for (let page = 0; page < 20; page++) {
                const result = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 100 }));
                const objects = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])];
                if (!objects.length) { expect(result.IsTruncated).toBe(false); break; }
                for (const object of objects) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key!, VersionId: object.VersionId! }));
            }
            await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
    } finally { client.destroy(); }
});
beforeEach(async () => {
    _resetForTest();
    directory = await mkdtemp(join(tmpdir(), 'or3-s3-generation-'));
    const db = await initializeSqliteDb({ path: join(directory, 'canonical.sqlite'), driver: 'better-sqlite3', journalMode: 'WAL', synchronous: 'FULL' });
    await runMigrations(db); raw = getRawDb();
    coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 's3' });
    store = new S3GenerationStore({ client, bucket, namespaceId: randomUUID(), enabled: true, cleanupEnabled: true });
    spec = { workspaceId: 'workspace', generationId: randomUUID(), hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length, mimeType: 'text/plain' };
    key = { ...spec, intentId: randomUUID(), userId: 'owner' };
});
afterEach(async () => { await destroySqliteDb(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function reserve(expiresInSeconds = 60) {
    const intent = await coordinator.reserveGenerationUpload({ ...key, namespaceId: store.namespaceId, storageId: store.storageId(spec), mimeType: spec.mimeType, sizeBytes: spec.sizeBytes, expiresInSeconds });
    const ready = await store.allocate(spec);
    await coordinator.markGenerationUploadReady({ ...key, storageId: ready.storageId, readyReceiptId: ready.readyReceiptId });
    return { intent: intent.intent, ready, signed: await store.presignUpload(spec, 60) };
}
async function publish() {
    const reserved = await reserve();
    expect((await fetch(reserved.signed.url, { method: 'PUT', headers: reserved.signed.headers, body: bytes })).ok).toBe(true);
    const receipt = await store.verifyPublication(spec);
    await coordinator.publishGenerationUpload({ ...key, ...receipt });
    return { ...reserved, receipt };
}
function metadata(deleted = false) {
    const hash = spec.hash.slice(7);
    raw.prepare('INSERT INTO s_file_meta(workspace_id,id,data_json,deleted) VALUES (?,?,?,?)')
        .run(spec.workspaceId, hash, JSON.stringify({ hash, storage_id: store.storageId(spec), size_bytes: bytes.length, mime_type: spec.mimeType }), Number(deleted));
}

it('is disabled by default, including cleanup, before any external work', async () => {
    const disabled = new S3GenerationStore({ client, bucket, namespaceId: randomUUID() });
    await expect(disabled.allocate(spec)).rejects.toThrow('disabled');
    const noCleanup = new S3GenerationStore({ client, bucket, namespaceId: randomUUID(), enabled: true });
    await expect(noCleanup.removeGeneration(spec, 'claim', coordinator)).rejects.toThrow('disabled');
});

// The shared fixture is versioned: only a separate real unversioned bucket
// can prove allocation refuses that unsafe configuration before publishing bytes.
it('refuses unversioned buckets without publishing generation objects', async () => {
    const unversionedBucket = `or3-generation-unversioned-${randomUUID().replaceAll('-', '')}`;
    await client.send(new CreateBucketCommand({ Bucket: unversionedBucket }));
    try {
        const unversioned = new S3GenerationStore({ client, bucket: unversionedBucket, namespaceId: randomUUID(), enabled: true });
        await expect(unversioned.allocate(spec)).rejects.toThrow('versioning');
        const objects = await client.send(new ListObjectsV2Command({ Bucket: unversionedBucket, MaxKeys: 100 }));
        expect(objects.Contents ?? []).toEqual([]);
    } finally {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: unversionedBucket, MaxKeys: 100 }));
        expect(objects.IsTruncated).not.toBe(true);
        for (const object of objects.Contents ?? []) await client.send(new DeleteObjectCommand({ Bucket: unversionedBucket, Key: object.Key! }));
        await client.send(new DeleteBucketCommand({ Bucket: unversionedBucket }));
    }
});

it('freezes verified bytes, replays commit, and excludes concurrent/replayed uploads', async () => {
    const { signed } = await reserve();
    const responses = await Promise.all([0, 1].map(() => fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 412]);
    const receipt = await store.verifyPublication(spec);
    expect(await store.verifyPublication(spec)).toEqual(receipt);
    await coordinator.publishGenerationUpload({ ...key, ...receipt });
    const url = await store.presignDownload(spec, 60);
    expect(new URL(url).searchParams.get('versionId')).toBe(receipt.versionId);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(bytes);
    await expect(store.allocate({ ...spec, hash: 'md5:' + 'a'.repeat(32) })).rejects.toThrow('SHA-256');
    await expect(store.resolveStorageId(store.storageId(spec), 'other-workspace', spec.hash, spec.sizeBytes, spec.mimeType)).rejects.toThrow();
});

it('requires the exact durable canonical claim and protects live metadata', async () => {
    await publish(); metadata();
    await expect(store.removeGeneration(spec, 'forged', coordinator)).rejects.toThrow('claim');
    expect((await coordinator.claimGeneration({ ...key, claimId: 'claimed', retentionSeconds: 0 })).status).toBe('blocked');
    expect((await fetch(await store.presignDownload(spec, 60))).ok).toBe(true);
});

it('keeps a permanent upload fence through deletion/retry and preserves a successor', async () => {
    const first = await publish(); metadata();
    raw.exec('UPDATE s_file_meta SET deleted=1');
    expect((await coordinator.claimGeneration({ ...key, claimId: 'claimed', retentionSeconds: 0 })).status).toBe('claimed');
    await store.removeGeneration(spec, 'claimed', coordinator);
    // Simulate a crash after object removal but before canonical acknowledgement.
    await store.removeGeneration(spec, 'claimed', coordinator);
    await coordinator.completeDeletion({ ...key, claimId: 'claimed' });
    expect((await fetch(first.signed.url, { method: 'PUT', headers: first.signed.headers, body: bytes })).status).toBe(412);
    await expect(store.verifyPublication(spec)).rejects.toThrow();
    expect(() => raw.prepare('UPDATE s_file_meta SET deleted=0').run()).toThrow();
    const old = spec;
    spec = { ...old, generationId: randomUUID() };
    key = { ...key, generationId: spec.generationId, intentId: randomUUID() };
    await publish();
    await store.removeGeneration(old, 'claimed', coordinator);
    expect(Buffer.from(await (await fetch(await store.presignDownload(spec, 60))).arrayBuffer())).toEqual(bytes);
});

it('refuses unsafe SQLite claim reads without deleting object bytes', async () => {
    const { receipt } = await publish(); metadata();
    raw.exec('UPDATE s_file_meta SET deleted=1');
    await coordinator.claimGeneration({ ...key, claimId: 'claimed', retentionSeconds: 0 });
    raw.exec('PRAGMA synchronous=NORMAL');
    await expect(store.removeGeneration(spec, 'claimed', coordinator)).rejects.toThrow();
    expect((await client.send(new HeadObjectCommand({ Bucket: bucket, Key: store.storageId(spec), VersionId: receipt.versionId }))).ContentLength).toBe(bytes.length);
});

it('authorizes HTTP controls, binds commit ownership, verifies downloads and reserves restores', async () => {
    const gateway = createS3GenerationGateway({ enabled: true, resolve: () => ({ store, coordinator,
        sync: new SqliteSyncGatewayAdapter(), namespaceId: store.namespaceId, syncProviderId: 'sqlite' }) });
    const app = createApp();
    app.use('/upload', eventHandler(async event => gateway.adapter.presignUpload(event, await readBody(event))));
    app.use('/commit', eventHandler(async event => { await gateway.adapter.commit!(event, await readBody(event)); return { ok: true }; }));
    app.use('/download', eventHandler(async event => gateway.adapter.presignDownload(event, await readBody(event))));
    app.use('/restore', eventHandler(async event => gateway.reserveRestore(event, await readBody(event))));
    const local = toWebHandler(app);
    const request = (path: string, body: unknown, headers = {}) => local(new Request('http://localhost' + path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
    expect((await request('/upload', spec, { 'x-user': 'anonymous' })).status).toBe(401);
    expect((await request('/upload', spec, { 'x-role': 'viewer' })).status).toBe(403);
    expect((await request('/upload', { ...spec, workspaceId: 'foreign' })).status).toBe(403);
    const response = await request('/upload', spec);
    expect(response.status, await response.clone().text()).toBe(200);
    const signed = await response.json();
    expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes })).ok).toBe(true);
    spec = await store.resolveStorageId(signed.storageId, spec.workspaceId, spec.hash, spec.sizeBytes, spec.mimeType);
    const commit = { workspace_id: spec.workspaceId, hash: spec.hash, storage_id: signed.storageId, intent_id: signed.intentId,
        storage_provider_id: 's3', mime_type: spec.mimeType, size_bytes: spec.sizeBytes };
    expect((await request('/commit', commit, { 'x-user': 'other-owner' })).status).toBe(404);
    expect((await request('/commit', commit)).status).toBe(200);
    metadata();
    const download = await request('/download', { ...spec, verifyContent: true });
    expect(download.status, await download.clone().text()).toBe(200);
    const result = await download.json();
    expect(result.verifiedContent).toEqual({ hash: spec.hash, sizeBytes: bytes.length });
    expect(Buffer.from(await (await fetch(result.url)).arrayBuffer())).toEqual(bytes);
    raw.exec('UPDATE s_file_meta SET deleted=1');
    expect((await request('/download', spec)).status).toBe(404);
    const restored = await request('/restore', { ...spec, storageId: signed.storageId, workspaceQuotaBytes: bytes.length });
    expect(restored.status, await restored.clone().text()).toBe(200);
    raw.exec('UPDATE s_file_meta SET deleted=0');
    expect((await request('/download', spec)).status).toBe(200);
    await expect(gateway.reclaim(spec, { retentionSeconds: 0, claimId: 'disabled' })).rejects.toThrow();
});

it('keeps physical quota charged through abandonment and releases it only on removal acknowledgement', async () => {
    const reserved = await reserve(1);
    expect((await fetch(reserved.signed.url, { method: 'PUT', headers: reserved.signed.headers, body: bytes })).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const claimKey = { ...key, claimId: 'abandon-claim' };
    expect((await coordinator.claimAbandonedGenerationUpload({ ...claimKey, retentionSeconds: 0 })).status).toBe('claimed');
    const next = { ...key, hash: 'sha256:' + 'b'.repeat(64), generationId: randomUUID(), intentId: randomUUID(),
        namespaceId: store.namespaceId, storageId: 'next-generation', mimeType: 'text/plain', sizeBytes: bytes.length,
        expiresInSeconds: 60, workspaceQuotaBytes: bytes.length };
    await expect(coordinator.reserveGenerationUpload(next)).rejects.toThrow('quota');
    await store.removeAbandoned(spec, claimKey, coordinator);
    await expect(coordinator.reserveGenerationUpload(next)).rejects.toThrow('quota');
    await coordinator.completeGenerationUploadAbandonment(claimKey);
    expect((await coordinator.reserveGenerationUpload(next)).status).toBe('reserved');
});

it('charges Trash, refuses legacy adoption and prevents replacement until confirmed removal', async () => {
    await publish(); metadata(); raw.exec('UPDATE s_file_meta SET deleted=1');
    const next = { ...key, generationId: randomUUID(), intentId: randomUUID(), namespaceId: store.namespaceId,
        storageId: 'next-generation', mimeType: 'text/plain', sizeBytes: bytes.length, expiresInSeconds: 60, workspaceQuotaBytes: bytes.length };
    await expect(coordinator.reserveGenerationUpload({ ...next, hash: 'sha256:' + 'b'.repeat(64) })).rejects.toThrow('quota');
    await coordinator.claimGeneration({ ...key, claimId: 'claimed', retentionSeconds: 0 });
    await expect(coordinator.reserveGenerationUpload(next)).rejects.toThrow();
    await store.removeGeneration(spec, 'claimed', coordinator);
    await coordinator.completeDeletion({ ...key, claimId: 'claimed' });
    expect((await coordinator.reserveGenerationUpload(next)).status).toBe('reserved');
    raw.prepare('INSERT INTO retained_storage(workspace_id,hash,size_bytes) VALUES (?,?,?)').run('workspace', 'c'.repeat(64), 1);
    await expect(coordinator.reserveGenerationUpload({ ...next, intentId: randomUUID(), generationId: randomUUID(),
        storageId: 'legacy-adoption', hash: 'sha256:' + 'c'.repeat(64), workspaceQuotaBytes: undefined })).rejects.toThrow('legacy');
});

it('recovers an expired upload without restoring its upload authority', async () => {
    const reserved = await reserve(1);
    expect((await fetch(reserved.signed.url, { method: 'PUT', headers: reserved.signed.headers, body: bytes })).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const gateway = createS3GenerationGateway({ enabled: true, cleanupEnabled: true, resolve: () => ({ store, coordinator,
        sync: new SqliteSyncGatewayAdapter(), namespaceId: store.namespaceId, syncProviderId: 'sqlite' }) });
    const recovered = await gateway.recover({ workspaceId: spec.workspaceId, retentionSeconds: 0, limit: 1 });
    expect(recovered.items.map(item => item.status)).toEqual(['abandoned']);
    expect((await fetch(reserved.signed.url, { method: 'PUT', headers: reserved.signed.headers, body: bytes })).status).toBe(412);
    expect((await coordinator.getGenerationUpload(key))?.state).toBe('abandoned');
});
