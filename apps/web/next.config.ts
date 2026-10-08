import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@productspy/shared'],
  poweredByHeader: false,
  devIndicators: false,
};
export default config;
