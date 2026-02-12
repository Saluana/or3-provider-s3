import { defineNuxtModule, addServerPlugin, createResolver } from '@nuxt/kit';

export default defineNuxtModule({
    meta: { name: 'or3-provider-s3' },
    setup(_options: Record<string, unknown>, _nuxt: unknown) {
        const { resolve } = createResolver(import.meta.url);
        addServerPlugin(resolve('runtime/server/plugins/register'));
    },
});
