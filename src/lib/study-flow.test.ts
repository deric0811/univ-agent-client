// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Page from "../routes/+page.svelte";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const localId = "550e8400-e29b-41d4-a716-446655440000";
const meta = { project_id: "saved-project", title: "이전 강의", created_at: "2026-09-18T00:00:00Z", video_path: "/videos/previous.mp4" };
const markdown = "# 강의 요약\n\n[03:25] 핵심 개념\n\n[01:20:15] 마무리";
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

function button(text: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
  vi.mocked(convertFileSrc).mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("crypto", { randomUUID: () => localId });
  invokeMock.mockImplementation(async (command) => {
    switch (command) {
      case "is_authenticated": return true;
      case "list_study_projects": return JSON.stringify([meta]);
      case "load_study_project": return JSON.stringify({ meta, markdown });
      case "extract_audio_ffmpeg": return "/cache/audio.mp3";
      case "upload_job": return JSON.stringify({ job_id: "job-1", status: "PENDING", waiting_count: 1 });
      case "get_job_status": return JSON.stringify({ job_id: "job-1", status: "COMPLETED", waiting_count: 0, error_message: null });
      case "get_job_result": return JSON.stringify({ job_id: "job-1", status: "COMPLETED", content: markdown });
      case "save_study_project": return `/data/projects/${localId}`;
      default: throw new Error(`Unexpected command: ${command}`);
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
  vi.unstubAllGlobals();
});

async function chooseFiles() {
  openMock.mockResolvedValueOnce("/videos/lecture.mp4").mockResolvedValueOnce("/notes/lecture.pdf");
  button("영상 선택").click();
  await vi.waitFor(() => expect(target.textContent).toContain("/videos/lecture.mp4"));
  button("PDF 선택").click();
  await vi.waitFor(() => expect(target.textContent).toContain("/notes/lecture.pdf"));
}

describe("M2 → M3/M4", () => {
  it.each(["기말 대비 강의", ""])("saves a title and automatically opens the completed project (%s)", async (title) => {
    await chooseFiles();
    const input = target.querySelector<HTMLInputElement>("#lecture-title")!;
    input.value = title;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button("분석 시작").click();
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe(title || "lecture.mp4"));

    const commands = invokeMock.mock.calls
      .map(([command]) => command)
      .filter((command) => !["is_authenticated", "list_study_projects"].includes(command));
    expect(commands).toEqual(["extract_audio_ffmpeg", "upload_job", "get_job_status", "get_job_result", "save_study_project"]);
    const args = invokeMock.mock.calls.find(([command]) => command === "save_study_project")![1] as Record<string, string>;
    expect(JSON.parse(args.metadataJson)).toMatchObject({
      project_id: localId, title: title || "lecture.mp4", video_path: "/videos/lecture.mp4", pdf_path: "/notes/lecture.pdf",
    });
    expect(args.markdownContent).toBe(markdown);
    expect(convertFileSrc).toHaveBeenCalledWith("/videos/lecture.mp4");

    const video = target.querySelector("video")!;
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 6000 });
    target.querySelector<HTMLButtonElement>('button[data-seconds="205"]')!.click();
    await vi.waitFor(() => expect(video.currentTime).toBe(205));
    expect(video.play).toHaveBeenCalledOnce();
  });

  it("loads a saved lecture and seeks after delayed video metadata", async () => {
    button("내 강의 서재").click();
    await vi.waitFor(() => expect(target.querySelector(".project-entry")?.textContent).toContain(meta.title));
    target.querySelector<HTMLButtonElement>(".project-entry")!.click();
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe(meta.title));
    expect(invokeMock).toHaveBeenCalledWith("load_study_project", { projectId: meta.project_id });
    const video = target.querySelector("video")!;
    target.querySelector<HTMLButtonElement>('button[data-seconds="4815"]')!.click();
    expect(video.play).not.toHaveBeenCalled();
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 6000 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.currentTime).toBe(4815));
    expect(video.play).toHaveBeenCalledOnce();
    button("서재 목록으로").click();
    await vi.waitFor(() => expect(target.querySelector("video")).toBeNull());
    expect(video.pause).toHaveBeenCalled();
  });

  it("keeps analysis running while browsing the library and opens the new result", async () => {
    const original = invokeMock.getMockImplementation()!;
    let finishStatus!: (json: string) => void;
    invokeMock.mockImplementation(async (...args) => {
      if (args[0] === "get_job_status") return new Promise<string>((resolve) => { finishStatus = resolve; });
      return original(...args);
    });
    await chooseFiles();
    button("분석 시작").click();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_job_status", { jobId: "job-1" }));
    button("내 강의 서재").click();
    finishStatus(JSON.stringify({ job_id: "job-1", status: "COMPLETED", waiting_count: 0, error_message: null }));
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe("lecture.mp4"));
  });

  it("reports a rejected play promise without an unhandled error", async () => {
    button("내 강의 서재").click();
    await vi.waitFor(() => expect(target.querySelector(".project-entry")).not.toBeNull());
    target.querySelector<HTMLButtonElement>(".project-entry")!.click();
    await vi.waitFor(() => expect(target.querySelector("video")).not.toBeNull());
    const video = target.querySelector("video")!;
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 6000 });
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"));
    target.querySelector<HTMLButtonElement>('button[data-seconds="205"]')!.click();
    await vi.waitFor(() => expect(target.textContent).toContain("플레이어의 재생 버튼을 눌러 주세요"));
    expect(video.currentTime).toBe(205);
  });

  it("keeps results after a disk error and retries only local saving", async () => {
    const original = invokeMock.getMockImplementation()!;
    let saveCount = 0;
    invokeMock.mockImplementation(async (...args) => {
      if (args[0] === "save_study_project" && ++saveCount === 1) throw "Disk full";
      return original(...args);
    });
    await chooseFiles();
    button("분석 시작").click();
    await vi.waitFor(() => expect(target.textContent).toContain("Disk full"));
    expect(target.querySelector("video")).toBeNull();
    expect(target.querySelector("pre")?.textContent).toBe(markdown);
    button("로컬 저장 다시 시도").click();
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe("lecture.mp4"));
    expect(saveCount).toBe(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === "upload_job")).toHaveLength(1);
  });
});
