import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import https from "https";
import http from "http";

export const TEMP_DIR =
  process.env.SCOUT_TEMP_DIR ??
  path.join(os.homedir(), ".local", "share", "scout-scraper", "tmp");

function resolveYtDlp(): string {
  if (process.env.SCOUT_YT_DLP) return process.env.SCOUT_YT_DLP;
  const candidates = [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

// Returns cookie args for yt-dlp. Prefers an explicit cookie file env var,
// falls back to reading from the browser's cookie store.
function cookieArgs(): string[] {
  if (process.env.SCOUT_YT_COOKIES_FILE) {
    return ["--cookies", process.env.SCOUT_YT_COOKIES_FILE];
  }
  const browser = process.env.SCOUT_YT_COOKIES_BROWSER ?? "chrome";
  return ["--cookies-from-browser", browser];
}

function spawnAsync(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code ?? 1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface DownloadResult {
  videoPath: string;
  title: string;
  duration: number;
  cleanup: () => void;
}

export interface SubtitleDownloadResult {
  vttPath: string;
  title: string;
  duration: number;
  language: string;
  cleanup: () => void;
}

// Fast path: fetch auto-generated subtitles only (no audio, no Whisper).
// Returns null if the video has no auto-captions or if yt-dlp fails.
export async function downloadSubtitleResult(url: string): Promise<SubtitleDownloadResult | null> {
  if (isDirectMediaUrl(url)) return null;

  const runId = crypto.randomUUID().slice(0, 8);
  const outDir = path.join(TEMP_DIR, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const cleanup = () => fs.rmSync(outDir, { recursive: true, force: true });
  const ytDlp = resolveYtDlp();

  // Single call: download VTT only. --print suppresses file writing in yt-dlp, so omit it.
  // Title and duration are extracted from --print-json output in the stdout.
  const dlResult = await spawnAsync(
    ytDlp,
    [
      "--write-auto-sub", "--sub-lang", "en",
      "--skip-download",
      "--no-playlist",
      "--retries", "1",
      ...cookieArgs(),
      "--print", "%(title)s\t%(duration)s",
      "--no-simulate",
      "-o", path.join(outDir, "%(id)s"),
      url,
    ],
    45_000
  );

  if (dlResult.status !== 0) {
    cleanup();
    return null;
  }

  // Find the downloaded VTT file
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".vtt"));
  if (files.length === 0) {
    cleanup();
    return null;
  }

  let title = "Unknown";
  let duration = 0;
  const language = "en";
  try {
    const [t, d] = dlResult.stdout.trim().split("\t");
    title = t || "Unknown";
    duration = parseFloat(d) || 0;
  } catch {
    // non-fatal
  }

  return {
    vttPath: path.join(outDir, files[0]),
    title,
    duration,
    language,
    cleanup,
  };
}

// CDN/direct media URLs don't need yt-dlp - just a plain HTTP download
function isDirectMediaUrl(url: string): boolean {
  const stripped = url.split("?")[0].toLowerCase();
  return (
    stripped.endsWith(".mp4") ||
    stripped.endsWith(".m4a") ||
    stripped.endsWith(".mp3") ||
    stripped.endsWith(".webm") ||
    stripped.endsWith(".ogg") ||
    url.includes("cdninstagram.com") ||
    url.includes("fbcdn.net") ||
    url.includes("video.twimg.com") ||
    url.includes("scontent.")
  );
}

function downloadDirect(url: string, outDir: string): Promise<DownloadResult> {
  const ext = url.split("?")[0].match(/\.(mp4|m4a|mp3|webm|ogg)$/i)?.[1] ?? "mp4";
  const filePath = path.join(outDir, `media.${ext}`);
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} downloading media`));
        return;
      }
      if (res.statusCode && (res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        downloadDirect(res.headers.location, outDir).then(resolve).catch(reject);
        return;
      }
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on("finish", () =>
        file.close(() =>
          resolve({
            videoPath: filePath,
            title: "Unknown",
            duration: 0,
            cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }),
          })
        )
      );
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

export async function downloadVideo(url: string): Promise<DownloadResult> {
  const runId = crypto.randomUUID().slice(0, 8);
  const outDir = path.join(TEMP_DIR, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (isDirectMediaUrl(url)) {
    return downloadDirect(url, outDir);
  }

  const ytDlp = resolveYtDlp();

  // Fetch metadata first (fast, no download). 30s is plenty for a JSON response.
  const meta = await spawnAsync(
    ytDlp,
    ["--dump-json", "--no-playlist", "--no-download", ...cookieArgs(), "--retries", "1", url],
    30_000
  );

  if (meta.status !== 0) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`yt-dlp metadata error: ${meta.stderr?.trim() ?? "unknown"}`);
  }

  let title = "Unknown";
  let duration = 0;
  try {
    const parsed = JSON.parse(meta.stdout);
    title = parsed.title ?? "Unknown";
    duration = parsed.duration ?? 0;
  } catch {
    // non-fatal
  }

  // Audio-only is enough for transcription and downloads much faster.
  // --sleep-interval 2: 2s pause before the request (reduces rate-limit risk).
  // --retries 1: fail fast instead of silently retrying 10 times.
  const dl = await spawnAsync(
    ytDlp,
    [
      "-f", "bestaudio/best",
      "-o", path.join(outDir, "%(id)s.%(ext)s"),
      "--no-playlist",
      "--no-progress",
      "--sleep-interval", "2",
      "--retries", "1",
      ...cookieArgs(),
      url,
    ],
    120_000 // 2 min hard limit for audio download
  );

  if (dl.status !== 0) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`yt-dlp download error: ${dl.stderr?.trim() ?? "unknown"}`);
  }

  const files = fs.readdirSync(outDir);
  if (files.length === 0) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error("yt-dlp produced no output file");
  }

  return {
    videoPath: path.join(outDir, files[0]),
    title,
    duration,
    cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }),
  };
}
