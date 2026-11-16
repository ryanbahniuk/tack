import { expect, test } from "bun:test";
import type { TackConfig } from "../src/config/schema";
import { resolveTicketUrl } from "../src/projects/jira";

const withJira = (siteUrl: string) => ({ jira: { siteUrl } }) as unknown as TackConfig;

test("resolveTicketUrl prefers the stored url", () => {
  const row = { key: "ABC-1", url: "https://old.example/browse/ABC-1" };
  expect(resolveTicketUrl(withJira("https://new.example"), row)).toBe("https://old.example/browse/ABC-1");
  expect(resolveTicketUrl(null, row)).toBe("https://old.example/browse/ABC-1");
});

test("resolveTicketUrl derives a link from the configured siteUrl", () => {
  const row = { key: "MISSION-5340", url: null };
  expect(resolveTicketUrl(withJira("https://acme.atlassian.net"), row)).toBe("https://acme.atlassian.net/browse/MISSION-5340");
  expect(resolveTicketUrl(withJira("https://acme.atlassian.net/"), row)).toBe("https://acme.atlassian.net/browse/MISSION-5340");
});

test("resolveTicketUrl is null without a jira block or config", () => {
  const row = { key: "ABC-1", url: null };
  expect(resolveTicketUrl({} as TackConfig, row)).toBeNull();
  expect(resolveTicketUrl(null, row)).toBeNull();
  expect(resolveTicketUrl(undefined, row)).toBeNull();
});
