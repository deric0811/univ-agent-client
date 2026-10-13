// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import StudyProjectViewer from "./StudyProjectViewer.svelte";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const markdown = "# 제목\n\n## 소제목\n\n- 항목\n\n> 인용\n\n이동 [00:15:30] 그리고 [03:25]";
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

function mountViewer(documentOnly = false) {
  target = document.createElement("div");
  document.body.append(target);
  component = mount(StudyProjectViewer, {
    target,
    props: {
      onback: vi.fn(),
      project: {
        markdown,
        meta: {
          project_id: "p",
          title: "강의",
          created_at: "2026-09-18T00:00:00Z",
          video_path: documentOnly ? "" : "/videos/a.mp4",
          document_only: documentOnly,
          pdf_path: "/notes/a.pdf",
        },
      },
    },
  });
  flushSync();
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("StudyProjectViewer", () => {
  it("renders markdown as HTML with timestamp links", () => {
    mountViewer();
    expect(target.querySelector(".markdown h1")?.textContent).toBe("제목");
    expect(target.querySelector(".markdown blockquote")).not.toBeNull();
    expect(target.querySelectorAll(".markdown li")).toHaveLength(1);
    expect(target.querySelectorAll(".markdown .timestamp-link")).toHaveLength(2);
    expect(target.querySelector(".markdown")?.textContent).not.toContain("# 제목");
  });

  it("seeks and plays the video when a timestamp is clicked", async () => {
    mountViewer();
    const video = target.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { value: 4 });
    target.querySelector<HTMLButtonElement>('.timestamp-link[data-seconds="205"]')!.click();
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(video.currentTime).toBe(205);
  });

  it("resizes the split panes by dragging and clamps to 20-80%", () => {
    mountViewer();
    const split = target.querySelector<HTMLElement>(".split-view")!;
    split.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
    const handle = target.querySelector<HTMLElement>(".resizer-handle")!;
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(split.classList.contains("resizing")).toBe(true);

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
    flushSync();
    expect(handle.getAttribute("aria-valuenow")).toBe("30");
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 }));
    flushSync();
    expect(handle.getAttribute("aria-valuenow")).toBe("20");
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 990 }));
    flushSync();
    expect(handle.getAttribute("aria-valuenow")).toBe("80");

    window.dispatchEvent(new MouseEvent("mouseup"));
    flushSync();
    expect(split.classList.contains("resizing")).toBe(false);
  });

  it("opens the project folder with the current project id", async () => {
    mountViewer();
    invokeMock.mockResolvedValue(undefined);
    target.querySelector<HTMLButtonElement>("[data-testid='open-folder']")!.click();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_project_folder", { projectId: "p" }),
    );
  });

  it("shows an error when the folder cannot be opened", async () => {
    mountViewer();
    invokeMock.mockRejectedValue("없음");
    target.querySelector<HTMLButtonElement>("[data-testid='open-folder']")!.click();
    await vi.waitFor(() => expect(target.querySelector(".error")?.textContent).toContain("폴더를 열지 못했습니다"));
  });

  it("has no resizer in document-only mode", () => {
    mountViewer(true);
    expect(target.querySelector(".resizer-handle")).toBeNull();
  });
});
