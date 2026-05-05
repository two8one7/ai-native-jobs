import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [sitemap()],
  outDir: 'dist',
  output: 'static',
  site: 'https://ai-native-jobs.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
