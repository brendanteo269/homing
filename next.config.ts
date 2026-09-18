import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Several sibling projects share this parent directory; pin the root so the
  // build does not walk up and adopt one of their lockfiles.
  outputFileTracingRoot: import.meta.dirname,
  // The HDB block dataset is read from disk at request time rather than
  // imported, so nothing in the module graph points at it and the build would
  // otherwise leave it behind — and the deployed app would quietly fall back
  // to inferring every height from OpenStreetMap.
  outputFileTracingIncludes: {
    "/api/analyse": ["./data/hdb-blocks.json.gz", "./data/masterplan.json.gz"],
  },
};

export default nextConfig;
