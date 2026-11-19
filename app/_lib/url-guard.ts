import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.includes(":")) {
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const p = v.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

/** Parses the URL and rejects anything that resolves to a private / local address. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("That link is not valid."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only public HTTP(S) links are supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) throw new Error("Only public HTTP(S) links are supported.");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error("Could not resolve that host."); });
  if (addresses.some((a) => isPrivateIp(a.address))) throw new Error("Only public HTTP(S) links are supported.");
  return url;
}
