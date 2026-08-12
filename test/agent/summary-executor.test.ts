import { describe, expect, it, vi } from "vitest";
import { executeSummaryWithRetry } from "@byte-mentor/agent";
import type { SummaryModelPort, SummaryRequest, SummaryResponse } from "@byte-mentor/agent";

// 测试工具：构造最小请求。
function makeRequest(): SummaryRequest {
  return {
    historyText: "serialized history",
    model: { provider: "openai", modelId: "gpt-5" },
    thinkingLevel: "medium",
  };
}

function makePort(behavior: () => SummaryResponse): SummaryModelPort & { calls: number } {
  let calls = 0;
  const port = {
    async summarize(_request: SummaryRequest) {
      calls += 1;
      return behavior();
    },
  };
  Object.defineProperty(port, "calls", { get: () => calls });
  return port as SummaryModelPort & { calls: number };
}

// 场景：成功。预期：返回 text+usage。
describe("executeSummaryWithRetry success", () => {
  it("returns the summary text on first success", async () => {
    const port = makePort(() => ({
      ok: true as const,
      text: "summary",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    }));
    const result = await executeSummaryWithRetry(port, makeRequest());
    expect(result).toEqual({
      ok: true,
      text: "summary",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(port.calls).toBe(1);
  });
});

// 场景：retryable 错误。预期：自动重试一次成功后返回。
describe("executeSummaryWithRetry retry", () => {
  it("retries once after a retryable error and succeeds", async () => {
    let first = true;
    const port = makePort(() => {
      if (first) {
        first = false;
        return { ok: false as const, error: { kind: "retryable" as const, message: "network" } };
      }
      return { ok: true as const, text: "after retry" };
    });
    const result = await executeSummaryWithRetry(port, makeRequest());
    expect(result).toEqual({ ok: true, text: "after retry" });
    expect(port.calls).toBe(2);
  });

  it("fails after both attempts when retryable errors persist", async () => {
    const port = makePort(() => ({
      ok: false as const,
      error: { kind: "retryable" as const, message: "still down" },
    }));
    const result = await executeSummaryWithRetry(port, makeRequest());
    expect(result).toEqual({ ok: false, error: { kind: "retryable", message: "still down" } });
    expect(port.calls).toBe(2);
  });

  it("respects Retry-After when waiting before the retry", async () => {
    vi.useFakeTimers();
    try {
      let first = true;
      const port = makePort(() => {
        if (first) {
          first = false;
          return {
            ok: false as const,
            error: { kind: "retryable" as const, message: "429", retryAfterMs: 1500 },
          };
        }
        return { ok: true as const, text: "done" };
      });
      const promise = executeSummaryWithRetry(port, makeRequest());
      // 第一次调用已发生；等待期间不应有第二次调用
      expect(port.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(port.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(result).toEqual({ ok: true, text: "done" });
      expect(port.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 场景：permanent 错误。预期：不重试直接失败。
describe("executeSummaryWithRetry permanent", () => {
  it("does not retry permanent errors", async () => {
    const port = makePort(() => ({
      ok: false as const,
      error: { kind: "permanent" as const, message: "invalid auth" },
    }));
    const result = await executeSummaryWithRetry(port, makeRequest());
    expect(result).toEqual({ ok: false, error: { kind: "permanent", message: "invalid auth" } });
    expect(port.calls).toBe(1);
  });
});

// 场景：取消。预期：立即停止且不重试。
describe("executeSummaryWithRetry cancellation", () => {
  it("stops immediately and does not retry when aborted", async () => {
    const controller = new AbortController();
    let first = true;
    const port = makePort(() => {
      if (first) {
        first = false;
        controller.abort();
        return { ok: false as const, error: { kind: "retryable" as const, message: "slow" } };
      }
      return { ok: true as const, text: "should not happen" };
    });
    const result = await executeSummaryWithRetry(port, {
      ...makeRequest(),
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: "cancelled" } });
    expect(port.calls).toBe(1);
  });
});
