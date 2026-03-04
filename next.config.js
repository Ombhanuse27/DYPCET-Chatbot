/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: {
    serverActions: {}, // previously: serverActions: true,
  },
  outputFileTracingIncludes: {
  '/api/chat': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.js'],
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
