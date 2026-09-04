import { TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  EXTERNAL_TRACEPARENT_ENV_VAR,
  readExternalParentSpanContext,
} from "../src/parent-context.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

describe("readExternalParentSpanContext", () => {
  it("parses a sampled W3C traceparent as a remote span context", () => {
    expect(
      readExternalParentSpanContext(
        { [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-01` },
        false,
      ),
    ).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  });

  it("preserves the upstream not-sampled decision", () => {
    expect(
      readExternalParentSpanContext(
        { [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-00` },
        false,
      )?.traceFlags,
    ).toBe(TraceFlags.NONE);
  });

  it("does not read the unscoped TRACEPARENT variable", () => {
    expect(
      readExternalParentSpanContext({ TRACEPARENT: `00-${TRACE_ID}-${SPAN_ID}-01` }, false),
    ).toBeUndefined();
  });

  it("ignores an invalid value unless fail-on-error is enabled", () => {
    const env = { [EXTERNAL_TRACEPARENT_ENV_VAR]: "not-a-traceparent" };

    expect(readExternalParentSpanContext(env, false)).toBeUndefined();
    expect(() => readExternalParentSpanContext(env, true)).toThrow(
      `${EXTERNAL_TRACEPARENT_ENV_VAR} must be a valid W3C traceparent value`,
    );
  });
});
