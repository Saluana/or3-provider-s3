/** Dormant trusted-host factory. No route, registry or configuration selects it.
 * Existing host routes must retain their origin, rate-limit and MIME guards.
 * Recovery/cleanup are server-only and require separate explicit activation.
 */
import { randomUUID } from 'node:crypto';
import { createError, type H3Event } from 'h3';
import { requireCan } from '~~/server/auth/can';
import { resolveSessionContext } from '~~/server/auth/session';
import { resolveDownloadPolicy } from '~~/server/utils/storage/download-policy';
import { requireExternalStorageGenerationUploadCoordinator } from '~~/server/utils/storage/generation-upload-coordination';
import type { StorageGatewayAdapter } from '~~/server/storage/gateway/types';
import type { SyncGatewayAdapter } from '~~/server/sync/gateway/types';
import type { ExternalStorageGenerationUploadIntent } from '~~/server/storage/gateway/generation-upload';
import { S3GenerationStore, type S3GenerationSpec } from './s3-generations';
import { requireS3Hash } from './s3-keys';

interface Dependencies {
    store: S3GenerationStore;
    coordinator: unknown;
    sync: Pick<SyncGatewayAdapter, 'id' | 'queryCanonicalStorage'>;
    namespaceId: string;
    syncProviderId: string;
    maxUploadBytes?: number;
    uploadLifetimeSeconds?: number;
}
const clock = () => Math.floor(Date.now() / 1000);
function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }); }
function hash(value: string) {
    const result = requireS3Hash(value);
    if (!result.startsWith('sha256:')) fail(400, 'A SHA-256 identity is required');
    return result;
}
async function user(event: H3Event, workspaceId: string, permission: 'workspace.read' | 'workspace.write') {
    const session = await resolveSessionContext(event);
    if (!session.authenticated || !session.user) fail(401, 'Unauthorized');
    requireCan(session, permission, { kind: 'workspace', id: workspaceId });
    return session.user.id;
}
function ttl(milliseconds: number | undefined, maximum: number) {
    if (milliseconds !== undefined && (!Number.isFinite(milliseconds) || milliseconds < 1000)) fail(400, 'Invalid credential lifetime');
    return Math.min(maximum, milliseconds === undefined ? maximum : Math.floor(milliseconds / 1000));
}
export function createS3GenerationGateway(options: { enabled?: boolean; cleanupEnabled?: boolean; resolve: () => Dependencies }) {
    function dependencies(cleanup = false) {
        if (options.enabled !== true || (cleanup && options.cleanupEnabled !== true)) fail(404, 'Generation operation disabled');
        const deps = options.resolve();
        if (deps.store.namespaceId !== deps.namespaceId || deps.sync.id !== deps.syncProviderId || !deps.sync.queryCanonicalStorage) fail(503, 'Canonical provider pair unavailable');
        const coordinator = requireExternalStorageGenerationUploadCoordinator(deps.coordinator, 's3');
        if ((coordinator as { retainedGenerationQuotaVersion?: number }).retainedGenerationQuotaVersion !== 1) fail(503, 'Retained generation accounting unavailable');
        const maxBytes = deps.maxUploadBytes ?? 100 * 1024 * 1024;
        const lifetime = deps.uploadLifetimeSeconds ?? 300;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 900) fail(503, 'Invalid generation limits');
        return { ...deps, coordinator, maxBytes, lifetime };
    }
    type Resolved = ReturnType<typeof dependencies>;
    function binding(deps: Resolved, intent: ExternalStorageGenerationUploadIntent, spec: S3GenerationSpec) {
        if (intent.storageProviderId !== 's3' || intent.namespaceId !== deps.namespaceId || intent.storageId !== deps.store.storageId(spec) ||
            intent.workspaceId !== spec.workspaceId || intent.generationId !== spec.generationId || hash(intent.hash) !== hash(spec.hash) ||
            intent.sizeBytes !== spec.sizeBytes || intent.mimeType !== spec.mimeType) fail(409, 'Generation binding mismatch');
    }
    const adapter: StorageGatewayAdapter = {
        id: 's3',
        async presignUpload(event, input) {
            const deps = dependencies();
            const userId = await user(event, input.workspaceId, 'workspace.write');
            if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > deps.maxBytes) fail(413, 'Invalid upload size');
            const spec = { ...input, hash: hash(input.hash), generationId: randomUUID() };
            const identity = { ...spec, userId, intentId: randomUUID() };
            const storageId = deps.store.storageId(spec);
            const reserved = await deps.coordinator.reserveGenerationUpload({ ...identity, storageId,
                namespaceId: deps.namespaceId, expiresInSeconds: ttl(input.expiresInMs, deps.lifetime), workspaceQuotaBytes: input.workspaceQuotaBytes });
            binding(deps, reserved.intent, spec);
            const ready = await deps.store.allocate(spec);
            const marked = await deps.coordinator.markGenerationUploadReady({ ...identity, storageId, readyReceiptId: ready.readyReceiptId });
            binding(deps, marked.intent, spec);
            const remaining = marked.intent.expiresAt - clock();
            if (marked.intent.state !== 'ready' || marked.intent.purpose !== 'upload' || marked.intent.readyReceiptId !== ready.readyReceiptId || remaining < 1) fail(409, 'Upload reservation unavailable');
            const signed = await deps.store.presignUpload(spec, remaining);
            return { ...signed, storageId, intentId: identity.intentId, method: 'PUT', expiresAt: marked.intent.expiresAt * 1000 };
        },
        async commit(event, input) {
            const deps = dependencies();
            if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid commit');
            const body = input as Record<string, unknown>;
            if (typeof body.workspace_id !== 'string' || typeof body.hash !== 'string' || typeof body.storage_id !== 'string' ||
                typeof body.intent_id !== 'string' || body.storage_provider_id !== 's3' || typeof body.mime_type !== 'string' || typeof body.size_bytes !== 'number') fail(400, 'Invalid generation commit');
            const userId = await user(event, body.workspace_id, 'workspace.write');
            const spec = await deps.store.resolveStorageId(body.storage_id, body.workspace_id, body.hash, body.size_bytes, body.mime_type);
            const identity = { ...spec, userId, intentId: body.intent_id };
            const intent = await deps.coordinator.getGenerationUpload(identity);
            if (!intent) fail(404, 'Upload intent not found');
            binding(deps, intent, spec);
            if (intent.purpose !== 'upload' || intent.expiresAt <= clock() || !['ready', 'published_pending_metadata', 'materialized'].includes(intent.state)) fail(409, 'Upload intent unavailable');
            const receipt = await deps.store.verifyPublication(spec);
            if (receipt.readyReceiptId !== intent.readyReceiptId) fail(409, 'Upload readiness mismatch');
            const result = await deps.coordinator.publishGenerationUpload({ ...identity, ...receipt });
            binding(deps, result.intent, spec);
            if (result.generation.state !== 'verified' || result.generation.storageId !== receipt.storageId) fail(409, 'Publication unavailable');
        },
        async presignDownload(event, input) {
            const deps = dependencies();
            await user(event, input.workspaceId, 'workspace.read');
            const canonicalHash = hash(input.hash);
            const page = await deps.sync.queryCanonicalStorage!(event, { scope: { workspaceId: input.workspaceId }, kind: 'live_metadata', hash: canonicalHash, limit: 2 });
            const metadata = page.items[0];
            if (page.hasMore || page.items.length !== 1 || metadata?.kind !== 'metadata' || hash(metadata.hash) !== canonicalHash ||
                typeof metadata.storageId !== 'string' || (input.storageId !== undefined && metadata.storageId !== input.storageId)) fail(404, 'File not found');
            const spec = await deps.store.resolveStorageId(metadata.storageId, input.workspaceId, canonicalHash, metadata.sizeBytes, metadata.mimeType ?? 'application/octet-stream');
            const generation = await deps.coordinator.getGeneration(spec);
            if (!generation || generation.state !== 'verified' || generation.storageId !== metadata.storageId || generation.sizeBytes !== metadata.sizeBytes) fail(404, 'File not found');
            if (input.verifyContent) await deps.store.verifyPublication(spec);
            const seconds = ttl(input.expiresInMs, deps.lifetime);
            const policy = resolveDownloadPolicy({ fileKind: metadata.fileKind, mimeType: metadata.mimeType, filename: metadata.name,
                requestedDisposition: input.disposition === 'attachment' ? 'attachment' : 'inline' });
            return { url: await deps.store.presignDownload(spec, seconds, policy), method: 'GET', storageId: metadata.storageId,
                expiresAt: (clock() + seconds) * 1000, ...(input.verifyContent ? { verifiedContent: { hash: canonicalHash, sizeBytes: spec.sizeBytes } } : {}) };
        },
    };
    async function reserveRestore(event: H3Event, input: S3GenerationSpec & { storageId: string; workspaceQuotaBytes?: number }) {
        const deps = dependencies();
        const userId = await user(event, input.workspaceId, 'workspace.write');
        const spec = await deps.store.resolveStorageId(input.storageId, input.workspaceId, input.hash, input.sizeBytes, input.mimeType);
        await deps.store.verifyPublication(spec);
        const result = await deps.coordinator.reserveGenerationRestore({ ...spec, userId, intentId: randomUUID(),
            expiresInSeconds: deps.lifetime, workspaceQuotaBytes: input.workspaceQuotaBytes });
        binding(deps, result.intent, spec);
        return { intentId: result.intent.intentId, expiresAt: result.intent.expiresAt * 1000 };
    }
    async function reclaim(spec: S3GenerationSpec, input: { retentionSeconds: number; claimId: string }) {
        const deps = dependencies(true);
        const claim = await deps.coordinator.claimGeneration({ ...spec, ...input });
        if (claim.status === 'blocked') return claim;
        await deps.store.removeGeneration(spec, input.claimId, deps.coordinator);
        return deps.coordinator.completeDeletion({ ...spec, claimId: input.claimId });
    }
    async function recover(input: { workspaceId: string; retentionSeconds: number; cursor?: string; limit?: number }) {
        const deps = dependencies(true);
        if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 0 ||
            (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))) fail(400, 'Invalid recovery bounds');
        const page = await deps.coordinator.listGenerationUploadRecovery({ ...input, limit: input.limit ?? 100 });
        if (page.items.length > (input.limit ?? 100) || (page.hasMore && !page.nextCursor)) fail(502, 'Invalid recovery page');
        const items: { intentId: string; status: string; reason?: string }[] = [];
        for (let intent of page.items) {
            const item = { intentId: intent.intentId, status: 'retained', reason: undefined as string | undefined }; items.push(item);
            try {
                if (intent.workspaceId !== input.workspaceId) fail(409, 'Recovery scope mismatch');
                binding(deps, intent, intent);
                if (intent.state === 'reserved') {
                    const ready = await deps.store.inspectAllocation(intent);
                    if (!ready) { item.reason = 'readiness_unverified'; continue; }
                    intent = (await deps.coordinator.markGenerationUploadReady({ ...intent, readyReceiptId: ready.readyReceiptId })).intent;
                }
                const key = { ...intent, claimId: intent.claimId ?? randomUUID() };
                const claim = await deps.coordinator.claimAbandonedGenerationUpload({ ...key, retentionSeconds: input.retentionSeconds });
                if (claim.status === 'blocked') { item.reason = claim.reason; continue; }
                await deps.store.removeAbandoned(intent, key, deps.coordinator);
                await deps.coordinator.completeGenerationUploadAbandonment(key);
                item.status = 'abandoned';
            } catch { item.status = 'pending'; item.reason = 'recovery_unverified'; }
        }
        return { items, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    return { adapter, reserveRestore, reclaim, recover };
}
