const AI_TAGS = [
  'ai',
  'ml',
  'llm',
  'llms',
  'generative-ai',
  'ai-assistant',
  'ai-agents',
  'robotics',
  'computer-vision',
  'nlp',
  'mlops',
  'ai-infrastructure',
  'foundation-models',
  'ai-coding',
  'autonomous-vehicles',
  'voice-ai',
  // YC API format variations
  'artificial intelligence',
  'machine learning',
  'generative ai',
] as const;

const BATCHES = [
  'winter-2023',
  'summer-2023',
  'winter-2024',
  'summer-2024',
  'winter-2025',
  'spring-2025',
  'summer-2025',
  'fall-2025',
  'winter-2026',
  'spring-2026',
];

interface YCCompany {
  id: number;
  name: string;
  slug: string;
  website: string;
  small_logo_thumb_url?: string;
  logo_url?: string;
  one_liner?: string;
  long_description?: string;
  batch: string;
  tags: string[];
}

interface ScrapedCompany {
  id: string;
  slug: string;
  name: string;
  yc_batch: string;
  website: string;
  logo_url: string | null;
  description: string | null;
  careers_url: string | null;
  created_at: number;
}

function hasAITag(tags: string[]): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
  const normalizedAITags = AI_TAGS.map(normalize);
  
  for (const tag of tags) {
    const normalizedTag = normalize(tag);
    if (normalizedAITags.includes(normalizedTag)) {
      return true;
    }
  }
  
  return false;
}

function mapCompany(company: YCCompany, careersUrl: string | null): ScrapedCompany {
  return {
    id: company.slug,
    slug: company.slug,
    name: company.name,
    yc_batch: company.batch,
    website: company.website,
    logo_url: company.small_logo_thumb_url || company.logo_url || null,
    description: company.one_liner || company.long_description || null,
    careers_url: careersUrl,
    created_at: Date.now(),
  };
}

export async function scrapeYC(): Promise<ScrapedCompany[]> {
  const allCompanies: ScrapedCompany[] = [];

  for (const batch of BATCHES) {
    const url = `https://yc-oss.github.io/api/batches/${batch}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`failed to fetch ${batch}: ${response.status}`);
      continue;
    }

    const companies = (await response.json()) as YCCompany[];
    const aiCompanies = companies.filter(c => hasAITag(c.tags));

    console.log(`${batch}: ${aiCompanies.length} AI companies out of ${companies.length}`);

    for (const company of aiCompanies) {
      allCompanies.push(mapCompany(company, null));
    }
  }

  return allCompanies;
}

export { hasAITag, mapCompany };
