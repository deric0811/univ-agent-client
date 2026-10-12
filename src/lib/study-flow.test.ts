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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/cache"),
  dirname: vi.fn(async (path: string) => path.replace(/[\\/][^\\/]*$/, "")),
  downloadDir: vi.fn(async () => "/downloads"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("./pdf-utils", () => ({
  mergePdfFiles: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const localId = "550e8400-e29b-41d4-a716-446655440000";
const meta = { project_id: "saved-project", title: "이전 강의", created_at: "2026-09-18T00:00:00Z", video_path: "/videos/previous.mp4" };
const markdown = "# 강의 요약\n\n[03:25] 핵심 개념\n\n[01:20:15] 마무리";
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

function button(text: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll("button")).find(
    (item) => item.textContent?.trim().includes(text) && !item.closest("[hidden]"),
  );
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
      case "extract_and_merge_audio_from_videos": return { audioPath: "/cache/merged_audio.wav", videoDurations: [3600] };
      case "upload_job": return JSON.stringify({ job_id: "job-1", status: "queued", waiting_count: 1 });
      case "get_job_status": return JSON.stringify({ job_id: "job-1", status: "completed", waiting_count: 0, error_message: null });
      case "get_job_result": return JSON.stringify({ job_id: "job-1", status: "completed", content: markdown, timestamps: [{ seconds: 205, label: "03:25" }] });
      case "save_study_project": return `/data/projects/${localId}`;
      case "cleanup_temp_files": return undefined;
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
  openMock.mockResolvedValueOnce(["/videos/lecture.mp4"]).mockResolvedValueOnce(["/notes/lecture.pdf"]);
  button("영상 파일 추가").click();
  await vi.waitFor(() => expect(target.textContent).toContain("lecture.mp4"));
  button("PDF 파일 추가").click();
  await vi.waitFor(() => expect(target.textContent).toContain("lecture.pdf"));
}

async function openMultiPartProject() {
  const multiMeta = {
    ...meta,
    project_id: "multi-project",
    title: "다중 영상 강의",
    video_path: "/videos/part1.mp4",
    video_paths: ["/videos/part1.mp4", "/videos/part2.mp4"],
    video_durations: [1200, 1500],
  };
  const original = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (...args) => {
    if (args[0] === "list_study_projects") return JSON.stringify([multiMeta]);
    if (args[0] === "load_study_project") {
      return JSON.stringify({
        meta: multiMeta,
        markdown: "# 요약\n\n[25:30] 두 번째 파트 핵심\n\n[00:10] 시작",
      });
    }
    return original(...args);
  });

  button("내 강의 서재").click();
  await vi.waitFor(() =>
    expect(target.querySelector(".project-main")?.textContent).toContain("다중 영상 강의"),
  );
  target.querySelector<HTMLButtonElement>(".project-main")!.click();
  await vi.waitFor(() =>
    expect(target.querySelector("#viewer-title")?.textContent).toBe("다중 영상 강의"),
  );
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
    expect(commands).toEqual(["extract_and_merge_audio_from_videos", "upload_job", "get_job_status", "get_job_result", "save_study_project", "cleanup_temp_files"]);
    const args = invokeMock.mock.calls.find(([command]) => command === "save_study_project")![1] as Record<string, string>;
    expect(JSON.parse(args.metadataJson)).toMatchObject({
      project_id: localId, title: title || "lecture.mp4", video_path: "/videos/lecture.mp4", pdf_path: "/notes/lecture.pdf",
    });
    expect(JSON.parse(args.metadataJson).video_durations).toEqual([3600]);
    expect(JSON.parse(args.metadataJson).timestamps).toEqual([{ seconds: 205, label: "03:25" }]);
    const cleanup = invokeMock.mock.calls.find(([command]) => command === "cleanup_temp_files")![1] as { paths: string[] };
    expect(cleanup.paths).toEqual(["/cache/merged_audio.wav"]);
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
    await vi.waitFor(() => expect(target.querySelector(".project-main")?.textContent).toContain(meta.title));
    target.querySelector<HTMLButtonElement>(".project-main")!.click();
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
    finishStatus(JSON.stringify({ job_id: "job-1", status: "completed", waiting_count: 0, error_message: null }));
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe("lecture.mp4"));
  });

  it("reports a rejected play promise without an unhandled error", async () => {
    button("내 강의 서재").click();
    await vi.waitFor(() => expect(target.querySelector(".project-main")).not.toBeNull());
    target.querySelector<HTMLButtonElement>(".project-main")!.click();
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

  it("stops polling on an expired token and surfaces the auth message", async () => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (...args) => {
      if (args[0] === "get_job_status") {
        throw "Study job query failed (HTTP 401 Unauthorized): token expired";
      }
      return original(...args);
    });

    await chooseFiles();
    button("분석 시작").click();
    await vi.waitFor(() => expect(target.textContent).toContain("인증 토큰이 만료되었습니다"));

    expect(target.textContent).toContain("인증이 필요합니다.");
    const retry = Array.from(target.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "다시 시도",
    );
    expect(retry).toBeUndefined();
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_job_status")).toHaveLength(1);
  });

  it("merges multiple PDFs and stores every source path for multi-part lectures", async () => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (...args) => {
      if (args[0] === "extract_and_merge_audio_from_videos") {
        const options = args[1] as { videoPaths: string[] };
        expect(options.videoPaths).toEqual(["/videos/part1.mp4", "/videos/part2.mp4"]);
        return { audioPath: "/cache/merged_audio.wav", videoDurations: [1200, 1500] };
      }
      return original(...args);
    });
    openMock
      .mockResolvedValueOnce(["/videos/part1.mp4", "/videos/part2.mp4"])
      .mockResolvedValueOnce(["/notes/one.pdf", "/notes/two.pdf"]);
    button("영상 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".media-list li")).toHaveLength(2));
    button("PDF 파일 추가").click();
    await vi.waitFor(() => expect(target.querySelectorAll(".media-list li")).toHaveLength(4));

    button("분석 시작").click();
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe("part1.mp4"));

    const args = invokeMock.mock.calls.find(([command]) => command === "save_study_project")![1] as Record<string, unknown>;
    const metadata = JSON.parse(args.metadataJson as string);
    expect(metadata.video_path).toBe("/videos/part1.mp4");
    expect(metadata.video_paths).toEqual(["/videos/part1.mp4", "/videos/part2.mp4"]);
    expect(metadata.video_durations).toEqual([1200, 1500]);
    expect(metadata.pdf_path).toBe(`/cache/merged_lecture_${localId}.pdf`);
    expect(metadata.pdf_paths).toEqual(["/notes/one.pdf", "/notes/two.pdf"]);
    const cleanup = invokeMock.mock.calls.find(([command]) => command === "cleanup_temp_files")![1] as { paths: string[] };
    expect(cleanup.paths).toEqual([
      "/cache/merged_audio.wav",
      `/cache/merged_lecture_${localId}.pdf`,
    ]);
  });

  it("maps a global timestamp to the correct part and local offset", async () => {
    await openMultiPartProject();
    const video = target.querySelector("video")!;
    expect(video.getAttribute("src")).toContain(encodeURIComponent("/videos/part1.mp4"));

    // 25분 30초 = 1530초 → Part 2의 330초(5분 30초)
    target.querySelector<HTMLButtonElement>('button[data-seconds="1530"]')!.click();
    await vi.waitFor(() => expect(convertFileSrc).toHaveBeenCalledWith("/videos/part2.mp4"));
    expect(video.getAttribute("src")).toContain(encodeURIComponent("/videos/part2.mp4"));

    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 1500 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.currentTime).toBe(330));
    expect(video.play).toHaveBeenCalled();
  });

  it("continues to the next part when the current video ends", async () => {
    await openMultiPartProject();
    const video = target.querySelector("video")!;
    expect(video.getAttribute("src")).toContain(encodeURIComponent("/videos/part1.mp4"));

    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 1200 });
    video.dispatchEvent(new Event("ended"));

    await vi.waitFor(() => expect(video.getAttribute("src")).toContain(encodeURIComponent("/videos/part2.mp4")));
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: 1500 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.currentTime).toBe(0));
    expect(video.play).toHaveBeenCalled();
  });

  it("suggests previous course names and binds a selected value", async () => {
    const courseMeta = { ...meta, project_id: "course-project", course: "클라우드 컴퓨팅" };
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (...args) => {
      if (args[0] === "list_study_projects") return JSON.stringify([courseMeta, meta]);
      return original(...args);
    });

    // 서재를 새로고침해 과목명 추천 목록을 채운다.
    button("내 강의 서재").click();
    await vi.waitFor(() =>
      expect(target.querySelectorAll<HTMLOptionElement>("#course-options option")).toHaveLength(1),
    );
    const option = target.querySelector<HTMLOptionElement>("#course-options option")!;
    expect(option.value).toBe("클라우드 컴퓨팅");
    button("새 강의 분석").click();
    flushSync();

    const courseInput = target.querySelector<HTMLInputElement>("#lecture-course")!;
    courseInput.value = option.value;
    courseInput.dispatchEvent(new Event("input", { bubbles: true }));

    await chooseFiles();
    button("분석 시작").click();
    await vi.waitFor(() => expect(target.querySelector("#viewer-title")?.textContent).toBe("lecture.mp4"));

    const args = invokeMock.mock.calls.find(([command]) => command === "save_study_project")![1] as Record<string, string>;
    expect(JSON.parse(args.metadataJson).course).toBe("클라우드 컴퓨팅");
  });
});
