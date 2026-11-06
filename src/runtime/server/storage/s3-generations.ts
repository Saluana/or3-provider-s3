/** Dormant transport: no registry, route or environment flag activates it.
 * The caller owns authentication and canonical reservation/publication. */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, GetBucketVersioningCommand, PutObjectCommand, GetObjectCommand,
    HeadObjectCommand, DeleteObjectCommand, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ExternalStorageGenerationCoordinatorV1 } from '~~/server/storage/gateway/generation-lifecycle';
import type { ExternalStorageGenerationUploadCoordinatorV1, ExternalStorageGenerationUploadClaimKey } from '~~/server/storage/gateway/generation-upload';
import type { DownloadPolicy } from '~~/server/utils/storage/download-policy';
import { assertValidWorkspaceId, requireS3Hash } from './s3-keys';

export interface S3GenerationSpec {
    workspaceId: string;
    generationId: string;
    hash: string;
    sizeBytes: number;
    mimeType: string;
}
interface Ready extends S3GenerationSpec { storageId: string; namespaceId: string; readyReceiptId: string }
export interface S3GenerationPublication extends Ready { versionId: string }
interface Retired extends Ready { claimId: string; removedVersionId: string | null }
interface Options {
    client: S3Client;
    bucket: string;
    namespaceId: string;
    keyPrefix?: string;
    enabled?: boolean;
    cleanupEnabled?: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const absent = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
const exists = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412;
function canonicalHash(value: string): string {
    const hash = requireS3Hash(value);
    if (!hash.startsWith('sha256:')) throw new Error('Immutable generations require SHA-256');
    return hash;
}
function immutableVersion(value: { VersionId?: string }): string {
    if (typeof value.VersionId !== 'string' || !value.VersionId || value.VersionId === 'null') throw new Error('Immutable S3 version unavailable');
    return value.VersionId;
}
function lifetime(seconds: number): number {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900) throw new Error('Invalid generation credential lifetime');
    return seconds;
}

export class S3GenerationStore {
    readonly namespaceId: string;
    private readonly prefix: string;
    private qualification?: Promise<void>;
    constructor(private readonly options: Options) {
        if (!uuid.test(options.namespaceId)) throw new Error('Invalid generation namespace');
        this.namespaceId = options.namespaceId;
        const prefix = options.keyPrefix ?? '';
        if (!/^[a-zA-Z0-9/_-]*$/.test(prefix) || prefix.startsWith('/')) throw new Error('Invalid generation prefix');
        this.prefix = `${prefix.replace(/\/*$/, '')}${prefix ? '/' : ''}or3-generations-v1/${this.namespaceId}/`;
    }
    private enabled(cleanup = false): void {
        if (this.options.enabled !== true || (cleanup && this.options.cleanupEnabled !== true)) throw new Error('S3 generations or cleanup are disabled');
    }
    private spec(input: S3GenerationSpec): S3GenerationSpec {
        assertValidWorkspaceId(input.workspaceId);
        if (!uuid.test(input.generationId)) throw new Error('Invalid generation identity');
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 1024 ** 3) throw new Error('Invalid generation size');
        if (typeof input.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) throw new Error('Invalid generation MIME');
        return { workspaceId: input.workspaceId, generationId: input.generationId, hash: canonicalHash(input.hash), sizeBytes: input.sizeBytes, mimeType: input.mimeType };
    }
    storageId(input: S3GenerationSpec): string {
        const value = this.spec(input);
        return `${this.prefix}${encodeURIComponent(value.workspaceId)}/${value.generationId}/${value.hash.slice(7)}`;
    }
    async resolveStorageId(storageId: string, workspaceId: string, hash: string, sizeBytes: number, mimeType: string): Promise<S3GenerationSpec> {
        const prefix = `${this.prefix}${encodeURIComponent(workspaceId)}/`;
        if (!storageId.startsWith(prefix)) throw new Error('Foreign generation target');
        const generationId = storageId.slice(prefix.length).split('/')[0]!;
        const spec = this.spec({ workspaceId, generationId, hash, sizeBytes, mimeType });
        if (this.storageId(spec) !== storageId) throw new Error('Generation target mismatch');
        return spec;
    }
    private metadata(spec: S3GenerationSpec, kind: 'payload' | 'retired'): Record<string, string> {
        return { 'or3-kind': kind, 'or3-namespace': this.namespaceId, 'or3-generation': spec.generationId,
            'or3-hash': spec.hash, 'or3-workspace': spec.workspaceId };
    }
    private matchesHead(spec: S3GenerationSpec, value: HeadObjectCommandOutput, kind: 'payload' | 'retired'): void {
        for (const [key, expected] of Object.entries(this.metadata(spec, kind))) {
            if (value.Metadata?.[key] !== expected) throw new Error('Generation object binding mismatch');
        }
        immutableVersion(value);
        if (kind === 'payload' && (value.ContentLength !== spec.sizeBytes || value.ContentType !== spec.mimeType)) throw new Error('Generation object metadata mismatch');
    }
    private matchesReady(spec: S3GenerationSpec, value: Ready): void {
        if (value.namespaceId !== this.namespaceId || value.storageId !== this.storageId(spec) ||
            value.workspaceId !== spec.workspaceId || value.generationId !== spec.generationId || value.hash !== spec.hash ||
            value.sizeBytes !== spec.sizeBytes || value.mimeType !== spec.mimeType || !uuid.test(value.readyReceiptId)) throw new Error('Generation receipt mismatch');
    }
    private async head(key: string, versionId?: string): Promise<HeadObjectCommandOutput | null> {
        try { return await this.options.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key, VersionId: versionId })); }
        catch (error) { if (absent(error)) return null; throw error; }
    }
    private async readJson<T>(key: string): Promise<T | null> {
        let response;
        try { response = await this.options.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key })); }
        catch (error) { if (absent(error)) return null; throw error; }
        const body = response.Body as Readable | undefined;
        if (!body) throw new Error('Missing generation receipt body');
        try {
            if ((response.ContentLength ?? Infinity) > 4096) throw new Error('Oversized generation receipt');
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of body) {
                const bytes = Buffer.from(chunk); size += bytes.length;
                if (size > 4096) throw new Error('Oversized generation receipt');
                chunks.push(bytes);
            }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed generation receipt');
            return value as T;
        } finally { body.destroy(); }
    }
    private async putJson(key: string, body: object, conditional = true, metadata?: Record<string, string>) {
        const bytes = Buffer.from(JSON.stringify(body));
        return this.options.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes,
            ContentType: 'application/json', ContentLength: bytes.length, Metadata: metadata,
            ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'), ...(conditional ? { IfNoneMatch: '*' } : {}) }));
    }
    private async supported(): Promise<void> {
        this.enabled();
        const versioning = await this.options.client.send(new GetBucketVersioningCommand({ Bucket: this.options.bucket }));
        if (versioning.Status !== 'Enabled') throw new Error('S3 generations require preconfigured bucket versioning');
        // Verify conditional semantics instead of trusting a compatibility label.
        // Retain this tiny private probe; it is not a user object or cleanup authority.
        if (!this.qualification) {
            this.qualification = (async () => {
                const key = `${this.prefix}protocol-${randomUUID()}.json`;
                immutableVersion(await this.putJson(key, { namespaceId: this.namespaceId }));
                try { await this.putJson(key, { overwritten: true }); }
                catch (error) { if (exists(error)) return; throw error; }
                throw new Error('S3 conditional create is unsupported');
            })();
        }
        await this.qualification;
    }
    async allocate(input: S3GenerationSpec): Promise<Ready> {
        this.enabled(); const spec = this.spec(input); await this.supported();
        const storageId = this.storageId(spec);
        const value: Ready = { ...spec, storageId, namespaceId: this.namespaceId, readyReceiptId: randomUUID() };
        try { immutableVersion(await this.putJson(storageId + '.ready.json', value)); }
        catch (error) { if (!exists(error)) throw error; }
        const ready = await this.readJson<Ready>(storageId + '.ready.json');
        if (!ready) throw new Error('Generation readiness is missing');
        this.matchesReady(spec, ready);
        const head = await this.head(storageId);
        if (head?.Metadata?.['or3-kind'] === 'retired') throw new Error('Generation is retired');
        return ready;
    }
    async inspectAllocation(input: S3GenerationSpec): Promise<Ready | null> {
        this.enabled(); const spec = this.spec(input);
        const ready = await this.readJson<Ready>(this.storageId(spec) + '.ready.json');
        if (ready) this.matchesReady(spec, ready);
        return ready;
    }
    private async ready(spec: S3GenerationSpec): Promise<Ready> {
        const ready = await this.readJson<Ready>(this.storageId(spec) + '.ready.json');
        if (!ready) throw new Error('Generation is not allocated');
        this.matchesReady(spec, ready); return ready;
    }
    async presignUpload(input: S3GenerationSpec, seconds: number): Promise<{ url: string; headers: Record<string, string> }> {
        this.enabled(); const spec = this.spec(input); lifetime(seconds); await this.supported(); await this.ready(spec);
        const headers: Record<string, string> = { 'content-type': spec.mimeType, 'if-none-match': '*',
            'x-amz-checksum-sha256': Buffer.from(spec.hash.slice(7), 'hex').toString('base64') };
        const metadata = this.metadata(spec, 'payload');
        for (const [key, value] of Object.entries(metadata)) headers[`x-amz-meta-${key}`] = value;
        const url = await getSignedUrl(this.options.client, new PutObjectCommand({ Bucket: this.options.bucket, Key: this.storageId(spec),
            ContentType: spec.mimeType, ContentLength: spec.sizeBytes, ChecksumSHA256: headers['x-amz-checksum-sha256'], Metadata: metadata, IfNoneMatch: '*' }),
        { expiresIn: seconds, unhoistableHeaders: new Set(Object.keys(headers)), signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']) });
        return { url, headers };
    }
    private async verifyVersion(spec: S3GenerationSpec, versionId: string): Promise<void> {
        if (!versionId || versionId === 'null') throw new Error('Unversioned publication');
        const response = await this.options.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.storageId(spec), VersionId: versionId }));
        const body = response.Body as Readable | undefined;
        if (!body) throw new Error('Missing generation bytes');
        try {
            if (response.VersionId !== versionId || response.ContentLength !== spec.sizeBytes) throw new Error('Generation version mismatch');
            let size = 0; const hash = createHash('sha256');
            for await (const chunk of body) {
                const bytes = Buffer.from(chunk); size += bytes.length;
                if (size > spec.sizeBytes) throw new Error('Generation exceeds reserved size');
                hash.update(bytes);
            }
            if (size !== spec.sizeBytes || `sha256:${hash.digest('hex')}` !== spec.hash) throw new Error('Generation content verification failed');
        } finally { body.destroy(); }
    }
    async verifyPublication(input: S3GenerationSpec): Promise<S3GenerationPublication> {
        this.enabled(); const spec = this.spec(input); await this.supported();
        const ready = await this.ready(spec);
        const current = await this.head(ready.storageId);
        if (!current) throw new Error('Generation bytes are missing');
        this.matchesHead(spec, current, 'payload');
        let publication = await this.readJson<S3GenerationPublication>(ready.storageId + '.published.json');
        let verifiedVersion: string | undefined;
        if (!publication) {
            const proposed: S3GenerationPublication = { ...ready, versionId: immutableVersion(current) };
            await this.verifyVersion(spec, proposed.versionId);
            verifiedVersion = proposed.versionId;
            try { immutableVersion(await this.putJson(ready.storageId + '.published.json', proposed)); }
            catch (error) { if (!exists(error)) throw error; }
            publication = await this.readJson<S3GenerationPublication>(ready.storageId + '.published.json');
        }
        if (!publication) throw new Error('Generation publication missing');
        this.matchesReady(spec, publication);
        if (publication.readyReceiptId !== ready.readyReceiptId) throw new Error('Generation readiness changed');
        if (publication.versionId !== verifiedVersion) await this.verifyVersion(spec, publication.versionId);
        return publication;
    }
    async presignDownload(input: S3GenerationSpec, seconds: number, policy?: DownloadPolicy): Promise<string> {
        this.enabled(); const spec = this.spec(input); lifetime(seconds); await this.supported();
        const publication = await this.readJson<S3GenerationPublication>(this.storageId(spec) + '.published.json');
        if (!publication) throw new Error('Generation publication missing');
        this.matchesReady(spec, publication);
        const current = await this.head(publication.storageId);
        if (!current) throw new Error('Generation bytes missing');
        this.matchesHead(spec, current, 'payload');
        const exact = await this.head(publication.storageId, publication.versionId);
        if (!exact || immutableVersion(exact) !== publication.versionId) throw new Error('Generation version unavailable');
        return getSignedUrl(this.options.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: publication.storageId,
            VersionId: publication.versionId, ResponseContentType: policy?.mimeType ?? 'application/octet-stream',
            ResponseContentDisposition: policy ? `${policy.disposition}; filename*=UTF-8''${encodeURIComponent(policy.filename)}` : 'attachment' }), { expiresIn: seconds });
    }
    private async retire(spec: S3GenerationSpec, claimId: string, expectedVersion?: string): Promise<void> {
        await this.supported(); const ready = await this.ready(spec);
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.head(ready.storageId);
            let retired: Retired;
            if (current?.Metadata?.['or3-kind'] === 'retired') {
                this.matchesHead(spec, current, 'retired');
                const receipt = await this.readJson<Retired>(ready.storageId);
                if (!receipt) throw new Error('Retirement receipt missing');
                retired = receipt;
            } else {
                if (current) this.matchesHead(spec, current, 'payload');
                const removedVersionId = current ? immutableVersion(current) : expectedVersion ?? null;
                if (expectedVersion && removedVersionId !== expectedVersion) throw new Error('Claimed version mismatch');
                retired = { ...ready, claimId, removedVersionId };
                // Only server cleanup can overwrite a managed key. All upload
                // credentials require absence, so this non-delete-marker object
                // permanently prevents a delayed uploader recreating its payload.
                try { immutableVersion(await this.putJson(ready.storageId, retired, current === null, this.metadata(spec, 'retired'))); }
                catch (error) { if (exists(error)) continue; throw error; }
            }
            this.matchesReady(spec, retired);
            if (retired.readyReceiptId !== ready.readyReceiptId || retired.claimId !== claimId ||
                (expectedVersion && retired.removedVersionId !== expectedVersion) ||
                (retired.removedVersionId !== null && (!retired.removedVersionId || retired.removedVersionId === 'null'))) throw new Error('Retirement claim mismatch');
            if (retired.removedVersionId) {
                await this.options.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: ready.storageId, VersionId: retired.removedVersionId }));
                if (await this.head(ready.storageId, retired.removedVersionId)) throw new Error('Claimed version removal is unconfirmed');
            }
            const durable = await this.readJson<Retired>(ready.storageId);
            if (!durable || durable.claimId !== claimId || durable.removedVersionId !== retired.removedVersionId) throw new Error('Permanent upload fence missing');
            this.matchesReady(spec, durable);
            return;
        }
        throw new Error('Generation retirement is contended');
    }
    async removeGeneration(input: S3GenerationSpec, claimId: string, coordinator: ExternalStorageGenerationCoordinatorV1): Promise<void> {
        this.enabled(true); const spec = this.spec(input);
        if (coordinator.version !== 1 || coordinator.storageProviderId !== 's3') throw new Error('Unsupported generation coordinator');
        const claim = await coordinator.getGeneration(spec);
        if (!claim || !['claimed', 'deleted'].includes(claim.state) || claim.claimId !== claimId ||
            claim.workspaceId !== spec.workspaceId || canonicalHash(claim.hash) !== spec.hash || claim.generationId !== spec.generationId ||
            claim.storageId !== this.storageId(spec) || claim.sizeBytes !== spec.sizeBytes) throw new Error('Durable generation claim required');
        const publication = await this.readJson<S3GenerationPublication>(claim.storageId + '.published.json');
        if (!publication) throw new Error('Claimed publication missing');
        this.matchesReady(spec, publication);
        await this.retire(spec, claimId, publication.versionId);
    }
    async removeAbandoned(input: S3GenerationSpec, key: ExternalStorageGenerationUploadClaimKey, coordinator: ExternalStorageGenerationUploadCoordinatorV1): Promise<void> {
        this.enabled(true); const spec = this.spec(input);
        if (coordinator.version !== 1 || coordinator.uploadVersion !== 1 || coordinator.storageProviderId !== 's3') throw new Error('Unsupported generation coordinator');
        const claim = await coordinator.getGenerationUploadClaim(key);
        if (!claim || !['abandon_claimed', 'abandoned'].includes(claim.state) || claim.claimId !== key.claimId ||
            claim.workspaceId !== spec.workspaceId || canonicalHash(claim.hash) !== spec.hash || claim.generationId !== spec.generationId ||
            claim.storageId !== this.storageId(spec) || claim.namespaceId !== this.namespaceId || claim.sizeBytes !== spec.sizeBytes) throw new Error('Durable abandonment claim required');
        const ready = await this.ready(spec);
        if (claim.readyReceiptId !== ready.readyReceiptId) throw new Error('Abandonment readiness mismatch');
        await this.retire(spec, key.claimId);
    }
}
