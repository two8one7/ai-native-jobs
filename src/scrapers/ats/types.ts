import type { Listing, ListingAISpecialty, ListingLocationPolicy } from '../../db/types';

export type ATSProvider =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'workday'
  | 'notion';

export type DetectResult = {
  provider: ATSProvider | null;
  slug: string | null;
};

export type RawJob = {
  provider: ATSProvider;
  providerJobId: string;
  title: string;
  location: string | null;
  description: string;
  applyUrl: string;
  postedAt: number | string | null;
};

export type NormalizeContext = {
  companyId: string;
  provider: ATSProvider;
  providerSlug: string;
};

export type AIJobListing = Listing;

export type LocationFields = {
  location_city: string | null;
  location_country: string;
  location_is_remote: number;
  location_policy: ListingLocationPolicy;
};

export type CompensationFields = Pick<
  Listing,
  'comp_min' | 'comp_max' | 'comp_currency' | 'comp_equity'
>;

export type AISignalFields = Pick<
  Listing,
  'ai_stack' | 'ai_specialty' | 'ai_compute_access'
>;

export type SpecialtyMatcher = {
  specialty: ListingAISpecialty;
  pattern: RegExp;
};
