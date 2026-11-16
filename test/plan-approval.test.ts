import { afterEach, expect, test, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approveSessionPlan, createSession, deleteSession, getSession, setSessionAwaitingInput } from "../src/db";
import { requestPlanApproval } from "../src/mcp/supervisor-server";

const sessions: string[] = [];
afterEach(() => { for (const id of sessions.splice(0)) deleteSession(id); });
function fixture() {
  const session = createSession({});
  sessions.push(session.id);
  setSessionAwaitingInput(session.id, "plan");
  return session.id;
}
function client(result: unknown, capable = true) {
  const elicitInput = mock(async () => result);
  return { elicitInput, getClientCapabilities: () => capable ? { elicitation: {} } : {} } as unknown as Pick<McpServer["server"], "getClientCapabilities" | "elicitInput">;
}

test("accepted approval presents the summary and approves", async () => {
  const id = fixture();
  const c = client({ action: "accept", content: { decision: "approve" } });
  expect(await requestPlanApproval(c, id, "Build it")).toMatchObject({ approved: true });
  expect(c.elicitInput).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Build it") }));
  expect(getSession(id)?.plan_approved_at).toBeTruthy();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

test("keep planning returns feedback without approval", async () => {
  const id = fixture();
  const result = await requestPlanApproval(client({ action: "accept", content: { decision: "keep_planning", feedback: "Change scope" } }), id, "Plan");
  expect(result).toMatchObject({ approved: false, keepPlanning: true, feedback: "Change scope" });
  expect(getSession(id)?.plan_approved_at).toBeNull();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

for (const action of ["cancel", "decline"]) {
  test(`${action} leaves the plan unapproved`, async () => {
    const id = fixture();
    expect(await requestPlanApproval(client({ action }), id, "Plan")).toMatchObject({ approved: false });
    expect(getSession(id)?.plan_approved_at).toBeNull();
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

test("missing capability and elicitation errors fail closed", async () => {
  for (const c of [client(null, false), client(Promise.reject(new Error("unavailable")))]) {
    const id = fixture();
    const result = await requestPlanApproval(c, id, "Plan");
    expect(result).toMatchObject({ approved: false, note: expect.stringContaining("/approve") });
    expect(getSession(id)?.plan_approved_at).toBeNull();
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  }
});

test("already approved skips elicitation", async () => {
  const id = fixture();
  approveSessionPlan(id);
  setSessionAwaitingInput(id, "plan");
  const c = client(null);
  expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({ approved: true });
  expect(c.elicitInput).not.toHaveBeenCalled();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});
