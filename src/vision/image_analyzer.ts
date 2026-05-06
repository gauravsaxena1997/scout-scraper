import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import https from "https";
import http from "http";
import { TEMP_DIR } from "./downloader";

function getVenvPython(): string {
  if (process.env.SCOUT_VENV_PYTHON) return process.env.SCOUT_VENV_PYTHON;
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

function getAnalyzeImageScriptPath(): string {
  if (process.env.SCOUT_PYTHON_DIR) {
    return path.join(process.env.SCOUT_PYTHON_DIR, "analyze_image.py");
  }
  const candidates = [
    path.join(process.cwd(), "packages", "scout", "src", "python", "analyze_image.py"),
    path.resolve(__dirname, "..", "python", "analyze_image.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `analyze_image.py not found. Tried: ${candidates.join(", ")}. Set SCOUT_PYTHON_DIR to override.`
  );
}

function downloadImageToTemp(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching image`));
        return;
      }
      // Follow redirect
      if (res.statusCode && (res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        downloadImageToTemp(res.headers.location, outPath).then(resolve).catch(reject);
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

export interface ImageAnalysis {
  url: string;
  analysis: string;
  extracted_text: string;
  description: string;
  model: string;
  analyzedAt: string;
}

export interface ImageAnalysisError {
  url: string;
  error: string;
}

export interface AnalyzeImagesResult {
  results: ImageAnalysis[];
  errors: ImageAnalysisError[];
}

export async function analyzeImage(url: string): Promise<ImageAnalysis> {
  const runId = crypto.randomUUID().slice(0, 8);
  const outDir = path.join(TEMP_DIR, `img-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const ext = url.split("?")[0].match(/\.(jpe?g|png|webp|gif|bmp)$/i)?.[1] ?? "jpg";
  const imagePath = path.join(outDir, `image.${ext}`);

  try {
    await downloadImageToTemp(url, imagePath);

    const python = getVenvPython();
    const scriptPath = getAnalyzeImageScriptPath();
    const model = process.env.SCOUT_VISION_MODEL ?? "gemma4:latest";

    const result = spawnSync(python, [scriptPath, imagePath, model], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status !== 0 || result.error) {
      throw new Error(result.stderr?.trim() || result.error?.message || "image analysis failed");
    }

    const parsed = JSON.parse(result.stdout);
    if (parsed.error) throw new Error(parsed.error);

    return {
      url,
      analysis: parsed.analysis ?? "",
      extracted_text: parsed.extracted_text ?? "",
      description: parsed.description ?? "",
      model: parsed.model ?? model,
      analyzedAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

export async function analyzeImages(urls: string[]): Promise<AnalyzeImagesResult> {
  const results: ImageAnalysis[] = [];
  const errors: ImageAnalysisError[] = [];
  for (const url of urls) {
    try {
      results.push(await analyzeImage(url));
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[scout/vision] Image failed: ${url} -`, message);
      errors.push({ url, error: message });
    }
  }
  return { results, errors };
}
