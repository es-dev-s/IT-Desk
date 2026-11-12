import os from "node:os";
import type { NextConfig } from "next";

/** This machine's LAN IPv4 addresses, so the dev server serves its JS/HMR to other PCs. */
const lanHosts = Object.entries(os.networkInterfaces())
  .filter(([name]) => !/^(lo|docker|br-|virbr|veth|vmnet|vboxnet|cni|flannel|cali|podman|kube)/.test(name))
  .flatMap(([, addrs]) => addrs ?? [])
  .filter((a) => a.family === "IPv4" && !a.internal)
  .map((a) => a.address);
const extraHosts = (process.env.ALLOWED_DEV_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  devIndicators: false,
  allowedDevOrigins: [...lanHosts, ...extraHosts],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
