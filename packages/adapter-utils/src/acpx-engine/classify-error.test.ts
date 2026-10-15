import { describe, expect, it } from "vitest";
import { classifyError } from "./execute.js";

describe("classifyError", () => {
  it("labels a login failure as auth required", () => {
    expect(classifyError(new Error("Please login to continue")).errorCode).toBe("acpx_auth_required");
  });

  it("does not label a database failure as auth just because its SQL echoes an auth word", () => {
    const err = new Error('Failed query: insert into "heartbeat_run_events" ("message") values ($1)\nparams: authentication required');
    expect(classifyError(err).errorCode).toBe("acpx_runtime_error");
  });
});
