import { timingSafeEqual } from "node:crypto";
// Note: OpenClaw loads TS plugins via jiti which resolves .ts imports directly.
import {
  parseAgentUsage,
  aggregateUsage,
  resolveOpenclawHome,
} from "./parse-sessions.ts";

// ── HTTP Helpers (unchanged from v0.1.0) ──

function sendJson(
  res: any,
  status: number,
  body: unknown,
  cacheHit?: boolean,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (cacheHit !== undefined) {
    res.setHeader("X-Cache", cacheHit ? "hit" : "miss");
  }
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

// ── Cache with stampede protection ──

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<any>>();
const inflightRequests = new Map<string, Promise<any>>();

async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ data: T; hit: boolean }> {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return { data: entry.data, hit: true };
  }

  let inflight = inflightRequests.get(key);
  if (!inflight) {
    inflight = fn().then((result) => {
      cache.set(key, { data: result, expiresAt: Date.now() + ttlMs });
      inflightRequests.delete(key);
      return result;
    }).catch((err) => {
      inflightRequests.delete(key);
      throw err;
    });
    inflightRequests.set(key, inflight);
  }

  const data = await inflight;
  return { data, hit: false };
}

// ── Health module ──
// The plugin runs inside the gateway process. If a request reaches this handler,
// the gateway is definitionally "up". No subprocess call needed.

function fetchHealth(): { status: string; latencyMs: number | null; checkedAt: number | null } {
  return {
    status: "up",
    latencyMs: 0,
    checkedAt: Date.now(),
  };
}

// ── Config helpers ──

function readConfig(api: any) {
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
  const cacheTtlMs =
    Math.max(10, Math.min(300, Number(pluginConfig.cacheTtlSeconds ?? 60) || 60)) * 1000;
  const openclawHome = resolveOpenclawHome(
    typeof pluginConfig.openclawHome === "string" && pluginConfig.openclawHome.trim()
      ? pluginConfig.openclawHome.trim()
      : undefined,
  );

  return { apiToken, cliPath, timeoutMs, defaultDays, cacheTtlMs, openclawHome };
}

function parseDays(req: any, defaultDays: number): number {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = Number(url.searchParams.get("days"));
    if (Number.isFinite(raw) && raw >= 1 && raw <= 90) {
      return Math.floor(raw);
    }
  } catch {
    // ignore malformed query
  }
  return defaultDays;
}

// ── Shared auth middleware ──

function authCheck(
  req: any,
  res: any,
  apiToken: string,
): boolean {
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return false;
  }
  if (!apiToken) {
    sendJson(res, 500, { ok: false, error: "plugin_not_configured" });
    return false;
  }
  const incomingToken = readBearerToken(req);
  if (!incomingToken || !safeEqual(incomingToken, apiToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ── Plugin export ──

export default {
  id: "openclaw-widget-bridge",
  register(api: any) {
    // GET /widget/summary — backward compatible with v0.1.0
    api.registerHttpRoute({
      path: "/widget/summary",
      auth: "plugin",
      handler: async (req: any, res: any) => {
        const cfg = readConfig(api);
        if (!authCheck(req, res, cfg.apiToken)) return;

        const days = parseDays(req, cfg.defaultDays);

        const health = fetchHealth();

        try {
          const { data: usage, hit } = await cached(
            `usage:${days}`,
            cfg.cacheTtlMs,
            async () => {
              const agents = await parseAgentUsage(cfg.openclawHome, days);
              return aggregateUsage(agents, days);
            },
          );

          sendJson(res, 200, {
            ok: true,
            updatedAt: Date.now(),
            health,
            usage,
          }, hit);
        } catch {
          sendJson(res, 200, {
            ok: true,
            updatedAt: Date.now(),
            health,
            usage: { days, startDate: null, endDate: null, totalTokens: null, totalCostUsd: null, daily: [], updatedAt: null },
          }, false);
        }
      },
    });

    // GET /widget/agents — new endpoint, per-agent breakdown
    api.registerHttpRoute({
      path: "/widget/agents",
      auth: "plugin",
      handler: async (req: any, res: any) => {
        const cfg = readConfig(api);
        if (!authCheck(req, res, cfg.apiToken)) return;

        const days = parseDays(req, cfg.defaultDays);

        try {
          const { data: agents, hit } = await cached(
            `agents:${days}`,
            cfg.cacheTtlMs,
            () => parseAgentUsage(cfg.openclawHome, days),
          );

          sendJson(res, 200, {
            ok: true,
            updatedAt: Date.now(),
            agents: agents.map(({ latestTimestamp, ...rest }) => rest),
          }, hit);
        } catch {
          sendJson(res, 200, {
            ok: true,
            updatedAt: Date.now(),
            agents: [],
          }, false);
        }
      },
    });
  },
};
