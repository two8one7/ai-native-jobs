import type { ListingListRow } from './db';

type JobPostingJsonLd = {
  '@context': 'https://schema.org';
  '@type': 'JobPosting';
  title: string;
  description: string;
  datePosted: string;
  validThrough: string;
  hiringOrganization: {
    '@type': 'Organization';
    name: string;
    sameAs?: string;
  };
  jobLocation?: {
    '@type': 'Place';
    address: {
      '@type': 'PostalAddress';
      addressLocality?: string;
      addressCountry: string;
    };
  };
  jobLocationType?: 'TELECOMMUTE';
  baseSalary?: {
    '@type': 'MonetaryAmount';
    currency?: string;
    value: {
      '@type': 'QuantitativeValue';
      minValue?: number;
      maxValue?: number;
      unitText: 'YEAR';
    };
  };
  employmentType: 'FULL_TIME';
};

type SalaryValue = {
  '@type': 'QuantitativeValue';
  minValue?: number;
  maxValue?: number;
  unitText: 'YEAR';
};

type BaseSalary = {
  '@type': 'MonetaryAmount';
  currency?: string;
  value: SalaryValue;
};

function buildHiringOrganization(listing: ListingListRow): JobPostingJsonLd['hiringOrganization'] {
  const sameAs = listing.company_website?.trim();

  return sameAs
    ? {
        '@type': 'Organization',
        name: listing.company_name,
        sameAs,
      }
    : {
        '@type': 'Organization',
        name: listing.company_name,
      };
}

function buildJobLocation(listing: ListingListRow): JobPostingJsonLd['jobLocation'] | undefined {
  if (listing.location_is_remote) {
    return undefined;
  }

  return {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: listing.location_city ?? undefined,
      addressCountry: listing.location_country,
    },
  };
}

function buildBaseSalary(listing: ListingListRow): JobPostingJsonLd['baseSalary'] | undefined {
  if (listing.comp_min == null && listing.comp_max == null) {
    return undefined;
  }

  const value: SalaryValue = {
    '@type': 'QuantitativeValue',
    unitText: 'YEAR',
  };

  if (listing.comp_min != null) {
    value.minValue = listing.comp_min;
  }

  if (listing.comp_max != null) {
    value.maxValue = listing.comp_max;
  }

  const baseSalary: BaseSalary = {
    '@type': 'MonetaryAmount',
    value,
  };

  if (listing.comp_currency) {
    baseSalary.currency = listing.comp_currency;
  }

  return baseSalary;
}

export function buildJobPostingJsonLd(listing: ListingListRow): JobPostingJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: listing.title,
    description: listing.description_html,
    datePosted: new Date(listing.posted_at).toISOString(),
    validThrough: new Date(listing.expires_at).toISOString(),
    hiringOrganization: buildHiringOrganization(listing),
    jobLocation: buildJobLocation(listing),
    jobLocationType: listing.location_is_remote ? 'TELECOMMUTE' : undefined,
    baseSalary: buildBaseSalary(listing),
    employmentType: 'FULL_TIME',
  };
}
