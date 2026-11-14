import { describe, expect, test } from "bun:test";
import {
  approveSessionPlan,
  createSession,
  getSession,
  setSessionAwaitingInput,
} from "../src/db";

describe("approveSessionPlan", () => {
  test("approves the plan and clears awaiting input", () => {
    const session = createSession({ title: "stuck plan" });
    expect(session.plan_approved_at).toBeNull();
    setSessionAwaitingInput(session.id, "plan");

    approveSessionPlan(session.id);

    const approved = getSession(session.id)!;
    expect(approved.plan_approved_at).toBeString();
    expect(Number.isNaN(Date.parse(approved.plan_approved_at!))).toBe(false);
    expect(approved.awaiting_input_at).toBeNull();
    expect(approved.awaiting_reason).toBeNull();
  });

  test("approving again keeps the first approval timestamp", async () => {
    const session = createSession({ title: "already approved plan" });
    approveSessionPlan(session.id);
    const firstApproval = getSession(session.id)!.plan_approved_at;

    // Cross a clock tick so replacing the timestamp would fail this assertion.
    await Bun.sleep(5);
    approveSessionPlan(session.id);

    expect(getSession(session.id)!.plan_approved_at).toBe(firstApproval);
  });
});
