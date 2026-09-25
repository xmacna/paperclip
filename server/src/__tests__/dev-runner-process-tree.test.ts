import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findServerLaunchChain,
  isProcessAlive,
  parseProcessTable,
  readServerLaunchChain,
  signalProcess,
  waitForProcessesToExit,
} from "../../../scripts/dev-runner-process-tree.ts";

// Shape observed on a Linux host: the dev runner's pnpm child runs the server
// script through `sh -c`; the server's own children (embedded Postgres, agent
// runs) share the process group and must not be signalled by a restart.
const observedTable = `
  228356       1 node --require tsx/dist/preflight.cjs ../scripts/dev-runner.ts dev
  229622  228356 node /usr/bin/pnpm --filter @paperclipai/server dev
  229644  229622 sh -c tsx src/index.ts
  229645  229644 node /repo/server/node_modules/.bin/../tsx/dist/cli.mjs src/index.ts
  229673  229645 /usr/bin/node --require /repo/node_modules/tsx/dist/preflight.cjs --import file:///repo/node_modules/tsx/dist/loader.mjs src/index.ts
  229955  229673 /repo/node_modules/@embedded-postgres/linux-x64/native/bin/postgres -D /data/db -p 54329
  230210  229673 node /repo/packages/adapters/claude-local/dist/run.js
`;

describe("findServerLaunchChain", () => {
  it("walks pnpm, sh and the tsx CLI and stops at the server", () => {
    expect(findServerLaunchChain(parseProcessTable(observedTable), 229622)).toEqual({
      wrappers: [229622, 229644, 229645],
      server: 229673,
    });
  });

  it("does not descend into a server that has a single child", () => {
    const table = parseProcessTable(observedTable).filter((entry) => entry.pid !== 230210);
    expect(findServerLaunchChain(table, 229622)?.server).toBe(229673);
  });

  it("returns null when the chain does not reach a tsx CLI", () => {
    const table = parseProcessTable(`
      10 1 node /usr/bin/pnpm --filter @paperclipai/server dev
      11 10 sh -c node dist/index.js
      12 11 node dist/index.js
      13 12 postgres -D /data/db
    `);
    expect(findServerLaunchChain(table, 10)).toBeNull();
  });

  it("returns null when the chain branches before the tsx CLI", () => {
    const table = parseProcessTable(`
      10 1 node /usr/bin/pnpm --filter @paperclipai/server dev
      11 10 sh -c tsx src/index.ts
      12 10 sh -c something-else
    `);
    expect(findServerLaunchChain(table, 10)).toBeNull();
  });
});

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("signalling a live sh -c tsx launch chain", () => {
  const require = createRequire(import.meta.url);
  const tsxCli = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
  const spawned: number[] = [];
  let tempDir: string | null = null;

  afterEach(() => {
    for (const pid of spawned) signalProcess(pid, "SIGKILL");
    spawned.length = 0;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function launch() {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "dev-runner-process-tree-"));
    const pidFile = path.join(tempDir, "server.pid");
    const signalLog = path.join(tempDir, "signals.log");
    const server = path.join(tempDir, "server.mjs");
    writeFileSync(
      server,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'process.on("SIGTERM", () => {',
        `  appendFileSync(${JSON.stringify(signalLog)}, "SIGTERM\\n");`,
        "  setTimeout(() => process.exit(0), 300);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    // `; exit $?` keeps sh alive as a separate process, as pnpm's script shell is.
    const shell = spawn("sh", ["-c", `"${process.execPath}" "${tsxCli}" "${server}"; exit $?`], { stdio: "ignore" });
    spawned.push(shell.pid!);
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const serverPid = Number(readFileSync(pidFile, "utf8"));
    spawned.push(serverPid);
    return { shellPid: shell.pid!, serverPid, signalLog };
  }

  it("orphans the server when only the sh wrapper is signalled", async () => {
    const { shellPid, serverPid } = await launch();
    signalProcess(shellPid, "SIGTERM");
    await waitForProcessesToExit([shellPid], 2_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isProcessAlive(serverPid)).toBe(true);
  }, 20_000);

  it("delivers exactly one SIGTERM to the server through the tsx CLI", async () => {
    const { shellPid, serverPid, signalLog } = await launch();
    const chain = readServerLaunchChain(shellPid);
    expect(chain?.server).toBe(serverPid);
    for (const pid of chain!.wrappers) signalProcess(pid, "SIGTERM");
    const survivors = await waitForProcessesToExit([...chain!.wrappers, serverPid], 5_000);
    expect(survivors).toEqual([]);
    expect(readFileSync(signalLog, "utf8")).toBe("SIGTERM\n");
  }, 20_000);
});
