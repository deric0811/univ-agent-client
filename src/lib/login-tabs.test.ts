// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import Page from "../routes/+page.svelte";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/cache"),
  dirname: vi.fn(async (path: string) => path),
  downloadDir: vi.fn(async () => "/downloads"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));

const invokeMock = vi.mocked(invoke);
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

function button(text: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll("button")).find((item) =>
    item.textContent?.trim().includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command) => {
    switch (command) {
      case "is_authenticated":
        return false;
      case "list_study_projects":
        return JSON.stringify([]);
      case "login_school_key":
        return "고려대 학우님";
      case "login":
        return "h2omol";
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  target = document.createElement("div");
  document.body.append(target);
  component = mount(Page, { target });
  flushSync();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("login tabs", () => {
  it("defaults to the school AI key tab and switches modes", async () => {
    await vi.waitFor(() => expect(target.querySelector("#school-api-key")).not.toBeNull());
    expect(target.querySelector("#username")).toBeNull();
    expect(target.textContent).toContain("고려대 세종 BAZE 포털");
    expect(target.textContent).toContain("고려대 세종 학생 전용 무료 AI 로그인");
    expect(target.textContent).toContain("kusllm.korea.ac.kr");
    expect(target.textContent).toContain("3,000 크레딧");
    expect(target.querySelector(".key-warning")?.textContent).toBe(
      "API 키는 생성 시 단 1회만 표시되므로 안전한 곳에 복사해 두세요.",
    );

    button("기존 계정 로그인").click();
    flushSync();
    expect(target.querySelector("#username")).not.toBeNull();
    expect(target.querySelector("#password")).not.toBeNull();
    expect(target.querySelector("#school-api-key")).toBeNull();

    button("학교 AI 키 로그인").click();
    flushSync();
    expect(target.querySelector("#school-api-key")).not.toBeNull();
  });

  it("toggles the school key visibility", async () => {
    await vi.waitFor(() => expect(target.querySelector("#school-api-key")).not.toBeNull());
    const input = target.querySelector<HTMLInputElement>("#school-api-key")!;
    expect(input.type).toBe("password");

    button("표시").click();
    flushSync();
    expect(input.type).toBe("text");

    button("숨기기").click();
    flushSync();
    expect(input.type).toBe("password");
  });

  it("submits the school key login and enters the workspace", async () => {
    await vi.waitFor(() => expect(target.querySelector("#school-api-key")).not.toBeNull());
    const input = target.querySelector<HTMLInputElement>("#school-api-key")!;
    input.value = "my-school-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    button("학교 AI 키로 로그인").click();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("login_school_key", {
        schoolApiKey: "my-school-key",
      }),
    );
    await vi.waitFor(() => expect(target.querySelector(".sidebar")).not.toBeNull());
    expect(target.querySelector(".user-name")?.textContent?.trim()).toBe("고려대 학우님");
  });

  it("shows a clear message instead of loading forever when the server is down", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "is_authenticated") return false;
      throw "서버가 점검 중이거나 꺼져 있습니다. 개발자에게 문의하세요.";
    });
    await vi.waitFor(() => expect(target.querySelector("#school-api-key")).not.toBeNull());
    const input = target.querySelector<HTMLInputElement>("#school-api-key")!;
    input.value = "key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button("학교 AI 키로 로그인").click();
    await vi.waitFor(() =>
      expect(target.querySelector(".error")?.textContent).toContain("서버가 점검 중이거나 꺼져 있습니다"),
    );
    expect(button("학교 AI 키로 로그인").disabled).toBe(false);
  });

  it("restores the school display name after a session restore", async () => {
    await unmount(component!);
    document.body.replaceChildren();
    localStorage.setItem(
      "univ-agent.session-profile",
      JSON.stringify({ displayName: "고려대 학우님", is_byok: true }),
    );
    invokeMock.mockImplementation(async (command) => {
      if (command === "is_authenticated") return true;
      if (command === "list_study_projects") return "[]";
      throw new Error("offline");
    });
    target = document.createElement("div");
    document.body.append(target);
    component = mount(Page, { target });
    await vi.waitFor(() =>
      expect(target.querySelector(".user-name")?.textContent?.trim()).toBe("고려대 학우님"),
    );
  });
});
