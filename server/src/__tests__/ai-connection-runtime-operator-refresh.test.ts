import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

// xmacna: a Claude subscription imported from the server operator's own login
// must follow the live token in CLAUDE_CONFIG_DIR, because Claude Code rotates
// it (~8h) and the provider revokes the stored snapshot.

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let claudeConfigDir: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-operator-refresh-"));
  claudeConfigDir = path.join(home, "claude-config");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "operator-refresh");
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfigDir);
  database = await startEmbeddedPostgresTestDatabase("paperclip-operator-refresh-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function writeLiveCredential(accessToken: string, expiresAt: number) {
  await rm(claudeConfigDir, { recursive: true, force: true });
  await mkdir(claudeConfigDir, { recursive: true });
  await writeFile(
    path.join(claudeConfigDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }),
    { mode: 0o600 },
  );
}

async function fixture(operatorLogin: boolean) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  const binding = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;
  await db.insert(companies).values({ id: companyId, name: "Operator refresh test", issuePrefix: `O${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Manager", role: "ceo", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });
  await aiConnectionService(db).save(
    companyId,
    userId,
    { provider: "anthropic", method: "subscription", name: "Operator's Claude", ownership: "personal", agentIds: [agentId], allAgents: false, loginSessionId: "fixture" },
    "stored-token",
    undefined,
    new Date(),
    operatorLogin ? { operatorLogin: true } : {},
  );
  const select = () => aiConnectionService(db).select({ companyId, userId, agentId, adapterType: "claude_local", binding });
  const runtime = () => prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "claude_local", binding, config: {} });
  return { companyId, userId, agentId, select, runtime };
}

describe("operator-login Claude subscriptions follow the live token", () => {
  it("uses the live token for the run and rotates the stored secret", async () => {
    const f = await fixture(true);
    await writeLiveCredential("live-token", Date.now() + 60 * 60 * 1000);
    const runtime = await f.runtime();
    try {
      expect(runtime.config.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "live-token" });
    } finally {
      await runtime.cleanup();
    }
    const service = aiConnectionService(db);
    expect(await service.credential(await f.select())).toBe("live-token");
  });

  it("keeps the stored token when the live file is expired or missing", async () => {
    const f = await fixture(true);
    await writeLiveCredential("dead-token", Date.now() - 1000);
    let runtime = await f.runtime();
    try {
      expect(runtime.config.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "stored-token" });
    } finally {
      await runtime.cleanup();
    }
    await rm(claudeConfigDir, { recursive: true, force: true });
    runtime = await f.runtime();
    try {
      expect(runtime.config.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "stored-token" });
    } finally {
      await runtime.cleanup();
    }
    expect(await aiConnectionService(db).credential(await f.select())).toBe("stored-token");
  });

  it("leaves connections without the operator-login marker untouched", async () => {
    const f = await fixture(false);
    await writeLiveCredential("live-token", Date.now() + 60 * 60 * 1000);
    const runtime = await f.runtime();
    try {
      expect(runtime.config.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "stored-token" });
    } finally {
      await runtime.cleanup();
    }
    expect(await aiConnectionService(db).credential(await f.select())).toBe("stored-token");
  });
});
