import { networkInterfaces } from "node:os";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

const ENV_DIR = "../.."; // read VITE_* (and PORT for the proxy) from the repo-root .env

/** LAN IPv4 addresses of this machine, for the "open on your phone" hint. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

function phoneHint(https: boolean): Plugin {
  return {
    name: "sitesight-phone-hint",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const port = server.config.server.port ?? 5173;
        const urls = lanAddresses().map((ip) => `${https ? "https" : "http"}://${ip}:${port}/`);
        if (!urls.length) return;
        console.log(`\n  Phone (same Wi-Fi): ${urls.join("  or  ")}`);
        if (!https) console.log("  Camera capture on most phones needs HTTPS: use `pnpm dev:web:https` instead.\n");
        else console.log("  Accept the self-signed certificate warning once on the phone.\n");
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, "");
  const https = mode === "https";
  const apiTarget = `http://localhost:${env.PORT || "8787"}`;

  return {
    envDir: ENV_DIR,
    server: {
      host: true, // listen on the LAN so a phone can connect
      // Same-origin API in dev: the browser calls /api/*, Vite forwards to the API. Works over HTTPS and from a phone.
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, "") },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(https ? [basicSsl()] : []),
      phoneHint(https),
      VitePWA({
        registerType: "autoUpdate",
        // Never answer API URLs (/api, served by the same Railway service) with the cached app shell.
        workbox: { navigateFallbackDenylist: [/^\/api\//] },
        includeAssets: ["icon.svg"],
        manifest: {
          name: "SiteSight",
          short_name: "SiteSight",
          description: "AI site-progress auditor for construction contractors",
          theme_color: "#1f2937",
          background_color: "#ffffff",
          display: "standalone",
          start_url: "/",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
        },
      }),
    ],
  };
});
