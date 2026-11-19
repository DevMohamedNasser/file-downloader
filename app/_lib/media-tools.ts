import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export const exec = promisify(execFile);
export const ytDlp = process.env.YT_DLP_PATH || path.join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/yt-dlp.exe" : "bin/yt-dlp");
const python = path.join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/**
 * Finds a real ffmpeg binary. Under Turbopack, `ffmpeg-static` can return a bundler-virtual path
 * (like /ROOT/node_modules/...) that does not exist, so we verify it and fall back to node_modules.
 */
export function ffmpegLocation(): string | undefined {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;
  const local = path.join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(local) ? local : undefined; // otherwise rely on a system-installed ffmpeg
}

export async function mediaToolEnv() {
  let certFile = process.env.SSL_CERT_FILE;
  if (!certFile) {
    try { certFile = (await exec(python, ["-c", "import certifi; print(certifi.where())"], { timeout: 10_000 })).stdout.trim(); }
    catch { certFile = undefined; }
  }
  const ffmpeg = ffmpegLocation();
  return {
    ...process.env,
    ...(certFile ? { SSL_CERT_FILE: certFile, REQUESTS_CA_BUNDLE: certFile } : {}),
    ...(ffmpeg ? { PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH || ""}` } : {}),
  };
}

export function mediaError(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String(error.stderr || "");
    const detail = stderr.split("\n").map((line) => line.trim()).filter((line) => /^ERROR:|^WARNING:/i.test(line)).at(-1);
    if (detail) return detail.replace(/^ERROR:\s*/i, "").slice(0, 260);
  }
  if (error instanceof Error && error.message.includes("ENOENT")) return fallback;
  return fallback;
}
