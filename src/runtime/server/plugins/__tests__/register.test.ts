import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerProviderAdminAdapterMock = vi.hoisted(() => vi.fn());

const registerStorageGatewayAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('nitropack/runtime/plugin', () => ({
    defineNitroPlugin: (plugin: () => unknown) => plugin(),
}));

vi.mock('~~/server/storage/gateway/registry', () => ({
    registerStorageGatewayAdapter: registerStorageGatewayAdapterMock as unknown,
}));

vi.mock('~~/server/admin/providers/registry', () => ({
    registerProviderAdminAdapter: registerProviderAdminAdapterMock,
}));

describe('s3 register plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        registerStorageGatewayAdapterMock.mockReset();
        registerProviderAdminAdapterMock.mockReset();

        process.env.OR3_STORAGE_S3_REGION = 'us-east-1';
        process.env.OR3_STORAGE_S3_BUCKET = 'bucket';
        process.env.OR3_STORAGE_S3_ACCESS_KEY_ID = 'ak';
        process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY = 'sk';
        delete process.env.OR3_STORAGE_S3_ENDPOINT;
        delete process.env.OR3_STORAGE_S3_URL_TTL_SECONDS;
        delete process.env.OR3_STORAGE_S3_ALLOW_INSECURE_HTTP;

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

    it('registers admin diagnostics without exposing credentials and reports disabled GC', async () => {
        await import('../register');
        const admin = registerProviderAdminAdapterMock.mock.calls[0]?.[0];
        expect(admin).toBeDefined();
        const status = await admin.getStatus({}, { enabled: true, provider: 's3' });
        expect(status.details).toMatchObject({ bucket: 'bucket', gcStatus: 'disabled', gcDisabledReason: 'deletion_coordination_required' });
        expect(status.details).not.toHaveProperty('accessKeyId');
        expect(status.details).not.toHaveProperty('secretAccessKey');
        expect(status.details).not.toHaveProperty('sessionToken');
        expect(await admin.runAction({}, 'storage.gc', undefined, {
            session: { workspace: { id: 'ws1' } }, enabled: true, provider: 's3',
        })).toEqual({ deleted_count: 0, status: 'disabled', reason: 'deletion_coordination_required' });
        await expect(admin.runAction({}, 'unknown', undefined, { session: {} })).rejects.toMatchObject({ statusCode: 400 });
        await expect(admin.runAction({}, 'storage.gc', undefined, { session: {} })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('fails startup when selected s3 provider config is invalid', async () => {
        delete process.env.OR3_STORAGE_S3_BUCKET;

        await expect(import('../register')).rejects.toThrow('Missing OR3_STORAGE_S3_BUCKET.');
        expect(registerStorageGatewayAdapterMock).not.toHaveBeenCalled();
        expect(registerProviderAdminAdapterMock).not.toHaveBeenCalled();
    });

    it('fails startup on insecure HTTP endpoint unless explicitly allowed', async () => {
        process.env.OR3_STORAGE_S3_ENDPOINT = 'http://localhost:9000';

        await expect(import('../register')).rejects.toThrow(
            'OR3_STORAGE_S3_ENDPOINT must use HTTPS unless OR3_STORAGE_S3_ALLOW_INSECURE_HTTP=true is explicitly set.'
        );
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
