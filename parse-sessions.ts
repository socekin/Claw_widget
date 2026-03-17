import { readdirSync, statSync, realpathSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

// ── Types ──

export interface DailyUsage {
  date: string;
  tokens: number;
  totalCostUsd: number;
}

export interface AgentUsage {
  agentId: string;
  days: number;
  startDate: string;
  endDate: string;
  totalTokens: number;
  totalCostUsd: number;
  daily: DailyUsage[];
  latestTimestamp: number;
}

// ── Helpers ──

export function resolveOpenclawHome(configHome?: string): string {
  if (configHome) return configHome;
  if (process.env.OPENCLAW_HOME) return process.env.OPENCLAW_HOME;
  return join(homedir(), ".openclaw");
}

const SAFE_DIR_NAME = /^[a-zA-Z0-9_-]+$/;

export function discoverAgents(openclawHome: string): string[] {
  let agentsDir: string;
  try {
    agentsDir = realpathSync(join(openclawHome, "agents"));
  } catch {
    return [];
  }
  try {
    return readdirSync(agentsDir)
      .filter((name) => SAFE_DIR_NAME.test(name))
      .filter((name) => {
        const dirPath = join(agentsDir, name);
        try {
          const realPath = realpathSync(dirPath);
          if (!realPath.startsWith(agentsDir + "/")) return false;
          return statSync(join(realPath, "sessions")).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// ── JSONL Parsing ──

interface ParsedUsage {
  daily: Map<string, { tokens: number; cost: number }>;
  latestTs: number;
}

async function parseSessionJsonl(
  filePath: string,
  cutoffMs: number,
): Promise<ParsedUsage> {
  const daily = new Map<string, { tokens: number; cost: number }>();
  let latestTs = 0;

  let fileMtimeMs = 0;
  try {
    const stat = statSync(filePath);
    fileMtimeMs = stat.mtimeMs;
  } catch {
    return { daily, latestTs };
  }

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let currentModel: string | null = null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.type === "model_change") {
      currentModel = entry.modelId ?? null;
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg || msg.role !== "assistant" || !msg.usage) continue;
    if (!currentModel) continue;

    const timestamp =
      typeof msg.timestamp === "number" ? msg.timestamp : fileMtimeMs;
    if (timestamp && timestamp < cutoffMs) continue;

    const usage = msg.usage;

    // Always sum components (matching tokscale behavior).
    // usage.totalTokens may include context/system tokens not in the breakdown.
    const tokens =
      Math.max(0, usage.input ?? 0) +
      Math.max(0, usage.output ?? 0) +
      Math.max(0, usage.cacheRead ?? 0) +
      Math.max(0, usage.cacheWrite ?? 0);

    const cost =
      typeof usage.cost?.total === "number" ? usage.cost.total : 0;

    const date = new Date(timestamp || Date.now()).toISOString().slice(0, 10);
    const existing = daily.get(date) ?? { tokens: 0, cost: 0 };
    existing.tokens += Math.max(0, tokens);
    existing.cost += Math.max(0, cost);
    daily.set(date, existing);

    if (timestamp > latestTs) latestTs = timestamp;
  }

  return { daily, latestTs };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ── Public API ──

export async function parseAgentUsage(
  openclawHome: string,
  days: number,
): Promise<AgentUsage[]> {
  const agents = discoverAgents(openclawHome);
  const now = Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;
  const endDate = new Date(now).toISOString().slice(0, 10);
  const startDate = new Date(cutoffMs).toISOString().slice(0, 10);

  const results: AgentUsage[] = [];

  for (const agentId of agents) {
    const sessionsDir = join(openclawHome, "agents", agentId, "sessions");

    // Scan directory for *.jsonl files directly (matching tokscale behavior).
    // sessions.json index is incomplete — not all JSONL files are listed.
    let jsonlFiles: string[] = [];
    try {
      jsonlFiles = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(sessionsDir, f));
    } catch {
      continue;
    }

    const agentDaily = new Map<string, { tokens: number; cost: number }>();
    let latestTs = 0;

    for (const sessionPath of jsonlFiles) {
      const { daily, latestTs: ts } = await parseSessionJsonl(
        sessionPath,
        cutoffMs,
      );

      for (const [date, data] of daily) {
        const existing = agentDaily.get(date) ?? { tokens: 0, cost: 0 };
        existing.tokens += data.tokens;
        existing.cost += data.cost;
        agentDaily.set(date, existing);
      }

      if (ts > latestTs) latestTs = ts;
    }

    const dailyArray: DailyUsage[] = Array.from(agentDaily.entries())
      .map(([date, data]) => ({
        date,
        tokens: data.tokens,
        totalCostUsd: round4(data.cost),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalTokens = dailyArray.reduce((sum, d) => sum + d.tokens, 0);
    const rawTotalCost = Array.from(agentDaily.values()).reduce(
      (sum, d) => sum + d.cost,
      0,
    );

    results.push({
      agentId,
      days,
      startDate,
      endDate,
      totalTokens,
      totalCostUsd: round4(rawTotalCost),
      daily: dailyArray,
      latestTimestamp: latestTs,
    });
  }

  return results;
}

export function aggregateUsage(
  agentUsages: AgentUsage[],
  days: number,
): {
  days: number;
  startDate: string;
  endDate: string;
  totalTokens: number;
  totalCostUsd: number;
  daily: DailyUsage[];
  updatedAt: number;
} {
  const now = Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;
  const endDate = new Date(now).toISOString().slice(0, 10);
  const startDate = new Date(cutoffMs).toISOString().slice(0, 10);

  const mergedDaily = new Map<string, { tokens: number; cost: number }>();
  let latestTs = 0;

  for (const agent of agentUsages) {
    for (const d of agent.daily) {
      const existing = mergedDaily.get(d.date) ?? { tokens: 0, cost: 0 };
      existing.tokens += d.tokens;
      existing.cost += d.totalCostUsd;
      mergedDaily.set(d.date, existing);
    }
    if (agent.latestTimestamp > latestTs) latestTs = agent.latestTimestamp;
  }

  const daily = Array.from(mergedDaily.entries())
    .map(([date, data]) => ({
      date,
      tokens: data.tokens,
      totalCostUsd: round4(data.cost),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalTokens = daily.reduce((sum, d) => sum + d.tokens, 0);
  const rawTotalCost = Array.from(mergedDaily.values()).reduce(
    (sum, d) => sum + d.cost,
    0,
  );

  return {
    days,
    startDate,
    endDate,
    totalTokens,
    totalCostUsd: round4(rawTotalCost),
    daily,
    updatedAt: latestTs || now,
  };
}
