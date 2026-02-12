import { describe, expect, it } from 'vitest';
import { buildS3ObjectKey, buildS3MarkerKey, sha256HexToBase64Checksum } from '../s3-keys';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('s3-keys', () => {
    it('builds deterministic object key', () => {
        expect(
            buildS3ObjectKey({ keyPrefix: 'or3/', workspaceId: 'ws_1', hash: HASH })
        ).toBe(`or3/ws_1/${HASH}`);
    });

    it('builds marker key', () => {
        expect(buildS3MarkerKey(`ws_1/${HASH}`)).toBe(`ws_1/${HASH}.meta.json`);
    });

    it('computes base64 checksum from sha256 hash', () => {
        const checksum = sha256HexToBase64Checksum(HASH);
        expect(typeof checksum).toBe('string');
        expect(checksum.length).toBeGreaterThan(0);
    });
});
