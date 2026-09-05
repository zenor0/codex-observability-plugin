import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { context, trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

const config: Config = {
  enabled: true,
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: true,
  user_id: "codex-user",
  tags: ["codex-tag"],
  metadata: { owner: "codex" },
};

const externalParent: SpanContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");
const tempDirs: string[] = [];
const exporter = new InMemorySpanExporter();
let processor: LangfuseSpanProcessor;
let provider: NodeTracerProvider;

function stageFixture(file: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-ownership-"));
  tempDirs.push(dir);
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03", file);
}

beforeAll(() => {
  processor = new LangfuseSpanProcessor({ exporter, shouldExportSpan: () => true });
  provider = new NodeTracerProvider({
    spanProcessors: [processor],
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
  });
  provider.register();
});

beforeEach(() => exporter.reset());

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
});

describe("Langfuse trace ownership", () => {
  it.each(["rollout-basic-main.jsonl", "rollout-two-turns-main.jsonl", "rollout-parent.jsonl"])(
    "keeps attached observations out of app roots for %s",
    async (file) => {
      const previousContext = context.active();
      await convertRollout(stageFixture(file), { config, parentSpanContext: externalParent });
      await processor.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(1);
      for (const span of spans) {
        expect(span.spanContext().traceId).toBe(externalParent.traceId);
        expect(span.attributes["langfuse.internal.is_app_root"]).not.toBe(true);
        expect(span.attributes["user.id"]).toBeUndefined();
        expect(span.attributes["session.id"]).toBeUndefined();
        expect(
          Object.keys(span.attributes).filter((key) => key.startsWith("langfuse.trace.")),
        ).toEqual([]);
        if (span.name === "Codex Turn") {
          expect(span.parentSpanContext?.spanId).toBe(externalParent.spanId);
          expect(span.attributes["langfuse.observation.metadata.codex.turn_id"]).toBeDefined();
        }
      }
      expect(context.active()).toBe(previousContext);
    },
  );

  it.each([undefined, "ownership-seed"])(
    "preserves standalone app roots with trace_seed=%s",
    async (trace_seed) => {
      await convertRollout(stageFixture("rollout-basic-main.jsonl"), {
        config: { ...config, trace_seed },
      });
      await processor.forceFlush();

      const appRoots = exporter
        .getFinishedSpans()
        .filter((span) => span.attributes["langfuse.internal.is_app_root"] === true);
      expect(appRoots.map((span) => span.name)).toEqual(["Codex Turn"]);
      expect(appRoots[0].attributes["langfuse.trace.name"]).toBe("Codex Turn");
      expect(appRoots[0].attributes["langfuse.trace.metadata.owner"]).toBe("codex");
    },
  );
});
