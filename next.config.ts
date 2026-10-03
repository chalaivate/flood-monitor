import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Standalone output keeps the Docker image small for self-hosting in Thailand.
  output: 'standalone',
  serverExternalPackages: ['web-push'],
}

export default nextConfig
