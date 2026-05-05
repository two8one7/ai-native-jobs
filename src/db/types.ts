export type Company = {
  id: string;
  slug: string;
  name: string;
  yc_batch: string | null;
  website: string | null;
  logo_url: string | null;
  description: string | null;
  created_at: number;
};

export type ListingStatus = 'active' | 'expired' | 'filled';
export type ListingLocationPolicy = 'remote' | 'hybrid' | 'onsite';
export type ListingAISpecialty = 'nlp' | 'vision' | 'robotics' | 'infra' | 'ops';

export type Listing = {
  id: string;
  company_id: string;
  title: string;
  location_city: string | null;
  location_country: string;
  location_is_remote: number;
  location_policy: ListingLocationPolicy;
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  comp_equity: number | null;
  ai_stack: string;
  ai_specialty: ListingAISpecialty | null;
  ai_compute_access: string | null;
  description_html: string;
  apply_url: string;
  posted_at: number;
  expires_at: number;
  updated_at: number;
  status: ListingStatus;
};
