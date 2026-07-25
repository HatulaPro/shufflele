import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Album art comes straight from Spotify's CDN via plain <img>, so no image
  // optimisation config is needed (and Hobby image transforms are metered).
};

export default nextConfig;
