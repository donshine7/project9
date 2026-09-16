import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type ViteDevServer } from 'vite';
import { localApiMiddleware } from './local-api';

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
    },
    css: { postcss: { plugins: [tailwindcss()] } },
    plugins: [
      {
        name: 'local-project-api',
        configureServer(server: ViteDevServer) {
          server.middlewares.use(localApiMiddleware());
        },
      },
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          main: 'vinext/server/fetch-handler',
          compatibility_flags: ['nodejs_compat'],
        },
      }),
    ],
  };
});
