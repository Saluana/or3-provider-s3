import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
    resolve: { alias: [
        { find: '~~/', replacement: resolve(process.env.OR3_PROJECT_HOST_ROOT || '../or3-chat') + '/' },
        { find: '#imports', replacement: resolve('src/shims/imports.ts') },
        ...(process.env.OR3_S3_ARTIFACT_ROOT ? ['s3-generations', 's3-generation-gateway'].map(name => ({
            find: `../src/runtime/server/storage/${name}`,
            replacement: resolve(process.env.OR3_S3_ARTIFACT_ROOT!, `dist/runtime/server/storage/${name}.js`),
        })) : []),
        {
            find: /^#sqlite-runtime\/(.*)$/,
            replacement: resolve(process.env.OR3_SQLITE_ARTIFACT_ROOT || 'node_modules/or3-provider-sqlite', 'dist/runtime') + '/$1.js',
        },
    ] },
    test: { include: ['integration/s3-generations.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false,
        server: { deps: { inline: [/or3-provider-s3/, /or3-provider-sqlite/] } },
    },
});
