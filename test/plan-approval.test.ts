import { afterEach, expect, test, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approveSessionPlan, createSession, deleteSession, getSession, setSessionAwaitingInput } from "../src/db";
import { planApprovalMessage, requestPlanApproval } from "../src/mcp/supervisor-server";
import { answeredQuestionHookArgs, awaitPlanHookArgs, awaitQuestionHookArgs } from "../src/supervisor/supervise";

const sessions: string[] = [];
afterEach(() => {
  for (const id of sessions.splice(0)) deleteSession(id);
});
function fixture() {
  const session = createSession({});
  sessions.push(session.id);
  setSessionAwaitingInput(session.id, "plan");
  return session.id;
}
function client(result: unknown, capable = true) {
  const elicitInput = mock(async () => result);
  return {
    elicitInput,
    getClientCapabilities: () => capable ? { elicitation: {} } : {},
  } as unknown as Pick<McpServer["server"], "getClientCapabilities" | "elicitInput">;
}

test("plan approval message shows only the goal", () => {
  const prompt = "Review the plan above — submit blank to approve, or say what to change.";
  const message = planApprovalMessage("Goal sentence\n- tack: do X\n- penny: do Y");
  expect(message).toBe(`${prompt}\n\nGoal sentence`);
  expect(message.split("\n").length).toBeLessThanOrEqual(3);
  expect(planApprovalMessage("\n  \n  Goal sentence  \n- tack: do X")).toBe(`${prompt}\n\nGoal sentence`);
  expect(planApprovalMessage(" \n\t\n ")).toBe(prompt);
});

test("accepted approval presents the form and approves", async () => {
  const id = fixture();
  const c = client({ action: "accept", content: {} });
  expect(await requestPlanApproval(c, id, "Build it")).toMatchObject({ approved: true });
  expect(c.elicitInput).toHaveBeenCalledWith({
    message: "Review the plan above — submit blank to approve, or say what to change.\n\nBuild it",
    requestedSchema: {
      type: "object",
      properties: {
        feedback: { type: "string", title: "What would you change?" },
      },
    },
  }, { timeout: 24 * 60 * 60 * 1000 });
  expect(getSession(id)?.plan_approved_at).toBeTruthy();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

for (const result of [
  { action: "accept", content: { feedback: "   " } },
  { action: "accept" },
]) {
  test(`${JSON.stringify(result)} approves`, async () => {
    const id = fixture();
    expect(await requestPlanApproval(client(result), id, "Plan")).toMatchObject({ approved: true });
    expect(getSession(id)?.plan_approved_at).toBeTruthy();
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

test("keep planning returns feedback without approval", async () => {
  const id = fixture();
  const c = client({ action: "accept", content: { feedback: "Change scope" } });
  expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({
    approved: false, keepPlanning: true, feedback: "Change scope",
  });
  expect(getSession(id)?.plan_approved_at).toBeNull();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

for (const result of [
  { action: "cancel" },
  { action: "decline" },
]) {
  test(`${JSON.stringify(result)} leaves the plan unapproved`, async () => {
    const id = fixture();
    expect(await requestPlanApproval(client(result), id, "Plan")).toMatchObject({ approved: false });
    expect(getSession(id)?.plan_approved_at).toBeNull();
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

test("missing capability and elicitation errors preserve the awaiting marker", async () => {
  for (const c of [client(null, false), client(Promise.reject(new Error("unavailable")))]) {
    const id = fixture();
    const result = await requestPlanApproval(c, id, "Plan");
    expect(result).toMatchObject({ approved: false, note: expect.stringContaining(`tack session approve ${id}`) });
    expect(getSession(id)?.plan_approved_at).toBeNull();
    expect(getSession(id)?.awaiting_input_at).toBeTruthy();
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

for (const outcome of ["keep planning", "cancel", "error"]) {
  test(`out-of-band approval wins over ${outcome}`, async () => {
    const id = fixture();
    const c = client(null);
    c.elicitInput = mock(async () => {
      approveSessionPlan(id);
      if (outcome === "error") throw new Error("unavailable");
      return outcome === "cancel"
        ? { action: "cancel" as const }
        : { action: "accept" as const, content: { feedback: "revise" } };
    });
    expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({ approved: true });
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

test("supervisor plan hook has no reason argument", () => {
  expect(awaitPlanHookArgs("ses_x")).toEqual(["__await-plan", "ses_x"]);
});

test("supervisor question hooks set and clear only the question reason", () => {
  expect(awaitQuestionHookArgs("ses_x")).toEqual(["__await-input", "ses_x", "question"]);
  expect(answeredQuestionHookArgs("ses_x")).toEqual(["__await-input", "ses_x", "question", "--clear"]);
});
