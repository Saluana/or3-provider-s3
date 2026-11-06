import { createError } from 'h3';

const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;
const SHA256_HASH = /^(?:sha256:)?([0-9a-f]{64})$/;
const MD5_HASH = /^(?:md5:)?([0-9a-f]{32})$/;

export function assertValidWorkspaceId(workspaceId: string): void {
    if (!workspaceId || !SAFE_WORKSPACE_ID.test(workspaceId)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
    }
}

export function requireS3Hash(hash: string): string {
    const value = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
    const sha256 = SHA256_HASH.exec(value);
    if (sha256) return `sha256:${sha256[1]}`;
    const md5 = MD5_HASH.exec(value);
    if (md5) return `md5:${md5[1]}`;
    throw createError({ statusCode: 400, statusMessage: 'Invalid hash' });
}

export function buildS3ObjectKey(input: {
    keyPrefix: string;
    workspaceId: string;
    hash: string;
}): string {
    assertValidWorkspaceId(input.workspaceId);
    const hash = requireS3Hash(input.hash);
    return `${input.keyPrefix}${input.workspaceId}/${hash}`;
}

export function buildS3MarkerKey(objectKey: string): string {
    return `${objectKey}.meta.json`;
}

export function hashToBase64Checksum(hash: string): string {
    const hex = requireS3Hash(hash).split(':')[1]!;
    return Buffer.from(hex, 'hex').toString('base64');
}
