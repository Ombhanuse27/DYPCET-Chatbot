/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: {
    serverActions: {}, // previously: serverActions: true,
    // ✅ FIX: Prevent webpack from bundling pdfjs-dist.
    // When bundled, webpack replaces require.resolve() with a numeric module ID
    // (not a string), causing PDF.js's internal `.endsWith()` check to throw
    // "e.endsWith is not a function". Marking it external keeps it as a real
    // Node.js require at runtime, so require.resolve() returns an actual path.
     serverComponentsExternalPackages: ['pdfjs-dist'],
  },
  // ✅ Ensure the worker file (never directly imported, so missed by the tracer)
  // is included in the Vercel serverless function output bundle.
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