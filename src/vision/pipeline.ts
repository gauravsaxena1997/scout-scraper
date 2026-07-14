import { downloadVideo, downloadSubtitleResult } from "./downloader";
import { transcribeVideo } from "./transcriber";
import { parseVtt } from "./subtitle-parser";

export interface VideoAnalysis {
  url: string;
  title: string;
  duration: number;
  language: string;
  transcript: string;
  transcriptSource: "yt-dlp" | "faster-whisper";
  segments: Array<{ start: number; end: number; text: string }>;
  analyzedAt: string;
}

export async function analyzeVideo(url: string, options?: { forceWhisper?: boolean }): Promise<VideoAnalysis> {
  // Fast path: auto-generated subtitles (no audio download, no Whisper, ~20s)
  const subtitles = options?.forceWhisper ? null : await downloadSubtitleResult(url).catch(() => null);
  if (subtitles) {
    try {
      const parsed = parseVtt(subtitles.vttPath);
      return {
        url,
        title: subtitles.title,
        duration: subtitles.duration,
        language: parsed.language,
        transcript: parsed.text,
        transcriptSource: "yt-dlp",
        segments: parsed.segments,
        analyzedAt: new Date().toISOString(),
      };
    } finally {
      subtitles.cleanup();
    }
  }

  // Slow path: download audio + Whisper transcription (~60-120s)
  const download = await downloadVideo(url);
  try {
    const transcript = await transcribeVideo(download.videoPath);
    return {
      url,
      title: download.title,
      duration: download.duration,
      language: transcript.language,
      transcript: transcript.text,
      transcriptSource: "faster-whisper",
      segments: transcript.segments,
      analyzedAt: new Date().toISOString(),
    };
  } finally {
    download.cleanup();
  }
}

export interface VideoAnalysisError {
  url: string;
  error: string;
}

export interface AnalyzeVideosResult {
  results: VideoAnalysis[];
  errors: VideoAnalysisError[];
}

export async function analyzeVideos(urls: string[]): Promise<AnalyzeVideosResult> {
  const results: VideoAnalysis[] = [];
  const errors: VideoAnalysisError[] = [];
  for (const url of urls) {
    try {
      results.push(await analyzeVideo(url));
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[scout/vision] Failed: ${url} -`, message);
      errors.push({ url, error: message });
    }
  }
  return { results, errors };
}
