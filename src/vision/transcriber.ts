import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export interface TranscriptResult {
  language: string;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
}

function getVenvPython(): string {
  if (process.env.SCOUT_VENV_PYTHON) return process.env.SCOUT_VENV_PYTHON;

  // SCOUT_VENV_ROOT lets users point to their venv without static .venv literals here
  // (static .venv paths trigger Turbopack DirAssetReference which follows broken symlinks)
  const venvRoot = process.env.SCOUT_VENV_ROOT;
  if (venvRoot) {
    const candidates = [
      path.join(venvRoot, "bin", "python3"),
      path.join(venvRoot, "bin", "python"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return "python3";
}

function getTranscribeScriptPath(): string {
  if (process.env.SCOUT_PYTHON_DIR) {
    return path.join(process.env.SCOUT_PYTHON_DIR, "transcribe.py");
  }
  const candidates = [
    path.join(process.cwd(), "packages", "scout", "src", "python", "transcribe.py"),
    path.resolve(__dirname, "..", "python", "transcribe.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `transcribe.py not found. Tried: ${candidates.join(", ")}. Set SCOUT_PYTHON_DIR to override.`
  );
}

export function transcribeVideo(videoPath: string): Promise<TranscriptResult> {
  const python = getVenvPython();
  const scriptPath = getTranscribeScriptPath();
  const modelSize = process.env.SCOUT_WHISPER_MODEL ?? "tiny";

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath, videoPath, modelSize]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Transcription timed out after 10 minutes"));
    }, 600_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Transcription error: ${stderr.trim() || "unknown"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse transcription output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
