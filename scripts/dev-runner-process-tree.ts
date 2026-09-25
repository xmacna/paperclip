import { execFileSync } from "node:child_process";

export type ProcessEntry = { pid: number; ppid: number; args: string };

export type ServerLaunchChain = {
  /** pnpm down to the tsx CLI, in launch order. */
  wrappers: number[];
  /** The server process the tsx CLI runs; its own children are left alone. */
  server: number | null;
};

const TSX_CLI_PATTERN = /[\\/]tsx[\\/]dist[\\/]cli\.[cm]?js(\s|$)/;
const MAX_CHAIN_DEPTH = 8;

export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3].trim() });
  }
  return entries;
}

/**
 * pnpm runs the server script through `sh -c`, and sh exits on SIGTERM
 * without forwarding it, so signalling only pnpm leaves the tsx CLI and the
 * server running (and still bound to the port). Walk the single-child chain
 * from pnpm to the tsx CLI, which relays a signal to the server exactly once.
 * Returns null when the chain does not end in a tsx CLI, so callers keep the
 * plain child signal instead of guessing which process is the server.
 */
export function findServerLaunchChain(table: ProcessEntry[], rootPid: number): ServerLaunchChain | null {
  const childrenOf = (pid: number) => table.filter((entry) => entry.ppid === pid);
  const wrappers: number[] = [];
  let current = table.find((entry) => entry.pid === rootPid);
  while (current && wrappers.length < MAX_CHAIN_DEPTH) {
    wrappers.push(current.pid);
    const children = childrenOf(current.pid);
    if (TSX_CLI_PATTERN.test(current.args)) {
      return { wrappers, server: children.length === 1 ? children[0].pid : null };
    }
    if (children.length !== 1) return null;
    current = children[0];
  }
  return null;
}

export function readServerLaunchChain(rootPid: number): ServerLaunchChain | null {
  if (process.platform === "win32") return null;
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return findServerLaunchChain(parseProcessTable(output), rootPid);
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

export async function waitForProcessesToExit(pids: number[], timeoutMs: number, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isProcessAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    alive = alive.filter(isProcessAlive);
  }
  return alive;
}
