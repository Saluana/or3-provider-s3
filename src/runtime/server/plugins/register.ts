/**
 * Nitro server plugin — registers the S3 storage adapter.
 */
import { registerStorageGatewayAdapter } from '~~/server/storage/gateway/registry';
import { validateS3StorageConfig } from '../storage/s3-config';
import { createS3StorageGatewayAdapter } from '../storage/s3-storage-gateway-adapter';

export default defineNitroPlugin(() => {
    const config = useRuntimeConfig();
    const diagnostics = validateS3StorageConfig(config);
    for (const warning of diagnostics.warnings) {
        console.warn(`[or3-provider-s3] ${warning}`);
    }

    if (!diagnostics.config.authEnabled || !diagnostics.config.storageEnabled) return;
    if (diagnostics.config.providerId !== 's3') return;

    if (!diagnostics.isValid) {
        const message = `${diagnostics.errors.join(' ')} Install/configure s3 storage provider env values and restart.`;
        throw new Error(message);
    }

    registerStorageGatewayAdapter({
        id: 's3',
        order: 100,
        create: createS3StorageGatewayAdapter,
    });
});
