/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: {
    serverActions: {}, // previously: serverActions: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // pdf-parse's main entry tries to load a test PDF at require-time.
      // This file doesn't exist in the Vercel bundle and causes a build error.
      // Replacing it with an empty module stops webpack from trying to bundle it.
      config.resolve.alias['./test/unit/data/05-versions-space.pdf'] = false;
    }
    return config;
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        port: '',
        pathname: '**',
      },
    ],
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};