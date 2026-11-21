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
function client(...results: unknown[]) {
  const queue = [...results];
  const elicitInput = mock(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    elicitInput,
    getClientCapabilities: () => ({ elicitation: {} }),
  } as unknown as Pick<McpServer["server"], "getClientCapabilities" | "elicitInput">;
}
function incapableClient() {
  return {
    elicitInput: mock(async () => null),
    getClientCapabilities: () => ({}),
  } as unknown as Pick<McpServer["server"], "getClientCapabilities" | "elicitInput">;
}
const PROMPT = "Review the plan below. Accept to approve it, or Decline to say what to change.";
const TIMEOUT = { timeout: 24 * 60 * 60 * 1000 };
const FEEDBACK_FORM = {
  message: "What would you change in the plan?",
  requestedSchema: {
    type: "object",
    properties: {
      feedback: { type: "string", title: "What would you change?" },
    },
    required: ["feedback"],
  },
};

test("plan approval message shows the full plan", () => {
  expect(planApprovalMessage("\r\n  \r\nGoal sentence  \r\n\r\n  - tack: do X  \r\n- penny: do Y\r\n \r\n"))
    .toBe(`${PROMPT}\n\nGoal sentence\n\n  - tack: do X\n- penny: do Y`);
  expect(planApprovalMessage(" \n\t\n ")).toBe(PROMPT);
});

test("accept on the field-less decision form approves without a second form", async () => {
  const id = fixture();
  const c = client({ action: "accept", content: { feedback: "ignored" } });
  expect(await requestPlanApproval(c, id, "Build it")).toEqual({ approved: true, note: expect.any(String) });
  expect(c.elicitInput).toHaveBeenCalledTimes(1);
  expect(c.elicitInput).toHaveBeenCalledWith({
    message: `${PROMPT}\n\nBuild it`,
    requestedSchema: { type: "object", properties: {} },
  }, TIMEOUT);
  expect(getSession(id)?.plan_approved_at).toBeTruthy();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

test("decline opens a required feedback form whose answer keeps planning", async () => {
  const id = fixture();
  const c = client({ action: "decline" }, { action: "accept", content: { feedback: "  Change scope " } });
  expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({
    approved: false, keepPlanning: true, feedback: "Change scope", note: expect.stringContaining("Revise the plan"),
  });
  expect(c.elicitInput).toHaveBeenCalledTimes(2);
  expect(c.elicitInput).toHaveBeenLastCalledWith(FEEDBACK_FORM, TIMEOUT);
  expect(getSession(id)?.plan_approved_at).toBeNull();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

for (const [label, second] of [
  ["blank accept", { action: "accept", content: { feedback: "   " } }],
  ["accept without content", { action: "accept" }],
  ["decline", { action: "decline" }],
  ["cancel", { action: "cancel" }],
  ["error", new Error("unavailable")],
] as const) {
  test(`decline then ${label} on the feedback form tells the supervisor to ask in chat`, async () => {
    const id = fixture();
    const c = client({ action: "decline" }, second);
    const result = await requestPlanApproval(c, id, "Plan");
    expect(result).toMatchObject({ approved: false, action: "decline" });
    expect(result).not.toHaveProperty("keepPlanning");
    const { note } = result as { note: string };
    expect(note).toContain("declined the plan but gave no changes");
    expect(note).toContain("Ask them in chat");
    expect(note).toContain("Do NOT say they left no feedback");
    expect(c.elicitInput).toHaveBeenCalledTimes(2);
    expect(getSession(id)?.plan_approved_at).toBeNull();
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

test("cancel on the decision form skips the feedback form and asks in chat", async () => {
  const id = fixture();
  const c = client({ action: "cancel" });
  const result = await requestPlanApproval(c, id, "Plan");
  expect(result).toMatchObject({ approved: false, action: "cancel" });
  expect(result).not.toHaveProperty("keepPlanning");
  const { note } = result as { note: string };
  expect(note).toContain("dismissed the approval form without deciding");
  expect(note).toContain("Ask them in chat whether they want changes");
  expect(note).toContain("Do NOT say they left no feedback");
  expect(c.elicitInput).toHaveBeenCalledTimes(1);
  expect(getSession(id)?.plan_approved_at).toBeNull();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

test("missing capability and elicitation errors preserve the awaiting marker", async () => {
  for (const c of [incapableClient(), client(new Error("unavailable"))]) {
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
  const c = client();
  expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({ approved: true });
  expect(c.elicitInput).not.toHaveBeenCalled();
  expect(getSession(id)?.awaiting_input_at).toBeNull();
});

for (const outcome of ["cancel", "decline", "error"] as const) {
  test(`out-of-band approval during the decision form wins over ${outcome}`, async () => {
    const id = fixture();
    const c = client();
    c.elicitInput = mock(async () => {
      approveSessionPlan(id);
      if (outcome === "error") throw new Error("unavailable");
      return { action: outcome };
    });
    expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({ approved: true });
    expect(c.elicitInput).toHaveBeenCalledTimes(1);
    expect(getSession(id)?.awaiting_input_at).toBeNull();
  });
}

for (const outcome of ["feedback", "decline", "error"] as const) {
  test(`out-of-band approval during the feedback form wins over ${outcome}`, async () => {
    const id = fixture();
    const c = client();
    c.elicitInput = mock(async (params: { requestedSchema: { properties: object } }) => {
      if (!Object.keys(params.requestedSchema.properties).length) return { action: "decline" as const };
      approveSessionPlan(id);
      if (outcome === "error") throw new Error("unavailable");
      if (outcome === "decline") return { action: "decline" as const };
      return { action: "accept" as const, content: { feedback: "revise" } };
    });
    expect(await requestPlanApproval(c, id, "Plan")).toMatchObject({ approved: true });
    expect(c.elicitInput).toHaveBeenCalledTimes(2);
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
