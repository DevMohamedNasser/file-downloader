import { exec, mediaError, mediaToolEnv, ytDlp } from "@/app/_lib/media-tools";
import { assertPublicUrl } from "@/app/_lib/url-guard";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return Response.json({ error: "Paste a media link first." }, { status: 400 });
  let url: URL;
  try { url = await assertPublicUrl(raw); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "That link is not valid." }, { status: 400 }); }
  try {
    const { stdout } = await exec(ytDlp, ["--dump-single-json", "--flat-playlist", "--no-warnings", "--", url.toString()], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024, env: await mediaToolEnv() });
    const item = JSON.parse(stdout);
    const entries = Array.isArray(item.entries) ? item.entries : null;
    const totalSeconds = entries ? entries.reduce((sum: number, entry: { duration?: number } | null) => sum + (Number(entry?.duration) || 0), 0) : Number(item.duration) || 0;
    return Response.json({ title: item.title || "Media", isPlaylist: Boolean(entries), count: entries?.length || 1, duration: totalSeconds });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("ENOENT")) return Response.json({ error: "Media support needs yt-dlp installed on the server. Audio conversion also needs FFmpeg." }, { status: 503 });
    return Response.json({ error: mediaError(error, "Could not read this media link. It may be private or unsupported.") }, { status: 422 });
  }
}
