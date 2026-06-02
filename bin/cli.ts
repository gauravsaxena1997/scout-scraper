import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerScoutTools } from "../src/index.js";
import { startScoutServer } from "../src/server/http.js";

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadRuntimeEnv(): void {
  if (process.env.SCOUT_ENV_FILE) {
    loadEnvFile(path.resolve(process.env.SCOUT_ENV_FILE));
    return;
  }

  const runtimeDir = process.cwd();
  loadEnvFile(path.join(runtimeDir, ".env"));
  loadEnvFile(path.join(runtimeDir, ".env.local"));
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runStdio(): Promise<void> {
  const server = new McpServer({
    name: "scout-scraper",
    version: "1.0.0",
  });

  registerScoutTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const mode = process.argv[2];

async function main(): Promise<void> {
  loadRuntimeEnv();

  if (mode === "serve" || mode === "server") {
    const portRaw = argValue("--port");
    const host = argValue("--host");
    startScoutServer({
      host,
      port: portRaw ? Number(portRaw) : undefined,
    });
    return;
  }

  await runStdio();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[scout] ${message}`);
  process.exit(1);
});
