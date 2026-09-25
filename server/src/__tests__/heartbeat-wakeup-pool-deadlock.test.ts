import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "done",
  provider: "test",
  model: "test",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A wake transaction that asks the pool for a second connection while holding
// its own deadlocks the pool once concurrent wakes hold every connection. A
// one-connection pool turns that into a deterministic hang on the first wake.
function withinDeadline<T>(promise: Promise<T>, label: string, ms = 10_000) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms (pool deadlock?)`)), ms).unref(),
    ),
  ]);
}

describeEmbeddedPostgres("enqueueWakeup with a one-connection pool", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let singleConnectionDb!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-pool-deadlock-");
    db = createDb(temporary.connectionString);
    singleConnectionDb = createDb(temporary.connectionString, { maxConnections: 1 });
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Pool deadlock",
      issuePrefix: "PDL",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pool agent",
      adapterType: "codex_local",
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wake without a second pool connection",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
  }, 60_000);

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  it("queues an issue wake and resolves its responsible user on the transaction connection", async () => {
    const heartbeat = heartbeatService(singleConnectionDb);
    const queued = await withinDeadline(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
      }),
      "issue wake",
    );
    expect(queued).not.toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(run?.responsibleUserId).toBe("responsible-user");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }, 30_000);

  it("queues a wake without an issue on the transaction connection", async () => {
    const heartbeat = heartbeatService(singleConnectionDb);
    const queued = await withinDeadline(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "pool deadlock regression",
      }),
      "agent wake",
    );
    expect(queued).not.toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(run?.responsibleUserId).toBe("responsible-user");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }, 30_000);
});
