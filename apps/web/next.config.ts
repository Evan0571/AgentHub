import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@agenthub/shared-types'],
  typedRoutes: true,
};

export default config;
