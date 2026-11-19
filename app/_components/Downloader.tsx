"use client";

import { useEffect, useRef, useState } from "react";

type Download = { name: string; url: string; date: string; size?: string; file?: string };
type MediaInfo = { title: string; isPlaylist: boolean; count: number; duration: number };
type JobView = {
  id: string;
  state: "running" | "paused" | "complete" | "error" | "canceled";
  stage: "downloading" | "processing";
  progress: number; speed: number; eta: number | null;
  downloaded: number; total: number; item: number; items: number;
  filename?: string; size?: number; error?: string;
};
const themes = ["Light", "Dark", "System"] as const;

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z"/><path d="m19 14 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></>,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>,
    play: <path d="M7 4v16l13-8z"/>,
    x: <><path d="M6 6l12 12"/><path d="M18 6 6 18"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function Downloader() {
  const [theme, setTheme] = useState<(typeof themes)[number]>("Light");
  const [url, setUrl] = useState("");
  const [quality, setQuality] = useState("best");
  const [mode, setMode] = useState<"video" | "audio">("video");
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const saved = useRef(new Set<string>());
  const sourceRef = useRef("");

  const active = job?.state === "running" || job?.state === "paused";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedTheme = localStorage.getItem("droply-theme") as (typeof themes)[number] | null;
      if (savedTheme && themes.includes(savedTheme)) setTheme(savedTheme);
      try { setDownloads(JSON.parse(localStorage.getItem("droply-downloads") || "[]") as Download[]); }
      catch { localStorage.removeItem("droply-downloads"); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Media preview (title / duration / playlist count)
  useEffect(() => {
    let parsed: URL | null = null;
    try { const candidate = new URL(url); if (/^https?:$/.test(candidate.protocol)) parsed = candidate; } catch { /* Empty or incomplete URL. */ }
    const timer = window.setTimeout(async () => {
      setMediaInfo(null);
      if (!parsed) return;
      try {
        const response = await fetch(`/api/media-info?url=${encodeURIComponent(parsed.toString())}`);
        if (response.ok) setMediaInfo(await response.json());
      } catch { /* Preview is optional. */ }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [url]);

  useEffect(() => {
    const dark = theme === "Dark" || (theme === "System" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("droply-theme", theme);
  }, [theme]);

  function applyJob(id: string, data: Omit<JobView, "id">) {
    setJob({ id, ...data });
    if (data.state === "complete" && !saved.current.has(id)) {
      saved.current.add(id);
      const name = data.filename || "download";
      const file = `/api/media-download?id=${encodeURIComponent(id)}&file=1`;
      const entry = { name, url: sourceRef.current, date: new Date().toISOString(), size: typeof data.size === "number" ? formatSize(data.size) : "—", file };
      rememberDownload(entry);
      // This URL returns an attachment, so browser navigation triggers the native device download.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(file);
      setStatus("Download started. Check your browser's Downloads list. If nothing appeared, press Save file.");
    } else if (data.state === "error") setStatus(data.error || "The source could not be downloaded.");
    else if (data.state === "canceled") setStatus("Download canceled.");
    else if (data.state === "paused") setStatus("Paused. Press Resume to continue from where it stopped.");
    else if (data.state === "running") setStatus("");
  }

  function rememberDownload(entry: Download) {
    let previous: Download[] = [];
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("droply-downloads") || "[]");
      if (Array.isArray(parsed)) previous = parsed as Download[];
    } catch { localStorage.removeItem("droply-downloads"); }
    const next = [entry, ...previous].slice(0, 12);
    localStorage.setItem("droply-downloads", JSON.stringify(next));
    setDownloads(next);
  }

  // Live progress polling while a job is running or paused
  const jobId = job?.id;
  const jobState = job?.state;
  useEffect(() => {
    if (!jobId || (jobState !== "running" && jobState !== "paused")) return;
    let cancelled = false, inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/media-download?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) { setJob(null); setStatus(data.error || "The download status is unavailable."); return; }
        applyJob(jobId, data);
      } catch { /* transient network error: try again on next tick */ }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(tick, 500);
    void tick();
    return () => { cancelled = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobState]);

  async function startDownload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let parsed: URL;
    try { parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); }
    catch { setStatus("Enter a valid http or https link."); return; }
    setBusy(true); setStatus("Preparing your download…");
    try {
      const response = await fetch("/api/media-download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: parsed.toString(), mode, quality }) });
      const started = await response.json();
      if (!response.ok) throw new Error(started.error || "Could not start the download.");
      sourceRef.current = parsed.toString();
      setJob({ id: started.id, state: "running", stage: "downloading", progress: 0, speed: 0, eta: null, downloaded: 0, total: 0, item: 1, items: mediaInfo?.count ?? 1 });
      setStatus("");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Download failed. Check the link and try again."); }
    finally { setBusy(false); }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!job) return;
    setControlBusy(true);
    try {
      const response = await fetch("/api/media-download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: job.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Action failed.");
      if (action === "resume") setJob({ ...job, state: "running" });
      else setStatus(action === "pause" ? "Pausing…" : "Canceling…");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Action failed."); }
    finally { setControlBusy(false); }
  }

  const stageText = job?.state === "paused" ? "Paused" : job?.stage === "processing" ? "Merging video & audio…" : "Downloading";

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark"><Icon name="arrow" size={18}/></span><span>droply<span className="brand-dot">.</span></span></a><div className="topbar-right"><span className="secure-label"><span className="secure-dot"/> Private &amp; secure</span><label className="theme-control" aria-label="Color theme"><Icon name={theme === "Light" ? "sun" : theme === "Dark" ? "moon" : "monitor"} size={17}/><select value={theme} onChange={(e) => setTheme(e.target.value as (typeof themes)[number])}>{themes.map((item) => <option key={item}>{item}</option>)}</select><span className="chevron">⌄</span></label></div></header>
    <section className="hero"><div className="eyebrow"><span className="eyebrow-icon"><Icon name="spark" size={14}/></span> SIMPLE FILE DOWNLOADER</div><h1>Everything you need.<br/><span>One simple download.</span></h1><p className="hero-copy">Paste a link, pick your preferences, and save files in a few clicks.</p>
      <div className="download-card"><form onSubmit={startDownload}><label className="field-label" htmlFor="download-url">FILE LINK</label><div className="url-field"><Icon name="link" size={19}/><input id="download-url" type="url" placeholder="https://example.com/your-video-or-file" value={url} onChange={(e) => setUrl(e.target.value)} disabled={active} required/><button className="paste-button" type="button" disabled={active} onClick={async () => { try { setUrl(await navigator.clipboard.readText()); } catch { setStatus("Clipboard access is unavailable. Paste your link into the field."); } }}>Paste</button></div>
        {mediaInfo && <div className="media-preview"><span className="feature-icon"><Icon name="file" size={17}/></span><span><strong>{mediaInfo.title}</strong><small>{mediaInfo.isPlaylist ? `${mediaInfo.count} items${mediaInfo.duration ? ` · ${formatDuration(mediaInfo.duration)} total` : ""}` : mediaInfo.duration ? `Duration ${formatDuration(mediaInfo.duration)}` : "Ready to download"}</small></span></div>}
        <div className="form-bottom"><div className="options-row"><div className="mode-switch" aria-label="Download type"><button type="button" disabled={active} className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>Video</button><button type="button" disabled={active} className={mode === "audio" ? "active" : ""} onClick={() => setMode("audio")}>Audio · MP3</button></div>{mode === "video" && <label className="quality-wrap"><span className="field-label">VIDEO QUALITY</span><select value={quality} disabled={active} onChange={(e) => setQuality(e.target.value)}><option value="best">Best available</option><option value="2160p">4K (2160p)</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option></select><span className="chevron">⌄</span></label>}</div><button className="download-button" type="submit" disabled={busy || active}><Icon name="arrow" size={18}/>{busy ? "Starting…" : mediaInfo?.isPlaylist ? `Download playlist${mode === "audio" ? " audio" : ""}` : "Download"}</button></div>

        {job && active && <div className="job-panel" aria-live="polite">
          <div className="job-top"><strong>{stageText}</strong><span className="job-percent">{job.progress.toFixed(1)}%</span></div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}><div className={`progress-bar${job.state === "paused" ? " paused" : ""}`} style={{ width: `${job.progress}%` }}/></div>
          <div className="job-meta">
            <span>{formatSize(job.downloaded)}{job.total ? ` / ${formatSize(job.total)}` : ""}</span>
            <span>{job.state === "running" && job.speed ? `${formatSize(job.speed)}/s` : "—"}</span>
            <span>{job.state === "paused" ? "Paused" : job.stage === "processing" ? "Almost done…" : job.eta != null ? `${formatDuration(job.eta)} left` : "Calculating…"}</span>
          </div>
          {job.items > 1 && <small className="job-item">Item {job.item} of {job.items}</small>}
          <div className="job-actions">
            {job.state === "paused"
              ? <button type="button" className="job-btn primary" disabled={controlBusy} onClick={() => control("resume")}><Icon name="play" size={16}/> Resume</button>
              : <button type="button" className="job-btn" disabled={controlBusy || job.stage === "processing"} onClick={() => control("pause")}><Icon name="pause" size={16}/> Pause</button>}
            <button type="button" className="job-btn danger" disabled={controlBusy} onClick={() => control("cancel")}><Icon name="x" size={16}/> Cancel</button>
          </div>
        </div>}

        {job?.state === "complete" && <div className="job-panel">
          <div className="job-top"><strong>Ready ✓</strong><span>{typeof job.size === "number" ? formatSize(job.size) : ""}</span></div>
          <small className="job-item">{job.filename}</small>
          <div className="job-actions"><a className="job-btn primary" href={`/api/media-download?id=${encodeURIComponent(job.id)}&file=1`} download={job.filename}><Icon name="arrow" size={16}/> Save file</a></div>
        </div>}

        {status && <p className="status-message" role="status">{status}</p>}
      </form></div><p className="quality-note"><Icon name="spark" size={14}/> Works with YouTube, TikTok, Instagram, Facebook, X, Vimeo, SoundCloud and 1,800+ other sites, plus direct file links.</p>
      <div className="feature-row"><div className="feature"><span className="feature-icon"><Icon name="file" size={17}/></span><span><strong>Video &amp; audio</strong><small>Always merged with sound</small></span></div><i/><div className="feature"><span className="feature-icon"><Icon name="check" size={17}/></span><span><strong>Pause &amp; resume</strong><small>Live progress &amp; time left</small></span></div><i/><div className="feature"><span className="feature-icon"><Icon name="sun" size={17}/></span><span><strong>Your way</strong><small>Light, dark &amp; system</small></span></div></div>
    </section>
    <section className="history-section"><div className="history-heading"><div><div className="section-kicker">YOUR ACTIVITY</div><h2>Recent downloads</h2></div><span className="history-count">{downloads.length} {downloads.length === 1 ? "file" : "files"}</span></div>{downloads.length ? <div className="history-list">{downloads.map((item, index) => <a className="history-item" href={item.file || item.url} key={`${item.date}-${index}`} target="_blank" rel="noreferrer"><span className="file-icon"><Icon name="file" size={18}/></span><span className="file-details"><strong>{item.name}</strong><small>{new URL(item.url).hostname} · {new Date(item.date).toLocaleString()}</small></span><span className="file-size">{item.size || "—"}</span><span className="history-arrow">↗</span></a>)}</div> : <div className="empty-history"><span className="empty-icon"><Icon name="clock" size={21}/></span><div><strong>Your downloads will show up here</strong><p>Files you save with Droply are kept in this list on this device.</p></div></div>}</section>
    <footer className="bottom-nav"><div className="footer-brand"><span className="brand-mark"><Icon name="arrow" size={15}/></span> droply<span className="brand-dot">.</span></div><span>Made for the things you want to keep.</span><span className="footer-status"><span className="secure-dot"/> Ready when you are</span></footer>
  </main>;
}

function formatSize(bytes: number) { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function formatDuration(total: number) { const seconds = Math.floor(total || 0); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60; return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":"); }
