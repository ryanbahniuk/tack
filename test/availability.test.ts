import { beforeEach, describe, expect, test } from "bun:test";
import type { Model, TackConfig } from "../src/config/schema";
import {
  checkModelOffered,
  clearModelAvailabilityCache,
  type ModelLister,
} from "../src/runtimes/availability";
import { MODEL_NOT_FOUND_HINT, errorMessage } from "../src/runtimes/codex";

const SOL: Model = {
  key: "gpt-5.6-sol",
  provider: "openai",
  name: "GPT-5.6 Sol",
  version: "5.6",
  runtime: "codex",
  id: "gpt-5.6-sol",
};

// The check only reads the config to resolve a binary, which the stubbed lister skips.
const config = {} as TackConfig;

/** A lister stub that records how often the live lookup ran. */
function lister(ids: string[] | null): ModelLister & { calls: number } {
  const fn = (() => {
    fn.calls++;
    return ids;
  }) as ModelLister & { calls: number };
  fn.calls = 0;
  return fn;
}

beforeEach(() => clearModelAvailabilityCache());

describe("checkModelOffered", () => {
  test("ok when the login offers the model's id", () => {
    expect(checkModelOffered(config, SOL, { lister: lister(["gpt-6.1-sol", "gpt-5.6-sol"]) })).toEqual({ ok: true });
  });

  test("not offered names the key, runtime:id and the sync hint", () => {
    const r = checkModelOffered(config, SOL, { lister: lister(["gpt-6.1-sol"]) });
    expect(r.ok).toBe(false);
    const message = (r as { message: string }).message;
    expect(message).toBe(
      'model "gpt-5.6-sol" (codex:gpt-5.6-sol) is not offered to this codex login — run `tack models sync` to prune it and re-pin roles',
    );
  });

  test("a role pin is named in the message", () => {
    const r = checkModelOffered(config, SOL, { role: "agent", lister: lister(["gpt-6.1-sol"]) });
    expect(r.ok).toBe(false);
    const message = (r as { message: string }).message;
    expect(message.startsWith('role "agent" is pinned to model "gpt-5.6-sol" (codex:gpt-5.6-sol)')).toBe(true);
    expect(message).toContain("tack models sync");
  });

  test("an unknown offering (null) never blocks", () => {
    expect(checkModelOffered(config, SOL, { lister: lister(null) })).toEqual({ ok: "unknown" });
  });

  test("a throwing lookup is unknown, not a failure", () => {
    const boom: ModelLister = () => {
      throw new Error("codex not installed");
    };
    expect(checkModelOffered(config, SOL, { lister: boom })).toEqual({ ok: "unknown" });
  });

  test("the live lookup runs once per runtime per process", () => {
    const fn = lister(["gpt-6.1-sol"]);
    checkModelOffered(config, SOL, { lister: fn });
    checkModelOffered(config, { ...SOL, key: "gpt-6.1-sol", id: "gpt-6.1-sol" }, { lister: fn });
    expect(fn.calls).toBe(1);
  });
});

describe("codex errorMessage", () => {
  test("appends the sync hint to a model_not_found API body", () => {
    const body = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    expect(errorMessage(body)).toBe(
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." + MODEL_NOT_FOUND_HINT,
    );
  });

  test("appends the hint when model_not_found is only in the plain text", () => {
    const msg = "400 model_not_found: The 'gpt-5.6-sol' model is not supported";
    expect(errorMessage(msg)).toBe(msg + MODEL_NOT_FOUND_HINT);
    expect(MODEL_NOT_FOUND_HINT).toContain("tack models sync");
  });

  test("leaves other errors alone", () => {
    expect(errorMessage('{"error":{"message":"rate limited"}}')).toBe("rate limited");
    expect(errorMessage("something broke")).toBe("something broke");
  });
});
