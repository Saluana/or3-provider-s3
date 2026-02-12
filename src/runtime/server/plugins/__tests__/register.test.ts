import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerStorageGatewayAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('~~/server/storage/gateway/registry', () => ({
    registerStorageGatewayAdapter: registerStorageGatewayAdapterMock as unknown,
}));

describe('s3 register plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        registerStorageGatewayAdapterMock.mockReset();

        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        delete process.env.OR3_STORAGE_S3_ENDPOINT;
        delete process.env.OR3_STORAGE_S3_URL_TTL_SECONDS;

        (globalThis as typeof globalThis & { defineNitroPlugin?: unknown }).defineNitroPlugin =
            (plugin: () => unknown) => plugin();
        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 's3' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 's3' } },
        });
    });

    it('registers adapter when config is valid', async () => {
        await import('../register');
        expect(registerStorageGatewayAdapterMock).toHaveBeenCalledWith({
            id: 's3',
            order: 100,
            create: expect.any(Function),
        });
    });

    it('fails startup when selected s3 provider config is invalid', async () => {
        delete process.env.OR3_STORAGE_S3_BUCKET;

        await expect(import('../register')).rejects.toThrow('Missing OR3_STORAGE_S3_BUCKET.');
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });

    it('skips registration when s3 provider is not active', async () => {
        delete process.env.OR3_STORAGE_S3_BUCKET;
        (globalThis as typeof globalThis & { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
            auth: { enabled: true, strict: false },
            storage: { enabled: true, provider: 'convex' },
            public: { auth: { enabled: true }, storage: { enabled: true, provider: 'convex' } },
        });

        await expect(import('../register')).resolves.toBeDefined();
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
    });
});
