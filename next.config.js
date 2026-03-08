/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  serverExternalPackages: ['unpdf'],
  experimental: {
    serverActions: {}, // previously: serverActions: true,
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