import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  // The pipeline is written for tsx and node's ESM resolver, so every internal
  // import carries a `.js` specifier that actually points at a `.ts` file.
  // Webpack does not do that rewrite on its own, and the reading view imports
  // the publisher's modules. Aliasing here keeps one import convention across
  // the whole repo instead of making src/app an exception to it.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },

  // pg is a native-ish server package; it must not be traced into a bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
