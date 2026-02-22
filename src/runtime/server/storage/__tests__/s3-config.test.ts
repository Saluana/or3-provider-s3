import { afterEach, describe, expect, it } from 'vitest';
import { resolveS3UrlTtlSeconds, validateS3StorageConfig } from '../s3-config';

function makeRuntimeConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof useRuntimeConfig> {
    return {
        auth: { enabled: true, strict: false },
        storage: { enabled: true, provider: 's3' },
        public: { auth: { enabled: true }, storage: { enabled: true, provider: 's3' } },
        ...overrides,
    } as ReturnType<typeof useRuntimeConfig>;
}

describe('s3-config', () => {
    afterEach(() => {
        delete process.env.OR3_STORAGE_S3_URL_TTL_SECONDS;
        delete process.env.OR3_STORAGE_S3_ENDPOINT;
        delete process.env.OR3_STORAGE_S3_REGION;
        delete process.env.OR3_STORAGE_S3_BUCKET;
        delete process.env.OR3_STORAGE_S3_ACCESS_KEY_ID;
        delete process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY;
        delete process.env.OR3_STORAGE_S3_SESSION_TOKEN;
        delete process.env.OR3_STORAGE_S3_FORCE_PATH_STYLE;
        delete process.env.OR3_STORAGE_S3_KEY_PREFIX;
        delete process.env.OR3_STORAGE_S3_REQUIRE_CHECKSUM;
        delete process.env.OR3_STORAGE_S3_ALLOW_INSECURE_HTTP;
    });

    it('rejects invalid TTL env values', () => {
        process.env.OR3_STORAGE_S3_URL_TTL_SECONDS = 'not-a-number';
        expect(() => resolveS3UrlTtlSeconds()).toThrow(
            'OR3_STORAGE_S3_URL_TTL_SECONDS must be an integer between 1 and 86400.'
        );
    });

    it('rejects out-of-range TTL env values', () => {
        process.env.OR3_STORAGE_S3_URL_TTL_SECONDS = '0';
        expect(() => resolveS3UrlTtlSeconds()).toThrow(
            'OR3_STORAGE_S3_URL_TTL_SECONDS must be between 1 and 86400.'
        );
    });

    it('accepts valid TTL from env', () => {
        process.env.OR3_STORAGE_S3_URL_TTL_SECONDS = '120';
        expect(resolveS3UrlTtlSeconds()).toBe(120);
    });

    it('validates required env vars', () => {
        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(false);
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_S3_REGION.');
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_S3_BUCKET.');
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_S3_ACCESS_KEY_ID.');
        expect(diagnostics.errors).toContain('Missing OR3_STORAGE_S3_SECRET_ACCESS_KEY.');
    });

    it('accepts valid config values', () => {
        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';

        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(true);
        expect(diagnostics.config.keyPrefix).toBe('');
    });

    it('normalizes key prefix with trailing slash', () => {
        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        process.env.OR3_STORAGE_S3_KEY_PREFIX = '/or3/storage/';

        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(true);
        expect(diagnostics.config.keyPrefix).toBe('or3/storage/');
    });

    it('rejects invalid endpoint URL', () => {
        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        process.env.OR3_STORAGE_S3_ENDPOINT = 'not-a-url';

        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(false);
        expect(diagnostics.errors).toContain('OR3_STORAGE_S3_ENDPOINT must be a valid URL.');
    });

    it('fails closed for insecure HTTP endpoint by default', () => {
        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        process.env.OR3_STORAGE_S3_ENDPOINT = 'http://localhost:9000';

        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(false);
        expect(diagnostics.errors).toContain(
            'OR3_STORAGE_S3_ENDPOINT must use HTTPS unless OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true is explicitly set.'
        );
    });

    it('allows explicit insecure HTTP endpoint override for local dev', () => {
        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        process.env.OR3_STORAGE_S3_ENDPOINT = 'http://localhost:9000';
        process.env.OR3_STORAGE_S3_ALLOW_INSECURE_HTTP = 'true';

        const diagnostics = validateS3StorageConfig(makeRuntimeConfig());
        expect(diagnostics.isValid).toBe(true);
    });
});
