import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  toolConnectionInstalls,
  toolProfileBindings,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { agentService } from "../services/agents.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * MAR-519 — an install row left behind by a deleted agent made every later
 * write of the install list fail with 422 ("agent must belong to the same
 * company"), which blocked completing a connection card. Deleting the agent now
 * removes its rows, and a write can always drop a row whose agent is gone.
 */

const MCP_ORIGIN = "https://203.0.113.10";
const MCP_URL = `${MCP_ORIGIN}/mcp`;
const HEADER = { name: "X-Api-Key", value: "fixture-secret-value" };
const FIXTURE_TOOLS = [
  { name: "list_things", description: "List things", annotations: { readOnlyHint: true } },
];

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/**
 * The narrowest endpoint that satisfies a header-authenticated connect: it lists
 * tools when the expected header arrives and 401s otherwise, which is all the
 * catalog refresh and health check need.
 */
function installMcpFixture(requiredHeader: { name: string; value: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    if (href === MCP_URL && method === "POST") {
      if (headers[requiredHeader.name.toLowerCase()] !== requiredHeader.value) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });
}

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `Removal ${randomUUID()}`,
      issuePrefix: `RM${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Removal agent ${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

function createRouteApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(db));
  app.use(errorHandler);
  return app;
}


describeEmbeddedPostgres("orphaned agent connection installs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const actor = { actorType: "user" as const, actorId: "board-user" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-installs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function connectApp(companyId: string, agentId: string) {
    installMcpFixture(HEADER);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(companyId, {
      link: MCP_URL,
      name: `Orphan fixture ${randomUUID().slice(0, 8)}`,
      credentialValues: { [`headers.${HEADER.name}`]: HEADER.value },
    });
    const readEntry = connected.catalog.find((entry) => entry.toolName === "list_things")!;
    await service.finishGalleryAppConnection(companyId, connected.connectionId, {
      enabledCatalogEntryIds: [readEntry.id],
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agentId] },
    }, actor);
    await service.putConnectionInstalls(connected.connectionId, {
      installs: [{ targetType: "agent", targetId: agentId, enabled: true }],
    }, actor);
    return { service, connectionId: connected.connectionId };
  }

  const installsOf = (connectionId: string) =>
    db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));

  it("deleting an agent removes its installs and profile bindings", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connectionId } = await connectApp(company.id, agent.id);
    expect(await installsOf(connectionId)).toHaveLength(1);

    await agentService(db).remove(agent.id);

    expect(await installsOf(connectionId)).toHaveLength(0);
    const bindings = await db.select().from(toolProfileBindings).where(and(
      eq(toolProfileBindings.targetType, "agent"),
      eq(toolProfileBindings.targetId, agent.id),
    ));
    expect(bindings).toHaveLength(0);
  });

  it("rewriting the install list drops an orphan row instead of failing with 422", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId } = await connectApp(company.id, agent.id);
    const ghostId = randomUUID();
    await db.insert(toolConnectionInstalls).values({
      companyId: company.id, connectionId, targetType: "agent", targetId: ghostId,
    });

    // What a client does: send back the list it read, orphan included.
    const snapshot = await service.putConnectionInstalls(connectionId, {
      installs: [
        { targetType: "agent", targetId: agent.id, enabled: true },
        { targetType: "agent", targetId: ghostId, enabled: true },
      ],
    }, actor);

    expect(snapshot.installs.map((install) => install.targetId)).toEqual([agent.id]);
    expect((await installsOf(connectionId)).map((row) => row.targetId)).toEqual([agent.id]);
  });

  it("PUT installs can remove an orphan row", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connectionId } = await connectApp(company.id, agent.id);
    const ghostId = randomUUID();
    await db.insert(toolConnectionInstalls).values({
      companyId: company.id, connectionId, targetType: "agent", targetId: ghostId,
    });

    const response = await request(createRouteApp(db))
      .put(`/api/tool-connections/${connectionId}/installs`)
      .send({ installs: [{ targetType: "agent", targetId: agent.id, enabled: true }] });

    expect(response.status).toBe(200);
    expect((await installsOf(connectionId)).map((row) => row.targetId)).toEqual([agent.id]);
  });

  it("still rejects adding an agent from another company", async () => {
    const company = await createCompany(db);
    const other = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const stranger = await createAgent(db, other.id);
    const { service, connectionId } = await connectApp(company.id, agent.id);

    await expect(service.putConnectionInstalls(connectionId, {
      installs: [
        { targetType: "agent", targetId: agent.id, enabled: true },
        { targetType: "agent", targetId: stranger.id, enabled: true },
      ],
    }, actor)).rejects.toMatchObject({ status: 422 });
    await expect(service.putConnectionInstalls(connectionId, {
      installs: [{ targetType: "agent", targetId: randomUUID(), enabled: true }],
    }, actor)).rejects.toMatchObject({ status: 422 });
    expect((await installsOf(connectionId)).map((row) => row.targetId)).toEqual([agent.id]);
  });
});
