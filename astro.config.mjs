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
