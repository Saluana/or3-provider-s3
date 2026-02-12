import type { H3Event } from 'h3';
import { createError } from 'h3';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
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
} from '~~/server/storage/gateway/types';
import { buildS3MarkerKey, buildS3ObjectKey, sha256HexToBase64Checksum } from './s3-keys';
import { validateS3StorageConfig } from './s3-config';

type CommitInput = {
    workspace_id: string;
    hash: string;
    storage_id: string;
    storage_provider_id: string;
    mime_type: string;
    size_bytes: number;
    name: string;
    kind: 'image' | 'pdf';
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
    if (kind !== 'image' && kind !== 'pdf') {
        throw createError({ statusCode: 400, statusMessage: 'Invalid kind' });
    }

    return {
        workspace_id: assertString(obj.workspace_id, 'Invalid workspace_id'),
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
    return {
        workspace_id: assertString(obj.workspace_id, 'Invalid workspace_id'),
        retention_seconds: assertInt(obj.retention_seconds, 'Invalid retention_seconds', { min: 0 }) as number,
        limit: assertInt(obj.limit, 'Invalid limit', { min: 1, optional: true }),
    };
}

function clampTtlSeconds(ttlSeconds: number): number {
    const MAX = 24 * 60 * 60;
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

    constructor(
        private readonly cfg: S3AdapterConfig,
        deps?: {
            client?: Pick<S3Client, 'send'>;
            now?: () => number;
        }
    ) {
        this.clientInstance = deps?.client ?? new S3Client(this.buildClientConfig());
        this.nowFn = deps?.now ?? (() => Date.now());
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
        const key = buildS3ObjectKey({
            keyPrefix: this.cfg.keyPrefix,
            workspaceId: input.workspaceId,
            hash: input.hash,
        });

        const expiresIn = expiresInMsToSeconds(input.expiresInMs, this.cfg.urlTtlSeconds);

        const command = new PutObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            ContentType: input.mimeType,
            Metadata: {
                'or3-hash': input.hash,
                'or3-workspace': input.workspaceId,
            },
            ...(this.cfg.requireChecksum
                ? { ChecksumSHA256: sha256HexToBase64Checksum(input.hash) }
                : {}),
        });

        const url = await getSignedUrl(this.clientInstance as S3Client, command, { expiresIn });

        const headers: Record<string, string> = {
            'Content-Type': input.mimeType,
        };
        if (this.cfg.requireChecksum) {
            headers['x-amz-checksum-sha256'] = sha256HexToBase64Checksum(input.hash);
        }

        return {
            url,
            method: 'PUT',
            headers,
            expiresAt: this.now() + expiresIn * 1000,
            storageId: key,
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

        const expiresIn = expiresInMsToSeconds(input.expiresInMs, this.cfg.urlTtlSeconds);

        const command = new GetObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            ...(input.disposition ? { ResponseContentDisposition: input.disposition } : {}),
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
                })
            );
        } catch (error) {
            if (isNotFoundError(error)) {
                throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' });
            }
            throw createError({ statusCode: 502, statusMessage: 'S3 HEAD failed' });
        }

        const expectedSize = body.size_bytes;
        const deleteUploadedObject = () => this.clientInstance.send(
            new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: derivedKey })
        ).catch(() => {});

        if (typeof head.ContentLength !== 'number') {
            await deleteUploadedObject();
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object missing content length' });
        }
        if (head.ContentLength !== expectedSize) {
            await deleteUploadedObject();
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object size mismatch' });
        }

        const expectedMime = normalizeMime(body.mime_type);
        if (!head.ContentType) {
            await deleteUploadedObject();
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object missing content type' });
        }
        const actualMime = normalizeMime(head.ContentType);
        if (actualMime !== expectedMime) {
            await deleteUploadedObject();
            throw createError({ statusCode: 400, statusMessage: 'Uploaded object content-type mismatch' });
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
                })
            );
        } catch {
            throw createError({ statusCode: 502, statusMessage: 'S3 commit marker write failed' });
        }
    }

    async gc(event: H3Event, input: unknown): Promise<{ deleted_count: number }> {
        void event;
        const { workspace_id, retention_seconds, limit } = parseGcInput(input);
        const cutoffMs = this.now() - retention_seconds * 1000;
        const maxDeletes = limit ?? Number.POSITIVE_INFINITY;

        const prefix = `${this.cfg.keyPrefix}${workspace_id}/`;

        const seenBlobKeys = new Set<string>();
        const markerKeys = new Set<string>();
        const staleBlobCandidates: string[] = [];
        const staleMarkerCandidates: string[] = [];

        let token: string | undefined;
        while (true) {
            const page = await this.clientInstance.send(
                new ListObjectsV2Command({
                    Bucket: this.cfg.bucket,
                    Prefix: prefix,
                    ContinuationToken: token,
                })
            );

            for (const item of page.Contents ?? []) {
                const key = item.Key;
                if (!key) continue;

                const lastModifiedMs = item.LastModified ? item.LastModified.getTime() : 0;
                const isStale = lastModifiedMs > 0 && lastModifiedMs < cutoffMs;

                if (key.endsWith('.meta.json')) {
                    markerKeys.add(key);
                    if (isStale) staleMarkerCandidates.push(key);
                    continue;
                }

                seenBlobKeys.add(key);
                if (isStale) staleBlobCandidates.push(key);
            }

            if (!page.IsTruncated) break;
            token = page.NextContinuationToken;
            if (!token) break;

            // Stop scanning once we have enough total stale candidates to satisfy limit.
            if (staleBlobCandidates.length + staleMarkerCandidates.length >= maxDeletes) {
                break;
            }
        }

        const deletes: string[] = [];

        for (const blobKey of staleBlobCandidates) {
            if (deletes.length >= maxDeletes) break;
            const markerKey = buildS3MarkerKey(blobKey);
            if (markerKeys.has(markerKey)) continue;
            deletes.push(blobKey);
        }

        for (const markerKey of staleMarkerCandidates) {
            if (deletes.length >= maxDeletes) break;
            const blobKey = markerKey.slice(0, -'.meta.json'.length);
            if (seenBlobKeys.has(blobKey)) continue;
            deletes.push(markerKey);
        }

        let deletedCount = 0;
        for (let i = 0; i < deletes.length; i += 1000) {
            const chunk = deletes.slice(i, i + 1000);
            if (chunk.length === 0) break;

            await this.clientInstance.send(
                new DeleteObjectsCommand({
                    Bucket: this.cfg.bucket,
                    Delete: {
                        Objects: chunk.map((Key) => ({ Key })),
                        Quiet: true,
                    },
                })
            );
            deletedCount += chunk.length;
        }

        return { deleted_count: deletedCount };
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
