export type CuratedCompany = {
  slug: string;
  name: string;
  website: string;
  careers_url: string;
  description: string;
};

// Curated non-YC AI-native companies. Hand-maintained — Tommy adds entries as
// he flags them. Do NOT auto-populate from external lists; the gate is "Tommy
// says yes" (see issue #28). Slug must NOT collide with any YC company slug.
export const CURATED_COMPANIES: CuratedCompany[] = [
  {
    slug: 'astrocade',
    name: 'Astrocade',
    website: 'https://astrocade.com',
    careers_url: 'https://jobs.ashbyhq.com/astrocade',
    description: 'Social Gaming Universe — AI-powered game creation platform.',
  },
];
