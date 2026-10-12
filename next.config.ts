import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * A dev server reached by IP as well as by name is still the same server, but Next will not run
   * its dev protocol for a host it was not told about - the page arrives fully rendered and stays
   * inert, with no error anywhere. Naming both hosts keeps `127.0.0.1` a working way to look at it.
   */
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
