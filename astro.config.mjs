import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { getAllActiveListings } from './src/lib/db';
import { getJobPath } from './src/lib/jobs';

const activeListings = await getAllActiveListings();
const SITE_URL = process.env.PUBLIC_SITE_URL ?? 'https://ai-native-jobs.tommyato.com';
const jobLastmodByUrl = new Map(
  activeListings.map((listing) => [new URL(getJobPath(listing), SITE_URL).href.replace(/\/$/, ''), new Date(listing.updated_at)])
);

export default defineConfig({
  adapter: node({
    mode: 'standalone',
  }),
  // CSRF origin check disabled: Astro builds request URL as http:// from the upstream
  // socket while the browser sends Origin: https://, so they never match behind Caddy.
  // No cookie-auth surface here; state-changing actions go through Stripe webhooks,
  // which are signature-verified in src/pages/api/stripe/webhook.ts.
  security: {
    checkOrigin: false,
  },
  integrations: [
    sitemap({
      serialize(item) {
        const normalizedUrl = item.url.replace(/\/$/, '');
        const lastmod = jobLastmodByUrl.get(normalizedUrl);

        if (!lastmod) {
          return item;
        }

        return {
          ...item,
          lastmod: lastmod.toISOString(),
        };
      },
    }),
  ],
  outDir: 'dist',
  output: 'static',
  site: SITE_URL,
  vite: {
    plugins: [tailwindcss()],
  },
});
