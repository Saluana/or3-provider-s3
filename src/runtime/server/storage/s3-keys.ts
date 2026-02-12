import { createError } from 'h3';

const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;
const SHA256_HASH = /^sha256:[0-9a-f]{64}$/i;

export function assertValidWorkspaceId(workspaceId: string): void {
    if (!workspaceId || !SAFE_WORKSPACE_ID.test(workspaceId)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid workspace_id' });
    }
}

export function requireSha256Hash(hash: string): void {
    if (!hash || !SHA256_HASH.test(hash)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid hash' });
    }
}

export function buildS3ObjectKey(input: {
    keyPrefix: string;
    workspaceId: string;
    hash: string;
}): string {
    assertValidWorkspaceId(input.workspaceId);
    requireSha256Hash(input.hash);
    return `${input.keyPrefix}${input.workspaceId}/${input.hash}`;
}

export function buildS3MarkerKey(objectKey: string): string {
    return `${objectKey}.meta.json`;
}

export function sha256HexToBase64Checksum(hash: string): string {
    requireSha256Hash(hash);
    const hex = hash.slice('sha256:'.length);
    return Buffer.from(hex, 'hex').toString('base64');
}
