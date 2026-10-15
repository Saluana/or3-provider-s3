import { createError } from 'h3';

const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;
const SHA256_HASH = /^(?:sha256:)?([0-9a-f]{64})$/;

export function assertValidWorkspaceId(workspaceId: string): void {
    if (!workspaceId || !SAFE_WORKSPACE_ID.test(workspaceId)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
    }
}

export function requireSha256Hash(hash: string): string {
    const match = typeof hash === 'string' ? SHA256_HASH.exec(hash.trim().toLowerCase()) : null;
    if (!match) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid hash' });
    }
    return `sha256:${match[1]}`;
}

export function buildS3ObjectKey(input: {
    keyPrefix: string;
    workspaceId: string;
    hash: string;
}): string {
    assertValidWorkspaceId(input.workspaceId);
    const hash = requireSha256Hash(input.hash);
    return `${input.keyPrefix}${input.workspaceId}/${hash}`;
}

export function buildS3MarkerKey(objectKey: string): string {
    return `${objectKey}.meta.json`;
}

export function sha256HexToBase64Checksum(hash: string): string {
    const hex = requireSha256Hash(hash).slice('sha256:'.length);
    return Buffer.from(hex, 'hex').toString('base64');
}
