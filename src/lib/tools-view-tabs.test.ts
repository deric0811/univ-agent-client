// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Page from "../routes/+page.svelte";
import { videoMergeStore } from "./stores/videoMergeStore";

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/cache"),
  dirname: vi.fn(async (path: string) => path.replace(/[\\/][^\\/]*$/, "")),
  downloadDir: vi.fn(async () => "/downloads"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

function button(text: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll("button")).find((item) =>
    item.textContent?.trim().includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

function toolsPanel(): HTMLElement {
  const panel = target.querySelector("#tools-heading")?.closest(".tab-panel");
  if (!(panel instanceof HTMLElement)) throw new Error("Tools tab panel not found");
  return panel;
}

beforeEach(() => {
  videoMergeStore.reset();
  invokeMock.mockReset();
  openMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
  vi.mocked(convertFileSrc).mockClear();
  invokeMock.mockImplementation(async (command) => {
    switch (command) {
      case "is_authenticated":
        return true;
      case "list_study_projects":
        return JSON.stringify([]);
      case "concat_videos_ffmpeg":
        return new Promise<string>(() => {});
      case "cancel_merge_video":
        return undefined;
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

describe("main tab persistence", () => {
  it("keeps spinner, progress text and cancel button while visiting other tabs", async () => {
    await vi.waitFor(() => expect(target.querySelector("#tools-heading")).not.toBeNull());
    expect(target.querySelectorAll(".tab-panel")).toHaveLength(3);

    openMock.mockResolvedValueOnce(["/videos/a.mp4", "/videos/b.mp4"]);
    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(2));
    expect(target.textContent).toContain("[합본] a.mp4");

    button("영상 하나로 합치기").click();
    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());

    button("내 강의 서재").click();
    flushSync();
    expect(toolsPanel().hidden).toBe(true);
    expect(toolsPanel().getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelector(".spinner")).not.toBeNull();
    expect(target.textContent).toContain("초고속 스트림 병합 시도 중");
    expect(button("취소")).toBeTruthy();

    button("새 강의 분석").click();
    flushSync();
    expect(toolsPanel().hidden).toBe(true);
    expect(target.querySelector(".spinner")).not.toBeNull();

    button("영상 합치기").click();
    flushSync();
    expect(toolsPanel().hidden).toBe(false);
    expect(toolsPanel().getAttribute("aria-hidden")).toBe("false");
    expect(target.querySelector(".spinner")).not.toBeNull();
    expect(button("취소")).toBeTruthy();
    expect(target.textContent).toContain("초고속 스트림 병합 시도 중");
  });

  it("reflects backend fallback progress in the store and UI", async () => {
    await vi.waitFor(() => expect(target.querySelector("#tools-heading")).not.toBeNull());
    const handler = listenMock.mock.calls[0]?.[1] as
      | ((event: { payload: { stage: string; message: string; percent: number } }) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");

    openMock.mockResolvedValueOnce(["/videos/a.mp4"]);
    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(1));
    button("영상 하나로 합치기").click();
    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());

    handler?.({
      payload: {
        stage: "fallback",
        message: "코덱/해상도 불일치 감지됨: 초고속 최적화 인코딩으로 전환 중...",
        percent: 0,
      },
    });
    flushSync();

    expect(get(videoMergeStore).statusMessage).toBe(
      "코덱/해상도 불일치 감지됨: 초고속 최적화 인코딩으로 전환 중...",
    );
    expect(target.textContent).toContain("코덱/해상도 불일치 감지됨");

    handler?.({
      payload: { stage: "encoding", message: "인코딩 병합 중... (42%)", percent: 42.4 },
    });
    flushSync();

    expect(get(videoMergeStore).progressPercent).toBe(42.4);
    expect(target.textContent).toContain("인코딩 병합 중... (42%)");
    const progressbar = target.querySelector('[role="progressbar"]');
    expect(progressbar?.getAttribute("aria-valuenow")).toBe("42");
    expect(target.querySelector(".progress-value")?.textContent).toBe("42%");
  });

  it("keeps Alt tab shortcuts and zoom controls working", async () => {
    await vi.waitFor(() => expect(target.querySelector("#tools-heading")).not.toBeNull());
    expect(toolsPanel().hidden).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit3", altKey: true }));
    flushSync();
    expect(toolsPanel().hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", altKey: true }));
    flushSync();
    expect(toolsPanel().hidden).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", altKey: true }));
    flushSync();
    expect(toolsPanel().hidden).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Equal", ctrlKey: true }));
    flushSync();
    expect(target.querySelector(".zoom-toast")?.textContent).toBe("110%");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Minus", ctrlKey: true }));
    flushSync();
    expect(target.querySelector(".zoom-toast")?.textContent).toBe("100%");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit0", ctrlKey: true }));
    flushSync();
    expect(target.querySelector(".zoom-toast")?.textContent).toBe("100%");
  });
});