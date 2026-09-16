import type { SummaryModelPort, SummaryRequest, SummaryResponse } from "./summary-port.js";

// M6.9 摘要执行适配：包装 SummaryModelPort，落实可控重试/取消语义。
// 网络/429/可恢复 5xx 自动重试一次并遵守 Retry-After（等待期间可取消）；
// authentication/invalid/overflow 等 permanent 错误不重试；用户取消立即停止且不重试。
export async function executeSummaryWithRetry(
  port: SummaryModelPort,
  request: SummaryRequest,
): Promise<SummaryResponse> {
  const first = await port.summarize(request);
  if (first.ok || first.error.kind === "permanent" || first.error.kind === "cancelled") {
    return first;
  }
  if (request.signal?.aborted) {
    return { ok: false, error: { kind: "cancelled" } };
  }
  // retryable：遵守 Retry-After 等待后重试一次。
  const retryAfterMs = first.error.retryAfterMs ?? 0;
  if (retryAfterMs > 0) {
    await waitWithAbort(retryAfterMs, request.signal);
    if (request.signal?.aborted) {
      return { ok: false, error: { kind: "cancelled" } };
    }
  }
  return port.summarize(request);
}

// 等待 retryAfterMs 毫秒；AbortSignal 触发时提前结束（由调用方检查 aborted 决定是否取消）。
function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
