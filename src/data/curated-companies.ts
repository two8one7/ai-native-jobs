export type CuratedCompany = {
  slug: string;
  name: string;
  website: string;
  careers_url: string;
  description: string;
};

export const CURATED_COMPANIES: CuratedCompany[] = [
  {
    slug: 'astrocade',
    name: 'Astrocade',
    website: 'https://astrocade.com',
    careers_url: 'https://jobs.ashbyhq.com/astrocade',
    description: 'Social Gaming Universe — AI-powered game creation platform.',
  },
  {
    slug: 'anthropic',
    name: 'Anthropic',
    website: 'https://anthropic.com',
    careers_url: 'https://boards.greenhouse.io/anthropic',
    description: 'AI safety and research company building Claude, a reliable and steerable AI assistant.',
  },
  {
    slug: 'mistral',
    name: 'Mistral AI',
    website: 'https://mistral.ai',
    careers_url: 'https://jobs.lever.co/mistral',
    description: 'Building frontier AI models with a focus on efficiency and open innovation.',
  },
  {
    slug: 'cohere',
    name: 'Cohere',
    website: 'https://cohere.com',
    careers_url: 'https://jobs.lever.co/cohere',
    description: 'Enterprise AI platform providing language models and retrieval-augmented generation.',
  },
  {
    slug: 'perplexity',
    name: 'Perplexity AI',
    website: 'https://perplexity.ai',
    careers_url: 'https://jobs.ashbyhq.com/Perplexity',
    description: 'AI-powered answer engine providing accurate, real-time information with citations.',
  },
  {
    slug: 'elevenlabs',
    name: 'ElevenLabs',
    website: 'https://elevenlabs.io',
    careers_url: 'https://boards.greenhouse.io/elevenlabs',
    description: 'AI voice technology platform for natural-sounding text-to-speech and voice cloning.',
  },
  {
    slug: 'runway',
    name: 'Runway',
    website: 'https://runwayml.com',
    careers_url: 'https://jobs.ashbyhq.com/runway',
    description: 'AI-powered creative tools for video generation, editing, and multimodal content.',
  },
  {
    slug: 'together',
    name: 'Together AI',
    website: 'https://together.ai',
    careers_url: 'https://jobs.lever.co/together',
    description: 'Cloud platform for building and deploying generative AI models at scale.',
  },
  {
    slug: 'modal',
    name: 'Modal',
    website: 'https://modal.com',
    careers_url: 'https://jobs.ashbyhq.com/modal',
    description: 'Serverless platform for running AI workloads and compute-intensive tasks.',
  },
  {
    slug: 'replicate',
    name: 'Replicate',
    website: 'https://replicate.com',
    careers_url: 'https://jobs.ashbyhq.com/replicate',
    description: 'Platform for running and deploying machine learning models with simple APIs.',
  },
  {
    slug: 'glean',
    name: 'Glean',
    website: 'https://glean.com',
    careers_url: 'https://boards.greenhouse.io/glean',
    description: 'Enterprise AI search platform connecting and understanding company knowledge.',
  },
  {
    slug: 'character-ai',
    name: 'Character.AI',
    website: 'https://character.ai',
    careers_url: 'https://jobs.ashbyhq.com/character',
    description: 'Platform for creating and conversing with AI-powered characters and assistants.',
  },
];
