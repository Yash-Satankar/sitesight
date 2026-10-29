import { env } from "../config.js";

const configured = new Set(
  env.WEB_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Hostnames on the local network: localhost, private IPv4 ranges, mDNS *.local. */
export function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".local")) return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Browser origins the API answers with CORS headers: WEB_ORIGIN (comma-separated), plus — in development
 * (ALLOW_LAN_ORIGINS) — any http(s) origin on the local network, so a phone on the same Wi-Fi works.
 * Requests without an Origin (curl, server-side, same-origin via the Vite proxy) are always allowed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (configured.has(origin)) return true;
  if (!env.ALLOW_LAN_ORIGINS) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}
