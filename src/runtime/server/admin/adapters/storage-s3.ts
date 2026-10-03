import { useRuntimeConfig } from '#imports';
import { createError } from 'h3';
import type { ProviderAdminAdapter } from '~~/server/admin/providers/types';
import { validateS3StorageConfig } from '../../storage/s3-config';
import { createS3StorageGatewayAdapter } from '../../storage/s3-storage-gateway-adapter';

export const s3StorageAdminAdapter: ProviderAdminAdapter = {
    id: 's3',
    kind: 'storage',
    async getStatus() {
        const { config, errors, warnings } = validateS3StorageConfig(useRuntimeConfig());
        return {
            details: {
                endpoint: config.endpoint,
                region: config.region,
                bucket: config.bucket,
                keyPrefix: config.keyPrefix,
                forcePathStyle: config.forcePathStyle,
                credentialsConfigured: Boolean(config.accessKeyId && config.secretAccessKey),
                urlTtlSeconds: config.urlTtlSeconds,
                gcStatus: 'disabled',
                gcDisabledReason: 'deletion_coordination_required',
            },
            warnings: [
                ...warnings.map(message => ({ level: 'warning' as const, message })),
                ...errors.map(message => ({ level: 'error' as const, message })),
                { level: 'warning' as const, message: 'Destructive S3 blob deletion and GC require provider-owned coordination with canonical metadata and reference writes.' },
            ],
            actions: [{
                id: 'storage.gc', label: 'Check Storage GC Status',
                description: 'Reports that destructive GC is disabled; does not list or delete S3 objects.',
            }],
        };
    },
    async runAction(event, actionId, payload, ctx) {
        if (actionId !== 'storage.gc') throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
        if (!ctx.session.workspace?.id) throw createError({ statusCode: 400, statusMessage: 'Workspace not resolved' });
        return createS3StorageGatewayAdapter().gc(event, {
            workspace_id: ctx.session.workspace.id,
            retention_seconds: payload?.retentionSeconds ?? 30 * 24 * 3600,
            limit: payload?.limit,
        });
    },
};
