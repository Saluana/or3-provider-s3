import type { H3Event } from 'h3';
import { createError } from 'h3';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { useRuntimeConfig } from '#imports';
import type {
    StorageGatewayAdapter,
    PresignUploadRequest,
    PresignUploadResponse,
    PresignDownloadRequest,
    PresignDownloadResponse,
    DeleteObjectRequest,
} from '~~/server/storage/gateway/types';
import type { SyncGatewayAdapter } from '~~/server/sync/gateway/types';
import { getActiveSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { assertValidWorkspaceId, buildS3MarkerKey, buildS3ObjectKey, sha256HexToBase64Checksum } from './s3-keys';
import { validateS3StorageConfig } from './s3-config';
import { randomUUID } from 'node:crypto';

type CommitInput = {
    workspace_id: string;
    intent_id: string;
    hash: string;
    storage_id: string;
    storage_provider_id: string;
    mime_type: string;
    size_bytes: number;
    name: string;
    kind: 'image' | 'pdf' | 'file';
    width?: number;
    height?: number;
    page_count?: number;
};

type GcInput = {
    workspace_id: string;
    retention_seconds: number;
    limit?: number;
};

function assertObject(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        throw createError({ statusCode: 400, statusMessage: message });
    }
    return value as Record<string, unknown>;
}

function assertString(value: unknown, message: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw createError({ statusCode: 400, statusMessage: message });
    }
    return value;
}

function assertInt(value: unknown, message: string, opts?: { min?: number; optional?: boolean }): number | undefined {
    if (value === undefined) {
        if (opts?.optional) return undefined;
        throw createError({ statusCode: 400, statusMessage: message });
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw createError({ statusCode: 400, statusMessage: message });
    }
    if (opts?.min !== undefined && value < opts.min) {
        throw createError({ statusCode: 400, statusMessage: message });
    }
    return value;
}

function parseCommitInput(input: unknown): CommitInput {
    const obj = assertObject(input, 'Invalid commit payload');
    const kind = assertString(obj.kind, 'Invalid kind');
    if (kind !== 'image' && kind !== 'pdf' && kind !== 'file') {
        throw createError({ statusCode: 400, statusMessage: 'Invalid kind' });
    }

    return {
        workspace_id: assertString(obj.workspace_id, 'Invalid workspace_id'),
        intent_id: assertString(obj.intent_id, 'Invalid intent_id'),
        hash: assertString(obj.hash, 'Invalid hash'),
        storage_id: assertString(obj.storage_id, 'Invalid storage_id'),
        storage_provider_id: assertString(obj.storage_provider_id, 'Invalid storage_provider_id'),
        mime_type: assertString(obj.mime_type, 'Invalid mime_type'),
        size_bytes: assertInt(obj.size_bytes, 'Invalid size_bytes', { min: 0 }) as number,
        name: assertString(obj.name, 'Invalid name'),
        kind,
        width: assertInt(obj.width, 'Invalid width', { min: 1, optional: true }),
        height: assertInt(obj.height, 'Invalid height', { min: 1, optional: true }),
        page_count: assertInt(obj.page_count, 'Invalid page_count', { min: 1, optional: true }),
    };
}

function parseGcInput(input: unknown): GcInput {
    const obj = assertObject(input, 'Invalid gc payload');
    const workspaceId = assertString(obj.workspace_id, 'Invalid workspace_id');
    assertValidWorkspaceId(workspaceId);
    return {
        workspace_id: workspaceId,
        retention_seconds: assertInt(obj.retention_seconds, 'Invalid retention_seconds', { min: 0 }) as number,
        limit: assertInt(obj.limit, 'Invalid limit', { min: 1, optional: true }),
    };
}

function clampTtlSeconds(ttlSeconds: number): number {
    const MAX = 60 * 60;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return 900;
    return Math.min(Math.floor(ttlSeconds), MAX);
}

function expiresInMsToSeconds(expiresInMs: number | undefined, fallbackSeconds: number): number {
    if (!expiresInMs || !Number.isFinite(expiresInMs) || expiresInMs <= 0) {
        return clampTtlSeconds(fallbackSeconds);
    }
    return clampTtlSeconds(Math.ceil(expiresInMs / 1000));
}

function normalizeMime(value: string): string {
    return value.split(';', 1)[0]?.trim().toLowerCase() || value.trim().toLowerCase();
}

const SAFE_INLINE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
]);

function resolveDownloadHeaders(input: PresignDownloadRequest): {
    mimeType: string;
    disposition: 'inline' | 'attachment';
    filename: string;
} {
    const requestedMime = normalizeMime(input.mimeType ?? '');
    const safeInline = SAFE_INLINE_MIME_TYPES.has(requestedMime);
    const mimeType = safeInline ? requestedMime : 'application/octet-stream';
    const disposition = safeInline && input.disposition === 'inline'
        ? 'inline'
        : 'attachment';
    const filename = (input.filename ?? 'download')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .replace(/[\\/]+/g, '_')
        .trim()
        .replace(/^\.+$/, '')
        .slice(0, 180) || 'download';
    return { mimeType, disposition, filename };
}

const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

function isNotFoundError(error: unknown): boolean {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound') return true;
    if (e?.$metadata?.httpStatusCode === 404) return true;
    return false;
}

export interface S3AdapterConfig {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    forcePathStyle: boolean;
    keyPrefix: string;
    urlTtlSeconds: number;
    requireChecksum: boolean;
}

export class S3StorageGatewayAdapter implements StorageGatewayAdapter {
    id = 's3';

    private readonly clientInstance: Pick<S3Client, 'send'>;
    private readonly nowFn: () => number;
    private readonly getSyncGatewayFn: () => Pick<
        SyncGatewayAdapter,
        'queryCanonicalStorage' | 'reserveUploadIntent' | 'consumeUploadIntent' | 'cancelUploadIntent'
    > | undefined;
    private readonly randomIdFn: () => string;

    constructor(
        private readonly cfg: S3AdapterConfig,
        deps?: {
            client?: Pick<S3Client, 'send'>;
            now?: () => number;
            getSyncGateway?: () => Pick<
                SyncGatewayAdapter,
                'queryCanonicalStorage' | 'reserveUploadIntent' | 'consumeUploadIntent' | 'cancelUploadIntent'
            > | undefined;
            randomId?: () => string;
        }
    ) {
        this.clientInstance = deps?.client ?? new S3Client(this.buildClientConfig());
        this.nowFn = deps?.now ?? (() => Date.now());
        this.getSyncGatewayFn = deps?.getSyncGateway ?? (() => getActiveSyncGatewayAdapter() ?? undefined);
        this.randomIdFn = deps?.randomId ?? randomUUID;
    }

    private buildClientConfig(): S3ClientConfig {
        return {
            region: this.cfg.region,
            endpoint: this.cfg.endpoint,
            forcePathStyle: this.cfg.forcePathStyle,
            credentials: {
                accessKeyId: this.cfg.accessKeyId,
                secretAccessKey: this.cfg.secretAccessKey,
                sessionToken: this.cfg.sessionToken,
            },
        };
    }

    private now(): number {
        return this.nowFn();
    }

    async presignUpload(event: H3Event, input: PresignUploadRequest): Promise<PresignUploadResponse> {
        void event;
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
            throw createError({ statusCode: 400, statusMessage: 'Upload size must be a nonnegative integer' });
        }
        if (input.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
            throw createError({ statusCode: 413, statusMessage: `Upload exceeds ${MAX_UPLOAD_SIZE_BYTES} byte limit` });
        }
        const key = buildS3ObjectKey({
            keyPrefix: this.cfg.keyPrefix,
            workspaceId: input.workspaceId,
            hash: input.hash,
        });

        const expiresIn = expiresInMsToSeconds(input.expiresInMs, this.cfg.urlTtlSeconds);
        const intentId = this.randomIdFn();
        const expiresAt = this.now() + expiresIn * 1000;
        const sync = this.getSyncGatewayFn();
        if (input.workspaceQuotaBytes !== undefined && !sync?.reserveUploadIntent) {
            throw createError({
                statusCode: 503,
                statusMessage: 'Atomic upload quota reservations require sync-provider support',
            });
        }
        if (sync?.reserveUploadIntent) {
            await sync.reserveUploadIntent(event, {
                intentId,
                workspaceId: input.workspaceId,
                hash: input.hash,
                mimeType: normalizeMime(input.mimeType),
                sizeBytes: input.sizeBytes,
                expiresAt: Math.floor(expiresAt / 1000),
                workspaceQuotaBytes: input.workspaceQuotaBytes,
            });
        }

        const command = new PutObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            ContentType: input.mimeType,
            ContentLength: input.sizeBytes,
            ChecksumSHA256: sha256HexToBase64Checksum(input.hash),
            Metadata: {
                'or3-hash': input.hash,
                'or3-workspace': input.workspaceId,
                'or3-intent': intentId,
                'or3-intent-expires': String(expiresAt),
            },
        });

        let url: string;
        try {
            url = await getSignedUrl(this.clientInstance as S3Client, command, { expiresIn });
        } catch (error) {
            if (sync?.cancelUploadIntent) {
                await sync.cancelUploadIntent(event, {
                    workspaceId: input.workspaceId,
                    intentId,
                }).catch(() => {});
            }
            throw error;
        }

        const headers: Record<string, string> = {
            'Content-Type': input.mimeType,
            'Content-Length': String(input.sizeBytes),
            'x-amz-checksum-sha256': sha256HexToBase64Checksum(input.hash),
        };

        return {
            url,
            method: 'PUT',
            headers,
            expiresAt,
            storageId: key,
            intentId,
        };
    }

    async presignDownload(event: H3Event, input: PresignDownloadRequest): Promise<PresignDownloadResponse> {
        void event;
        const derivedKey = buildS3ObjectKey({
            keyPrefix: this.cfg.keyPrefix,
            workspaceId: input.workspaceId,
            hash: input.hash,
        });
        const providedStorageId = input.storageId?.trim();
        if (providedStorageId && providedStorageId !== derivedKey) {
            throw createError({ statusCode: 400, statusMessage: 'storage_id does not match expected object key' });
        }

        const key = derivedKey;

        // The marker is the provider's commit boundary. A raw object can be
        // left behind by an interrupted upload and must never be presigned.
        try {
            await this.clientInstance.send(new HeadObjectCommand({
                Bucket: this.cfg.bucket,
                Key: buildS3MarkerKey(key),
            }));
            await this.clientInstance.send(new HeadObjectCommand({
                Bucket: this.cfg.bucket,
                Key: key,
            }));
        } catch (error) {
            if (isNotFoundError(error)) {
                throw createError({ statusCode: 404, statusMessage: 'File not found' });
            }
            throw createError({ statusCode: 502, statusMessage: 'S3 object verification failed' });
        }

        const expiresIn = expiresInMsToSeconds(input.expiresInMs, this.cfg.urlTtlSeconds);
        const downloadHeaders = resolveDownloadHeaders(input);

        const command = new GetObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            ResponseContentType: downloadHeaders.mimeType,
            ResponseContentDisposition:
                `${downloadHeaders.disposition}; filename*=UTF-8''${encodeURIComponent(downloadHeaders.filename)}`,
        });

        const url = await getSignedUrl(this.clientInstance as S3Client, command, { expiresIn });

        return {
            url,
            method: 'GET',
            expiresAt: this.now() + expiresIn * 1000,
            storageId: key,
        };
    }

    async commit(event: H3Event, input: unknown): Promise<void> {
        void event;
        const body = parseCommitInput(input);
        const derivedKey = buildS3ObjectKey({
            keyPrefix: this.cfg.keyPrefix,
            workspaceId: body.workspace_id,
            hash: body.hash,
        });

        // Storage ID is expected to be the object key we handed out.
        if (body.storage_id !== derivedKey) {
            throw createError({ statusCode: 400, statusMessage: 'storage_id does not match expected object key' });
        }

        let head;
        try {
            head = await this.clientInstance.send(
                new HeadObjectCommand({
                    Bucket: this.cfg.bucket,
                    Key: derivedKey,
                    ChecksumMode: 'ENABLED',
                })
            );
        } catch (error) {
            if (isNotFoundError(error)) {
                throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' });
            }
            throw createError({ statusCode: 502, statusMessage: 'S3 HEAD failed' });
        }

        const expectedSize = body.size_bytes;

        if (typeof head.ContentLength !== 'number') {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object missing content length' });
        }
        if (head.ContentLength !== expectedSize) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object size mismatch' });
        }

        const expectedMime = normalizeMime(body.mime_type);
        if (!head.ContentType) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object missing content type' });
        }
        const actualMime = normalizeMime(head.ContentType);
        if (actualMime !== expectedMime) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object content-type mismatch' });
        }
        const metadata = head.Metadata ?? {};
        if (metadata['or3-workspace'] !== body.workspace_id ||
            metadata['or3-hash'] !== body.hash ||
            metadata['or3-intent'] !== body.intent_id) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object does not match upload intent' });
        }
        const intentExpiresAt = Number(metadata['or3-intent-expires']);
        if (!Number.isFinite(intentExpiresAt) || intentExpiresAt <= this.now()) {
            throw createError({ statusCode: 410, statusMessage: 'Upload intent expired' });
        }
        const expectedChecksum = sha256HexToBase64Checksum(body.hash);
        if (head.ChecksumSHA256 !== expectedChecksum) {
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object checksum mismatch' });
        }

        const markerKey = buildS3MarkerKey(derivedKey);
        const payload = JSON.stringify(
            {
                workspace_id: body.workspace_id,
                hash: body.hash,
                storage_id: body.storage_id,
                committed_at: new Date(this.now()).toISOString(),
                mime_type: body.mime_type,
                size_bytes: body.size_bytes,
                etag: head.ETag,
                intent_id: body.intent_id,
            },
            null,
            0
        );

        try {
            await this.clientInstance.send(
                new PutObjectCommand({
                    Bucket: this.cfg.bucket,
                    Key: markerKey,
                    Body: payload,
                    ContentType: 'application/json',
                    IfNoneMatch: '*',
                })
            );
        } catch (error) {
            const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            if (status === 409 || status === 412) {
                throw createError({ statusCode: 409, statusMessage: 'Upload intent already consumed' });
            }
            throw createError({ statusCode: 502, statusMessage: 'S3 commit marker write failed' });
        }
        const sync = this.getSyncGatewayFn();
        if (sync?.consumeUploadIntent) {
            await sync.consumeUploadIntent(event, {
                intentId: body.intent_id,
                workspaceId: body.workspace_id,
                hash: body.hash,
                mimeType: expectedMime,
                sizeBytes: body.size_bytes,
                storageId: body.storage_id,
            });
        }
    }

    async deleteObject(_event: H3Event, input: DeleteObjectRequest): Promise<void> {
        const objectKey = buildS3ObjectKey({
            keyPrefix: this.cfg.keyPrefix,
            workspaceId: input.workspaceId,
            hash: input.hash,
        });
        if (input.storageId !== undefined && input.storageId !== objectKey) {
            throw createError({
                statusCode: 400,
                statusMessage: 'storage_id does not match expected object key',
            });
        }

        // A query against a separate database cannot prevent a concurrent
        // metadata restore or reference write while an S3 object is deleted.
        const present = await Promise.all([objectKey, buildS3MarkerKey(objectKey)].map(async (key) => {
            try {
                await this.clientInstance.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
                return true;
            } catch (error) {
                if (isNotFoundError(error)) return false;
                throw createError({ statusCode: 502, statusMessage: 'S3 object verification failed' });
            }
        }));
        if (!present.some(Boolean)) return;
        throw createError({ statusCode: 503, statusMessage: 'Provider-owned deletion coordination is required' });
    }

    async gc(_event: H3Event, input: unknown): Promise<{
        deleted_count: number;
        status: 'disabled';
        reason: 'deletion_coordination_required';
    }> {
        parseGcInput(input);
        return { deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' };
    }
}

export function createS3StorageGatewayAdapter(): S3StorageGatewayAdapter {
    const runtimeConfig = useRuntimeConfig();
    const diagnostics = validateS3StorageConfig(runtimeConfig);
    if (!diagnostics.isValid) {
        throw new Error(diagnostics.errors.join(' '));
    }

    const cfg = diagnostics.config;
    return new S3StorageGatewayAdapter({
        endpoint: cfg.endpoint,
        region: cfg.region!,
        bucket: cfg.bucket!,
        accessKeyId: cfg.accessKeyId!,
        secretAccessKey: cfg.secretAccessKey!,
        sessionToken: cfg.sessionToken,
        forcePathStyle: cfg.forcePathStyle,
        keyPrefix: cfg.keyPrefix,
        urlTtlSeconds: cfg.urlTtlSeconds,
        requireChecksum: cfg.requireChecksum,
    });
}
