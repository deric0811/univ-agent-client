// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ToolsView from "./ToolsView.svelte";
import { videoMergeStore } from "../stores/videoMergeStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: vi.fn(async (path: string) => path.replace(/[\\/][^\\/]*$/, "")),
  downloadDir: vi.fn(async () => "/downloads"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

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

function mockMergeCommands() {
  invokeMock.mockImplementation((command) => {
    if (command === "cancel_merge_video") return Promise.resolve(undefined);
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
}

beforeEach(() => {
  videoMergeStore.reset();
  invokeMock.mockReset();
  openMock.mockReset();
  mockMergeCommands();
  target = document.createElement("div");
  document.body.append(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ToolsView store integration", () => {
  it("keeps the file list and merge progress across unmount and remount", async () => {
    let resolveMerge: (outputPath: string) => void = () => {};
    invokeMock.mockImplementation((command) => {
      if (command === "concat_videos_ffmpeg") {
        return new Promise<string>((resolve) => {
          resolveMerge = resolve;
        });
      }
      if (command === "cancel_merge_video") return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    openMock.mockResolvedValue(["/videos/a.mp4", "/videos/b.mp4"]);

    component = mount(ToolsView, { target });
    flushSync();
    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(2));
    expect(target.textContent).toContain("[합본] a.mp4");

    button("영상 하나로 합치기").click();
    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());

    await unmount(component);
    component = mount(ToolsView, { target });
    flushSync();

    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());
    expect(target.querySelectorAll(".video-list li")).toHaveLength(2);
    expect(target.textContent).toContain("초고속 스트림 병합 시도 중");
    expect(button("취소")).toBeTruthy();

    resolveMerge("/videos/[합본] a.mp4");
    await vi.waitFor(() =>
      expect(target.textContent).toContain("영상 합치기 완료: /videos/[합본] a.mp4"),
    );
    expect(target.querySelector(".spinner")).toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === "concat_videos_ffmpeg")).toHaveLength(1);
  });

  it("records a cancellation result in the store", async () => {
    let rejectMerge: (reason?: unknown) => void = () => {};
    invokeMock.mockImplementation((command) => {
      if (command === "concat_videos_ffmpeg") {
        return new Promise<string>((_, reject) => {
          rejectMerge = reject;
        });
      }
      if (command === "cancel_merge_video") return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    openMock.mockResolvedValue(["/videos/a.mp4"]);
    component = mount(ToolsView, { target });
    flushSync();

    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(1));
    button("영상 하나로 합치기").click();
    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());
    button("취소").click();
    await vi.waitFor(() => expect(target.textContent).toContain("취소 중..."));

    rejectMerge(new Error("영상 합치기 작업이 취소되었습니다."));

    await vi.waitFor(() =>
      expect(target.textContent).toContain("영상 합치기 작업을 취소했습니다."),
    );
    expect(target.querySelector(".spinner")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("cancel_merge_video");
  });

  it("keeps merging and reports an error when cancellation fails", async () => {
    let resolveMerge: (outputPath: string) => void = () => {};
    invokeMock.mockImplementation((command) => {
      if (command === "concat_videos_ffmpeg") {
        return new Promise<string>((resolve) => {
          resolveMerge = resolve;
        });
      }
      if (command === "cancel_merge_video") return Promise.reject("no running process");
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    openMock.mockResolvedValue(["/videos/a.mp4"]);
    component = mount(ToolsView, { target });
    flushSync();

    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(1));
    button("영상 하나로 합치기").click();
    await vi.waitFor(() => expect(target.querySelector(".spinner")).not.toBeNull());
    button("취소").click();

    await vi.waitFor(() => expect(target.textContent).toContain("취소 실패: no running process"));
    expect(target.querySelector(".spinner")).not.toBeNull();

    resolveMerge("/videos/out.mp4");
    await vi.waitFor(() => expect(target.textContent).toContain("영상 합치기 완료: /videos/out.mp4"));
  });

  it("clears the list and status only through the explicit reset action", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "concat_videos_ffmpeg") return Promise.resolve("/videos/[합본] a.mp4");
      if (command === "cancel_merge_video") return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    openMock.mockResolvedValue(["/videos/a.mp4"]);
    component = mount(ToolsView, { target });
    flushSync();

    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(1));
    button("영상 하나로 합치기").click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain("영상 합치기 완료: /videos/[합본] a.mp4"),
    );
    expect(target.querySelectorAll(".video-list li")).toHaveLength(1);

    button("초기화").click();

    await vi.waitFor(() => expect(target.querySelectorAll(".video-list li")).toHaveLength(0));
    expect(target.textContent).not.toContain("영상 합치기 완료");
    expect(target.textContent).toContain("합칠 영상을 추가해 주세요.");
  });
});