/** Bounded, read-only observations of current objects, never a deletion authority. */
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { H3Event } from 'h3';
import type { SyncGatewayAdapter } from '~~/server/sync/gateway/types';
import { assertValidWorkspaceId, buildS3ObjectKey, requireS3Hash } from './s3-keys';

const PAGE_SIZE = 250;
const MAX_PAGES = 100;
const MAX_OBJECTS = 10_000;
type Category = { files: number; apparentBytes: number | null };
type Observation = { bytes: number | null; complete: boolean; hashes: Map<string, boolean> };

function sum(left: number | null, right: number): number | null {
    return left !== null && Number.isSafeInteger(right) && right >= 0 && Number.isSafeInteger(left + right) ? left + right : null;
}

export async function observeS3StorageUsage(
    event: H3Event, workspaceId: string, config: { bucket: string; keyPrefix: string },
    client: Pick<S3Client, 'send'>,
    sync: Pick<SyncGatewayAdapter, 'capabilities' | 'queryCanonicalStorage'> | undefined,
    payload?: Record<string, unknown>,
) {
    assertValidWorkspaceId(workspaceId);
    const startedAt = new Date().toISOString();
    const now = Math.floor(Date.now() / 1000);
    const warnings = new Set<string>();
    const prefix = `${config.keyPrefix}${workspaceId}/`;
    async function canonical(kind: 'live_metadata' | 'retained_metadata' | 'active_reservations'): Promise<Observation> {
        const result: Observation = { bytes: null, complete: false, hashes: new Map() };
        if (!sync?.queryCanonicalStorage || (kind === 'retained_metadata' && sync.capabilities?.retainedStorageMetadata !== 'v1')) {
            warnings.add(`canonical_${kind}_unsupported`);
            return result;
        }
        let bytes: number | null = 0;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const identities = new Set<string>();
        try {
            for (let page = 0; page < MAX_PAGES; page++) {
                const response = await sync.queryCanonicalStorage(event, { scope: { workspaceId }, kind, cursor, limit: PAGE_SIZE, now });
                if (!response || !Array.isArray(response.items) || response.items.length > PAGE_SIZE || typeof response.hasMore !== 'boolean') throw new Error('Invalid page');
                for (const item of response.items) {
                    const record = item as unknown as Record<string, unknown>;
                    const expected = kind === 'live_metadata' ? 'metadata' : kind === 'retained_metadata' ? 'retained_metadata' : 'reservation';
                    if (!record || record.kind !== expected || typeof record.hash !== 'string') throw new Error('Invalid record');
                    const hash = requireS3Hash(record.hash);
                    const identity = kind === 'active_reservations' ? record.reservationId : hash;
                    if (typeof identity !== 'string' || !identity || identities.has(identity)) throw new Error('Duplicate identity');
                    identities.add(identity);
                    if (kind === 'active_reservations') {
                        if (typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) throw new Error('Invalid expiry');
                        if (record.expiresAt <= now) continue;
                    }
                    const matches = record.storageId === buildS3ObjectKey({ keyPrefix: config.keyPrefix, workspaceId, hash });
                    if (kind !== 'active_reservations' && !matches) warnings.add(`canonical_${kind}_storage_identity_unknown_or_mismatched`);
                    result.hashes.set(hash, matches);
                    if (kind === 'retained_metadata' && record.sizeBytes === undefined) {
                        bytes = null;
                        warnings.add('canonical_retained_metadata_unknown_size');
                    } else {
                        if (typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) throw new Error('Invalid size');
                        const total = sum(bytes, record.sizeBytes);
                        if (bytes !== null && total === null) throw new Error('Unsafe total');
                        bytes = total;
                    }
                }
                if (!response.hasMore) {
                    if (response.nextCursor !== undefined) throw new Error('Invalid final cursor');
                    return { ...result, bytes, complete: true };
                }
                if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error('Repeated cursor');
                cursors.add(response.nextCursor);
                cursor = response.nextCursor;
            }
            warnings.add(`canonical_${kind}_page_limit`);
        } catch { warnings.add(`canonical_${kind}_unavailable_or_malformed`); }
        return result;
    }
    const active = await canonical('live_metadata');
    const retained = await canonical('retained_metadata');
    const reserved = await canonical('active_reservations');
    const categories = {
        activeBlobs: { files: 0, apparentBytes: 0 } as Category,
        retainedDeletedBlobs: { files: 0, apparentBytes: 0 } as Category,
        sidecars: { files: 0, apparentBytes: 0 } as Category,
        unclassifiedFiles: { files: 0, apparentBytes: 0 } as Category,
    };
    const objectStore = { complete: false, scannedObjects: 0, objectBytes: null as number | null, categories };
    const limit = typeof payload?.limit === 'number' && Number.isFinite(payload.limit) && payload.limit >= 1
        ? Math.min(MAX_OBJECTS, Math.floor(payload.limit)) : MAX_OBJECTS;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const keys = new Set<string>();
    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const remaining = limit - objectStore.scannedObjects;
            if (!remaining) { warnings.add('object_entry_limit'); break; }
            const result = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix,
                MaxKeys: Math.min(PAGE_SIZE, remaining), ContinuationToken: cursor }));
            objectStore.objectBytes ??= 0;
            if ((result.Contents?.length ?? 0) > Math.min(PAGE_SIZE, remaining)) throw new Error('Oversized page');
            for (const object of result.Contents ?? []) {
                if (!object.Key?.startsWith(prefix) || keys.has(object.Key) || !Number.isSafeInteger(object.Size) || object.Size! < 0) throw new Error('Invalid object');
                keys.add(object.Key);
                objectStore.scannedObjects++;
                objectStore.objectBytes = sum(objectStore.objectBytes, object.Size!);
                const name = object.Key.slice(prefix.length);
                const hashMatch = /^(?:sha256:[a-f0-9]{64}|md5:[a-f0-9]{32})$/.test(name);
                let category = categories.unclassifiedFiles;
                if (/^(?:sha256:[a-f0-9]{64}|md5:[a-f0-9]{32})\.meta\.json$/.test(name)) category = categories.sidecars;
                else if (hashMatch && active.complete && retained.complete) {
                    if (active.hashes.has(name) && retained.hashes.has(name)) warnings.add('canonical_metadata_overlap');
                    else if (active.hashes.get(name)) category = categories.activeBlobs;
                    else if (retained.hashes.get(name)) category = categories.retainedDeletedBlobs;
                }
                category.files++;
                category.apparentBytes = sum(category.apparentBytes, object.Size!);
                if (objectStore.objectBytes === null || category.apparentBytes === null) throw new Error('Unsafe total');
            }
            if (result.IsTruncated === false) { objectStore.complete = true; break; }
            if (result.IsTruncated !== true || !result.NextContinuationToken || cursors.has(result.NextContinuationToken)) throw new Error('Invalid cursor');
            cursors.add(result.NextContinuationToken);
            cursor = result.NextContinuationToken;
        }
        if (!objectStore.complete && !warnings.has('object_entry_limit')) warnings.add('object_page_limit');
    } catch { warnings.add('object_listing_unavailable_or_malformed'); }
    return {
        startedAt, completedAt: new Date().toISOString(), consistency: 'non_atomic_observation',
        canonical: { activeMetadataBytes: active.bytes, retainedDeletedMetadataBytes: retained.bytes, reservedUploadBytes: reserved.bytes,
            complete: { activeMetadata: active.complete, retainedDeletedMetadata: retained.complete, reservedUploads: reserved.complete } },
        objectStore, warnings: [...warnings],
        // ListObjectsV2 sees current objects, not billed capacity, old versions,
        // incomplete multipart uploads or the host's physical allocation.
        coverage: 'current_object_versions_only',
    };
}
