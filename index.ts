import { timingSafeEqual } from "node:crypto";

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBearerToken(req: any): string | null {
  const raw = String(req.headers?.authorization ?? "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDailyUsage(
  value: unknown,
): Array<{ date: string; tokens: number; totalCostUsd: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const daily: Array<{ date: string; tokens: number; totalCostUsd: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const date = typeof entry.date === "string" ? entry.date : "";
    if (!date) {
      continue;
    }

    const tokens =
      toFiniteNumber(entry.totalTokens) ??
      (toFiniteNumber(entry.input) ?? 0) +
        (toFiniteNumber(entry.output) ?? 0) +
        (toFiniteNumber(entry.cacheRead) ?? 0) +
        (toFiniteNumber(entry.cacheWrite) ?? 0);

    const totalCostUsd =
      toFiniteNumber(entry.totalCost) ??
      (toFiniteNumber(entry.inputCost) ?? 0) +
        (toFiniteNumber(entry.outputCost) ?? 0) +
        (toFiniteNumber(entry.cacheReadCost) ?? 0) +
        (toFiniteNumber(entry.cacheWriteCost) ?? 0);

    daily.push({ date, tokens, totalCostUsd });
  }

  return daily;
}

function parseJsonOutput(stdout: string): any {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("empty gateway output");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("invalid JSON from gateway call");
  }
}

async function callGatewayMethod(params: {
  api: any;
  cliPath: string;
  timeoutMs: number;
  method: string;
  payload?: Record<string, unknown>;
}): Promise<any> {
  const args = [
    params.cliPath,
    "gateway",
    "call",
    params.method,
    "--json",
    "--timeout",
    String(params.timeoutMs),
  ];
  if (params.payload) {
    args.push("--params", JSON.stringify(params.payload));
  }

  const result = await params.api.runtime.system.runCommandWithTimeout(args, {
    timeoutMs: params.timeoutMs + 2000,
  });

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "gateway call failed").trim());
  }

  return parseJsonOutput(result.stdout);
}

export default {
  id: "openclaw-widget-bridge",
  register(api: any) {
    api.registerHttpRoute({
      path: "/widget/summary",
      handler: async (req: any, res: any) => {
        if ((req.method ?? "GET").toUpperCase() !== "GET") {
          sendJson(res, 405, { ok: false, error: "method_not_allowed" });
          return;
        }

        const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
        const apiToken = String(pluginConfig.apiToken ?? "").trim();
        const cliPath = String(pluginConfig.cliPath ?? "openclaw").trim();
        const timeoutMs = Math.max(
          2000,
          Math.min(20000, Number(pluginConfig.timeoutMs ?? 8000) || 8000),
        );
        const defaultDays = Math.max(
          1,
          Math.min(90, Number(pluginConfig.usageDays ?? 7) || 7),
        );

        if (!apiToken) {
          sendJson(res, 500, { ok: false, error: "plugin_not_configured" });
          return;
        }

        const incomingToken = readBearerToken(req);
        if (!incomingToken || !safeEqual(incomingToken, apiToken)) {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }

        let days = defaultDays;
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const raw = Number(url.searchParams.get("days"));
          if (Number.isFinite(raw) && raw >= 1 && raw <= 90) {
            days = Math.floor(raw);
          }
        } catch {
          // ignore malformed query
        }

        const [healthResult, usageResult] = await Promise.allSettled([
          callGatewayMethod({
            api,
            cliPath,
            timeoutMs,
            method: "health",
          }),
          callGatewayMethod({
            api,
            cliPath,
            timeoutMs,
            method: "usage.cost",
            payload: { days },
          }),
        ]);

        const healthPayload = healthResult.status === "fulfilled" ? healthResult.value : null;
        const usagePayload = usageResult.status === "fulfilled" ? usageResult.value : null;

        const healthOk =
          typeof healthPayload?.ok === "boolean" ? healthPayload.ok : healthResult.status === "fulfilled";

        sendJson(res, 200, {
          ok: true,
          updatedAt: Date.now(),
          health: {
            status: healthOk ? "up" : "down",
            latencyMs: toFiniteNumber(healthPayload?.durationMs),
            checkedAt: toFiniteNumber(healthPayload?.ts),
          },
          usage: {
            days,
            startDate: typeof usagePayload?.startDate === "string" ? usagePayload.startDate : null,
            endDate: typeof usagePayload?.endDate === "string" ? usagePayload.endDate : null,
            totalTokens: toFiniteNumber(usagePayload?.totals?.totalTokens),
            totalCostUsd: toFiniteNumber(usagePayload?.totals?.totalCost),
            daily: normalizeDailyUsage(usagePayload?.daily),
            updatedAt: toFiniteNumber(usagePayload?.updatedAt),
          },
        });
      },
    });
  },
};
