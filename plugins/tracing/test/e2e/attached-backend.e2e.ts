import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation } from "@langfuse/tracing";
import { TraceFlags } from "@opentelemetry/api";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect, it } from "vitest";
import { z } from "zod";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundle = path.join(repoRoot, "plugins/tracing/dist/index.mjs");
const fixture = path.join(
  repoRoot,
  "plugins/tracing/test/fixtures/sessions/2026/06/03/rollout-basic-main.jsonl",
);

const ObservationSchema = z
  .object({
    id: z.string(),
    traceId: z.string().nullable(),
    parentObservationId: z.string().nullable(),
    name: z.string().nullable().optional(),
    type: z.string(),
    model: z.string().nullable().optional(),
    usageDetails: z.record(z.string(), z.number()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

const ObservationsResponseSchema = z.object({ data: z.array(ObservationSchema) });

type Observation = z.infer<typeof ObservationSchema>;

function getCredentials(): { publicKey: string; secretKey: string; baseUrl: string } {
  const publicKey = process.env.LANGFUSE_CODEX_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_CODEX_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.LANGFUSE_CODEX_BASE_URL ??
    process.env.LANGFUSE_BASE_URL ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    throw new Error(
      "test:e2e requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (or their LANGFUSE_CODEX_* variants)",
    );
  }
  // Validate before either process attempts to export.
  new URL(baseUrl);
  return { publicKey, secretKey, baseUrl };
}

/** Copy the fixture with current timestamps so backend retention filters include it. */
function stageFixture(tempDir: string): string {
  const lines = fs
    .readFileSync(fixture, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { timestamp: string; [key: string]: unknown });
  const firstTimestamp = Date.parse(lines[0].timestamp);
  const stagedStart = Date.now() - 10_000;

  for (const line of lines) {
    line.timestamp = new Date(
      stagedStart + Date.parse(line.timestamp) - firstTimestamp,
    ).toISOString();
  }

  const transcript = path.join(tempDir, "rollout-e2e.jsonl");
  fs.writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return transcript;
}

function runBundledHook(transcript: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("bundled Stop hook timed out"));
    }, 45_000);

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`bundled Stop hook exited with code ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: transcript,
      }),
    );
  });
}

function authHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

async function getObservations(
  traceId: string,
  credentials: ReturnType<typeof getCredentials>,
): Promise<Observation[]> {
  const url = new URL("/api/public/observations", credentials.baseUrl);
  url.searchParams.set("traceId", traceId);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: { Authorization: authHeader(credentials.publicKey, credentials.secretKey) },
  });
  if (!response.ok) {
    throw new Error(`Langfuse observations API returned HTTP ${response.status}`);
  }
  return ObservationsResponseSchema.parse(await response.json()).data;
}

async function waitForObservationTree(
  traceId: string,
  credentials: ReturnType<typeof getCredentials>,
): Promise<Observation[]> {
  const deadline = Date.now() + 60_000;
  let observations: Observation[] = [];

  while (Date.now() < deadline) {
    observations = await getObservations(traceId, credentials);
    const names = observations.map((observation) => observation.name);
    if (
      names.includes("Master Agent Run") &&
      names.includes("Codex Turn") &&
      names.includes("LLM") &&
      names.includes("exec_command")
    ) {
      return observations;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `timed out waiting for attached observation tree; received: ${observations
      .map((observation) => observation.name)
      .join(", ")}`,
  );
}

async function deleteTrace(
  traceId: string,
  credentials: ReturnType<typeof getCredentials>,
): Promise<void> {
  const url = new URL(`/api/public/traces/${encodeURIComponent(traceId)}`, credentials.baseUrl);
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: authHeader(credentials.publicKey, credentials.secretKey) },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Langfuse trace cleanup returned HTTP ${response.status}`);
  }
}

it("joins a real Master span and bundled Codex observations in Langfuse", async () => {
  const credentials = getCredentials();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-attached-e2e-"));
  const transcript = stageFixture(tempDir);
  const processor = new LangfuseSpanProcessor({
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
    baseUrl: credentials.baseUrl,
    environment: "codex-plugin-e2e",
    exportMode: "batched",
    shouldExportSpan: () => true,
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
    sampler: new AlwaysOnSampler(),
  });
  provider.register();

  const master = startObservation(
    "Master Agent Run",
    { metadata: { "e2e.source": "codex-observability-plugin" } },
    { asType: "agent", startTime: new Date(Date.now() - 15_000) },
  );
  const masterContext = master.otelSpan.spanContext();
  expect(masterContext.traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);

  let masterEnded = false;
  let providerShutdown = false;
  try {
    await runBundledHook(transcript, {
      ...process.env,
      CODEX_HOME: tempDir,
      TRACE_TO_LANGFUSE: "true",
      LANGFUSE_CODEX_PUBLIC_KEY: credentials.publicKey,
      LANGFUSE_CODEX_SECRET_KEY: credentials.secretKey,
      LANGFUSE_CODEX_BASE_URL: credentials.baseUrl,
      LANGFUSE_CODEX_ENVIRONMENT: "codex-plugin-e2e",
      LANGFUSE_CODEX_TRACEPARENT: `00-${masterContext.traceId}-${masterContext.spanId}-01`,
      LANGFUSE_CODEX_FAIL_ON_ERROR: "true",
      OTEL_TRACES_SAMPLER: "always_off",
    });

    master.end();
    masterEnded = true;
    await processor.forceFlush();
    await provider.shutdown();
    providerShutdown = true;

    const observations = await waitForObservationTree(masterContext.traceId, credentials);
    const masterObservation = observations.find((observation) => observation.id === master.id)!;
    const codexTurn = observations.find((observation) => observation.name === "Codex Turn")!;
    const generations = observations.filter((observation) => observation.name === "LLM");
    const tool = observations.find((observation) => observation.name === "exec_command")!;

    expect(masterObservation.type).toBe("AGENT");
    expect(masterObservation.parentObservationId).toBeNull();
    expect(codexTurn.type).toBe("AGENT");
    expect(codexTurn.parentObservationId).toBe(master.id);
    expect(generations).toHaveLength(2);
    expect(generations.every((generation) => generation.type === "GENERATION")).toBe(true);
    expect(generations.every((generation) => generation.parentObservationId === codexTurn.id)).toBe(
      true,
    );
    expect(generations.every((generation) => generation.model === "gpt-5.4")).toBe(true);
    expect(
      generations.every((generation) => Object.keys(generation.usageDetails ?? {}).length > 0),
    ).toBe(true);
    expect(tool.type).toBe("TOOL");
    expect(generations.map((generation) => generation.id)).toContain(tool.parentObservationId);
    expect(observations.every((observation) => observation.traceId === masterContext.traceId)).toBe(
      true,
    );
  } finally {
    try {
      if (!masterEnded) master.end();
      if (!providerShutdown) {
        await processor.forceFlush();
        await provider.shutdown();
      }
    } finally {
      try {
        await deleteTrace(masterContext.traceId, credentials);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
});
