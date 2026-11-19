import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec, ffmpegLocation, mediaToolEnv, ytDlp } from "@/app/_lib/media-tools";

export type JobState = "running" | "paused" | "complete" | "error" | "canceled";

export type DownloadJob = {
  id: string;
  state: JobState;
  stage: "downloading" | "processing";
  progress: number; // 0-100
  speed: number; // bytes/s (smoothed)
  eta: number | null; // seconds
  downloaded: number;
  total: number;
  item: number;
  items: number;
  folder: string;
  filename?: string;
  size?: number;
  contentType?: string;
  error?: string;
  // internal
  args: string[];
  child?: ChildProcess;
  stop?: "pause" | "cancel";
  streams: Map<string, { d: number; t: number }>;
  stderr: string;
  activeMs: number;
  segmentStart: number;
  touched: number;
};

// Survives Next.js hot reloads in dev.
const g = globalThis as unknown as { __droplyJobs?: Map<string, DownloadJob> };
const jobs = (g.__droplyJobs ??= new Map<string, DownloadJob>());

const TEMPLATE =
  "download:DLP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.playlist_index)s|%(info.n_entries)s|%(progress.filename)s";

const types: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".tar": "application/x-tar",
  ".zip": "application/zip", ".pdf": "application/pdf",
};
const typeFor = (name: string) => types[path.extname(name).toLowerCase()] || "application/octet-stream";
const num = (v?: string) => { const x = Number(v); return v && v !== "NA" && Number.isFinite(x) ? x : 0; };

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
}

export async function startMediaDownload(url: URL, mode: string, quality: string) {
  // Drop abandoned paused jobs (tab closed) so temp files don't pile up.
  for (const j of jobs.values()) {
    if (j.state === "paused" && Date.now() - j.touched > 2 * 60 * 60 * 1000) { jobs.delete(j.id); void rm(j.folder, { recursive: true, force: true }); }
  }

  const id = randomUUID();
  const folder = await mkdtemp(path.join(tmpdir(), "droply-"));
  const audio = mode === "audio";
  const height = /^(\d{3,4})p$/.exec(quality)?.[1];
  const output = path.join(folder, "%(playlist_index&{}-|)s%(title)s.%(ext)s");

  const ffmpeg = ffmpegLocation();
  const args = [
    "--newline", "--no-warnings", "--no-mtime", "--windows-filenames", "--trim-filenames", "150",
    // Speed: parallel fragments + chunked HTTP (avoids per-connection throttling) + sturdy retries.
    "-N", "8", "--http-chunk-size", "10M", "--retries", "10", "--fragment-retries", "10", "--socket-timeout", "20",
    "-o", output,
    "--progress-template", TEMPLATE,
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    ...(process.env.YT_DLP_COOKIES ? ["--cookies", process.env.YT_DLP_COOKIES] : []),
    ...(audio
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : [
          // Always video + audio streams merged into one file (needs ffmpeg), with a single-file fallback.
          "-f", height ? `bv*[height<=${height}]+ba/b[height<=${height}]/b` : "bv*+ba/b",
          "-S", "res,vcodec:h264,acodec:m4a",
          "--merge-output-format", "mp4",
        ]),
    "--", url.toString(),
  ];

  const job: DownloadJob = {
    id, state: "running", stage: "downloading", progress: 0, speed: 0, eta: null, downloaded: 0, total: 0,
    item: 1, items: 1, folder, args, streams: new Map(), stderr: "", activeMs: 0, segmentStart: Date.now(), touched: Date.now(),
  };
  jobs.set(id, job);
  run(job);
  return job;
}

function onLine(job: DownloadJob, line: string) {
  if (!line.startsWith("DLP|")) {
    if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|FixupM4a|FixupM3u8|Fixup)/.test(line)) job.stage = "processing";
    return;
  }
  const [, , dl, tot, est, spd, fi, fc, idx, n, ...name] = line.split("|");
  const item = num(idx) || 1;
  if (item !== job.item) { job.item = item; job.streams.clear(); job.stage = "downloading"; }
  job.items = num(n) || 1;

  const downloaded = num(dl);
  let total = num(tot) || num(est);
  if (!total && num(fi) > 0 && num(fc) > 0) total = (downloaded / num(fi)) * num(fc); // fragment-based estimate
  job.streams.set(name.join("|"), { d: downloaded, t: total });

  let d = 0, t = 0;
  for (const s of job.streams.values()) { d += s.d; t += s.t; }
  job.downloaded = d; job.total = t;

  const overall = (((item - 1) + (t > 0 ? Math.min(1, d / t) : 0)) / job.items) * 100;
  job.progress = Math.min(99.9, Math.max(job.progress, overall)); // never goes backwards (video then audio stream)

  const s = num(spd);
  if (s) job.speed = job.speed ? job.speed * 0.7 + s * 0.3 : s;

  if (job.items > 1) {
    const elapsed = (job.activeMs + Date.now() - job.segmentStart) / 1000;
    const p = job.progress / 100;
    job.eta = p > 0.01 ? Math.round((elapsed * (1 - p)) / p) : null;
  } else {
    job.eta = job.speed > 0 && t > d ? Math.round((t - d) / job.speed) : null;
  }
}

function run(job: DownloadJob) {
  job.state = "running";
  job.stop = undefined;
  job.stderr = "";
  job.segmentStart = Date.now();

  void (async () => {
    try {
      const env = await mediaToolEnv();
      await new Promise<void>((resolve, reject) => {
        if (job.stop) return reject(new Error("stopped"));
        const child = spawn(ytDlp, job.args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        job.child = child;
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) onLine(job, line);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { job.stderr = (job.stderr + chunk).slice(-12000); });
        child.once("error", reject);
        child.once("close", (code) => {
          job.child = undefined;
          if (code === 0) resolve();
          else reject(Object.assign(new Error(`yt-dlp exited with ${code}`), { stderr: job.stderr }));
        });
      });

      const names = (await readdir(job.folder)).filter((n) => !/\.(part|ytdl|temp|tmp)$/i.test(n) && !/\.f\d+\.[a-z0-9]+$/i.test(n));
      if (!names.length) {
        const leftovers = (await readdir(job.folder)).some((n) => /\.f\d+\./.test(n));
        throw new Error(leftovers
          ? "ffmpeg was not found, so video and audio could not be merged. Install ffmpeg or set FFMPEG_PATH."
          : "The source did not return any media files.");
      }
      let name = names[0];
      if (names.length > 1) {
        name = "playlist.tar"; // media is already compressed, so no gzip: much faster
        await exec("tar", ["-cf", path.join(job.folder, name), "-C", job.folder, "--", ...names]);
      }
      job.filename = name;
      job.contentType = typeFor(name);
      job.size = (await stat(path.join(job.folder, name))).size;
      job.progress = 100; job.speed = 0; job.eta = 0; job.stage = "downloading";
      job.state = "complete";
      console.log("[droply] complete", job.filename, job.size);
      setTimeout(() => { jobs.delete(job.id); void rm(job.folder, { recursive: true, force: true }); }, 60 * 60 * 1000).unref();
    } catch (error) {
      job.activeMs += Date.now() - job.segmentStart;
      job.child = undefined;
      if (job.stop === "pause") { job.state = "paused"; job.speed = 0; job.eta = null; return; } // .part files stay → resume continues
      if (job.stop === "cancel") { finishCancel(job); return; }
      const lines = job.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
      const detail = lines.filter((l) => /^ERROR:/i.test(l)).at(-1) ?? lines.at(-1);
      const code = (error as NodeJS.ErrnoException)?.code;
      const own = error instanceof Error && !error.message.startsWith("yt-dlp exited") ? error.message : "";
      job.error = (code === "ENOENT"
        ? "yt-dlp was not found on the server. Check the .venv folder or the YT_DLP_PATH variable."
        : own || detail?.replace(/^ERROR:\s*/i, "") || "Could not download this source.").slice(0, 260);
      console.error("[droply] job failed:", job.error, "\n--- yt-dlp output ---\n" + job.stderr.slice(-1500));
      job.state = "error";
      void rm(job.folder, { recursive: true, force: true });
    }
  })();
}

function finishCancel(job: DownloadJob) {
  job.state = "canceled"; job.speed = 0; job.eta = null;
  void rm(job.folder, { recursive: true, force: true });
  setTimeout(() => jobs.delete(job.id), 60 * 1000).unref();
}

export function pauseJob(job: DownloadJob) {
  if (job.state !== "running") return false;
  job.stop = "pause";
  if (job.child) killTree(job.child);
  return true;
}

export function resumeJob(job: DownloadJob) {
  if (job.state !== "paused" || job.child) return false;
  run(job); // yt-dlp continues from the .part / .ytdl files
  return true;
}

export function cancelJob(job: DownloadJob) {
  if (job.state === "paused") { finishCancel(job); return true; }
  if (job.state !== "running") return false;
  job.stop = "cancel";
  if (job.child) killTree(job.child);
  return true;
}

export function getDownloadJob(id: string) {
  const job = jobs.get(id);
  if (job) job.touched = Date.now();
  return job;
}

export function jobView(job: DownloadJob) {
  return {
    state: job.state, stage: job.stage, progress: job.progress, speed: job.speed, eta: job.eta,
    downloaded: job.downloaded, total: job.total, item: job.item, items: job.items,
    filename: job.filename, size: job.size, error: job.error,
  };
}

export function streamDownloadJob(job: DownloadJob, range?: string | null) {
  if (!job.filename || !job.size) return null;
  const size = job.size;
  let start = 0, end = size - 1, status = 200;
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else start = Math.max(size - Number(m[2]), 0);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    status = 206;
  }
  const filePath = path.join(job.folder, job.filename);
  if (!existsSync(filePath)) return null;
  const stream = createReadStream(filePath, { start, end });
  stream.on("error", () => stream.destroy());
  const ascii = job.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": job.contentType || "application/octet-stream",
    // RFC 5987: keeps Arabic / non-Latin titles working (plain filename="..." would throw).
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
