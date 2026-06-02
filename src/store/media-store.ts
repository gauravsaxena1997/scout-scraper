import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";

// Single canonical media root for downloaded transcripts and media.
// Override via SCOUT_MEDIA_DIR.
// Layout under this root:
//   transcripts/<source>/<channel>/<itemId>.txt
//   images/<source>/<channel>/<itemId>/slide-<n>.<ext>
//   videos/<source>/<channel>/<itemId>.<ext>
//   raw/<source>/<channel>/<itemId>.json
//   vision/<source>/<channel>/<itemId>/slide-<n>.txt
export function getMediaRoot(): string {
  if (process.env.SCOUT_MEDIA_DIR) return process.env.SCOUT_MEDIA_DIR;
  if (process.env.PATHRIX_MEDIA_DIR) return process.env.PATHRIX_MEDIA_DIR;
  return path.join(os.homedir(), ".local", "share", "scout-scraper", "media");
}

type Source = "youtube" | "instagram" | "x" | "reddit" | string;

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function transcriptPath(source: Source, channel: string, itemId: string): string {
  return path.join(getMediaRoot(), "transcripts", safeSegment(source), safeSegment(channel), `${safeSegment(itemId)}.txt`);
}

export function videoPath(source: Source, channel: string, itemId: string, ext = "mp4"): string {
  return path.join(getMediaRoot(), "videos", safeSegment(source), safeSegment(channel), `${safeSegment(itemId)}.${ext}`);
}

export function imageDir(source: Source, channel: string, itemId: string): string {
  return path.join(getMediaRoot(), "images", safeSegment(source), safeSegment(channel), safeSegment(itemId));
}

export function rawScrapePath(source: Source, channel: string, itemId: string): string {
  return path.join(getMediaRoot(), "raw", safeSegment(source), safeSegment(channel), `${safeSegment(itemId)}.json`);
}

export function visionDir(source: Source, channel: string, itemId: string): string {
  return path.join(getMediaRoot(), "vision", safeSegment(source), safeSegment(channel), safeSegment(itemId));
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function fileExistsAndNonEmpty(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export async function readTranscript(source: Source, channel: string, itemId: string): Promise<string | null> {
  const p = transcriptPath(source, channel, itemId);
  try {
    return await fs.promises.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

export async function saveTranscript(source: Source, channel: string, itemId: string, content: string): Promise<string> {
  const p = transcriptPath(source, channel, itemId);
  await ensureDir(path.dirname(p));
  await fs.promises.writeFile(p, content, "utf-8");
  return p;
}

export async function saveRawScrape(source: Source, channel: string, itemId: string, payload: unknown): Promise<string> {
  const p = rawScrapePath(source, channel, itemId);
  await ensureDir(path.dirname(p));
  await fs.promises.writeFile(p, JSON.stringify(payload, null, 2), "utf-8");
  return p;
}

export async function saveVisionText(source: Source, channel: string, itemId: string, slideIndex: number, text: string): Promise<string> {
  const dir = visionDir(source, channel, itemId);
  await ensureDir(dir);
  const p = path.join(dir, `slide-${slideIndex}.txt`);
  await fs.promises.writeFile(p, text, "utf-8");
  return p;
}

// HTTP(S) download with redirect following. Short-circuits if file already exists.
function fetchToFile(url: string, dest: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error("too many redirects")); return; }
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchToFile(next, dest, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (e) => reject(e));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(new Error("download timed out")); });
  });
}

function pickExtFromUrl(url: string, fallback = "jpg"): string {
  const m = url.split("?")[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return (m?.[1] ?? fallback).toLowerCase();
}

// Download an image (or list) into images/<source>/<channel>/<itemId>/slide-<n>.<ext>.
// Idempotent: skips files that already exist non-empty.
// Returns absolute paths in input order; failed slides are recorded as null.
export async function downloadImageSlides(
  source: Source,
  channel: string,
  itemId: string,
  urls: string[]
): Promise<Array<string | null>> {
  if (urls.length === 0) return [];
  const dir = imageDir(source, channel, itemId);
  await ensureDir(dir);
  const out: Array<string | null> = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) { out.push(null); continue; }
    const ext = pickExtFromUrl(url, "jpg");
    const dest = path.join(dir, `slide-${i + 1}.${ext}`);
    if (await fileExistsAndNonEmpty(dest)) { out.push(dest); continue; }
    try {
      await fetchToFile(url, dest);
      out.push(dest);
    } catch {
      out.push(null);
    }
  }
  return out;
}

// Download a single video file (Instagram videoUrl, etc.) into videos/<source>/<channel>/<itemId>.<ext>.
// Idempotent. Returns absolute path or null on failure.
export async function downloadVideoFile(
  source: Source,
  channel: string,
  itemId: string,
  url: string
): Promise<string | null> {
  if (!url) return null;
  const ext = pickExtFromUrl(url, "mp4");
  const dest = videoPath(source, channel, itemId, ext);
  if (await fileExistsAndNonEmpty(dest)) return dest;
  await ensureDir(path.dirname(dest));
  try {
    await fetchToFile(url, dest);
    return dest;
  } catch {
    return null;
  }
}

// Walks every subtree under media root and deletes files older than `daysToKeep`.
// Returns aggregate counts. Empty intermediate dirs are NOT removed (cheap, safe).
export async function cleanupOldMedia(daysToKeep: number): Promise<{ deletedFiles: number; freedBytes: number }> {
  const root = getMediaRoot();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let deletedFiles = 0;
  let freedBytes = 0;

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs < cutoff) {
            freedBytes += st.size;
            await fs.promises.rm(full, { force: true });
            deletedFiles += 1;
          }
        } catch { /* ignore */ }
      }
    }
  }

  try {
    await fs.promises.access(root);
    await walk(root);
  } catch {
    // root doesn't exist yet
  }

  return { deletedFiles, freedBytes };
}
