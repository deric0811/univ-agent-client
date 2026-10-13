// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHOOL_DISPLAY_NAME,
  clearSessionProfile,
  loadSessionProfile,
  saveSessionProfile,
} from "./auth-store";

beforeEach(() => localStorage.clear());

describe("auth-store", () => {
  it("persists and restores the school display name", () => {
    expect(loadSessionProfile()).toBeNull();
    saveSessionProfile({ displayName: SCHOOL_DISPLAY_NAME, is_byok: true });
    expect(loadSessionProfile()).toEqual({ displayName: "고려대 학우님", is_byok: true });
    clearSessionProfile();
    expect(loadSessionProfile()).toBeNull();
  });

  it("ignores corrupt data", () => {
    localStorage.setItem("univ-agent.session-profile", "{oops");
    expect(loadSessionProfile()).toBeNull();
  });
});
