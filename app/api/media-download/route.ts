import { cancelJob, getDownloadJob, jobView, pauseJob, resumeJob, startMediaDownload, streamDownloadJob } from "@/app/_lib/download-jobs";
import { assertPublicUrl } from "@/app/_lib/url-guard";


const EXPIRED = "This download expired or the server restarted. Please start it again.";

export async function POST(request: Request) {
  let body: { url?: string; mode?: string; quality?: string; action?: string; id?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid download request." }, { status: 400 }); }

  // Control actions: pause / resume / cancel
  if (body.action) {
    const job = getDownloadJob(body.id || "");
    if (!job) return Response.json({ error: EXPIRED }, { status: 404 });
    const handlers = { pause: pauseJob, resume: resumeJob, cancel: cancelJob } as const;
    const handler = handlers[body.action as keyof typeof handlers];
    if (!handler) return Response.json({ error: "Unknown action." }, { status: 400 });
    if (!handler(job)) return Response.json({ error: "That action isn't available right now." }, { status: 409 });
    return Response.json({ ok: true, state: job.state });
  }

  let url: URL;
  try { url = await assertPublicUrl(body.url || ""); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "That link is not valid." }, { status: 400 }); }

  const job = await startMediaDownload(url, body.mode === "audio" ? "audio" : "video", body.quality || "best");
  return Response.json({ id: job.id, state: job.state });
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const id = query.get("id");
  if (!id) return Response.json({ error: "Download job not found." }, { status: 404 });
  const job = getDownloadJob(id);
  if (!job) return Response.json({ error: EXPIRED }, { status: 404 });

  if (query.has("file")) {
    if (job.state !== "complete") return Response.json({ error: "The file is not ready yet." }, { status: 409 });
    console.log("[droply] serving file", job.filename, job.size, "range:", request.headers.get("range"));
    return streamDownloadJob(job, request.headers.get("range")) || Response.json({ error: "The file is not ready." }, { status: 409 });
  }
  return Response.json(jobView(job), { headers: { "Cache-Control": "no-store" } });
}
