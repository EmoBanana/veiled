import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals.push({
      '@solana/kit': 'commonjs @solana/kit',
      '@react-native-async-storage/async-storage': 'commonjs @react-native-async-storage/async-storage'
    });
    return config;
  },
};

export default nextConfig;
