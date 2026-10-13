// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import Page from "../routes/+page.svelte";

const { onDragDropMock } = vi.hoisted(() => ({ onDragDropMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: onDragDropMock }),
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
let dropHandler:
  | ((event: { payload: { type: string; paths?: string[] } }) => void)
  | undefined;

function listNames(): (string | null)[] {
  return Array.from(target.querySelectorAll(".media-list li .name")).map(
    (element) => element.textContent,
  );
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  dropHandler = undefined;
  invokeMock.mockReset();
  onDragDropMock.mockReset();
  onDragDropMock.mockImplementation(async (handler) => {
    dropHandler = handler;
    return () => {};
  });
  invokeMock.mockImplementation(async (command) => {
    switch (command) {
      case "is_authenticated":
        return true;
      case "list_study_projects":
        return JSON.stringify([]);
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
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("PPT/PPTX external drop guard", () => {
  it("rejects a dropped pptx, warns, and registers only the pdf", async () => {
    await vi.waitFor(() => expect(dropHandler).toBeDefined());

    dropHandler?.({
      payload: { type: "drop", paths: ["/notes/slides.pptx", "/notes/lecture.pdf"] },
    });
    flushSync();

    expect(target.textContent).toContain("PPT/PPTX 파일은 직접 등록할 수 없습니다");
    expect(listNames()).toContain("lecture.pdf");
    expect(listNames()).not.toContain("slides.pptx");
    expect(target.querySelector(".ppt-toast")).not.toBeNull();
  });

  it("still registers dropped video files without a warning", async () => {
    await vi.waitFor(() => expect(dropHandler).toBeDefined());

    dropHandler?.({ payload: { type: "drop", paths: ["/videos/part1.mp4"] } });
    flushSync();

    expect(listNames()).toContain("part1.mp4");
    expect(target.querySelector(".ppt-toast")).toBeNull();
  });

  it("dismisses the warning toast", async () => {
    await vi.waitFor(() => expect(dropHandler).toBeDefined());
    dropHandler?.({ payload: { type: "drop", paths: ["/notes/deck.ppt"] } });
    flushSync();

    target.querySelector<HTMLButtonElement>(".ppt-toast button")!.click();
    flushSync();
    expect(target.querySelector(".ppt-toast")).toBeNull();
  });
});
