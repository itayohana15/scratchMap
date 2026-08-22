// The isolated itinerary-tests build (tsconfig.itinerary-tests.json) uses a
// plain ES2020 lib without Next.js's ambient type augmentations, but
// country-itinerary-generation.ts uses `fetch(url, { next: { revalidate } })`
// — a Next.js-specific extension to RequestInit. This shim mirrors just that
// one augmentation (see node_modules/next/types/global.d.ts) so the test
// build can type-check that file without pulling in the full Next.js
// ambient type set. Test-only; does not affect the main app build.
interface NextFetchRequestConfig {
  revalidate?: number | false;
  tags?: string[];
}

interface RequestInit {
  next?: NextFetchRequestConfig | undefined;
}
