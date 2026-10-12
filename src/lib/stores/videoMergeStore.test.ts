import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVideoMergeStore,
  initialVideoMergeState,
  isMergeActive,
  subscribeToVideoMergeProgress,
  videoMergeStore,
  type VideoMergeFile,
  type VideoMergeStore,
} from "./videoMergeStore";

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const first: VideoMergeFile = { path: "/videos/a.mp4", name: "a.mp4" };
const second: VideoMergeFile = { path: "/videos/b.mp4", name: "b.mp4" };
const third: VideoMergeFile = { path: "/videos/c.mp4", name: "c.mp4" };

let store: VideoMergeStore;

function names(): string[] {
  return get(store).fileList.map((file) => file.name);
}

beforeEach(() => {
  store = createVideoMergeStore();
  videoMergeStore.reset();
  listenMock.mockReset();
});

describe("videoMergeStore", () => {
  it("starts from the documented idle state", () => {
    expect(get(store)).toEqual(initialVideoMergeState);
  });

  it("appends valid files and clears a previous result", () => {
    store.addFiles([first]);
    store.completeMerge("/out.mp4");
    expect(get(store).status).toBe("success");

    store.addFiles([second, { path: "   ", name: "invalid" }]);

    const state = get(store);
    expect(state.fileList).toEqual([first, second]);
    expect(state.status).toBe("idle");
    expect(state.statusMessage).toBe("");
    expect(state.completedPath).toBeNull();
  });

  it("reorders and removes files while staying inside bounds", () => {
    store.addFiles([first, second, third]);

    store.moveFile(0, 2);
    expect(names()).toEqual(["b.mp4", "c.mp4", "a.mp4"]);

    store.moveFile(-1, 0);
    store.moveFile(0, 99);
    expect(names()).toEqual(["b.mp4", "c.mp4", "a.mp4"]);

    store.removeFile(1);
    expect(names()).toEqual(["b.mp4", "a.mp4"]);

    store.removeFile(99);
    expect(names()).toEqual(["b.mp4", "a.mp4"]);
  });

  it("ignores file mutations while a merge is active", () => {
    store.addFiles([first]);
    store.beginMerge();

    store.addFiles([second]);
    store.removeFile(0);
    store.moveFile(0, 0);

    expect(isMergeActive(get(store).status)).toBe(true);
    expect(names()).toEqual(["a.mp4"]);
  });

  it("tracks output path and automatic/explicit mode", () => {
    store.setOutputPath("/downloads/[합본] a.mp4", { auto: true });
    expect(get(store)).toMatchObject({ outputPath: "/downloads/[합본] a.mp4", autoOutputPath: true });

    store.setOutputPath("/exports/final.mp4");
    expect(get(store)).toMatchObject({ outputPath: "/exports/final.mp4", autoOutputPath: false });
  });

  it("walks through merging, cancellation, success and failure", () => {
    store.addFiles([first, second]);
    store.setOutputPath("/out.mp4");

    store.beginMerge();
    expect(get(store)).toMatchObject({ status: "merging", completedPath: null });
    expect(get(store).statusMessage).toContain("초고속 스트림 병합");

    store.requestCancel();
    expect(get(store).status).toBe("cancelling");
    store.finishCancelled();
    expect(get(store)).toMatchObject({ status: "info", completedPath: null });
    expect(get(store).statusMessage).toContain("취소");

    store.beginMerge();
    store.completeMerge("/out.mp4");
    expect(get(store)).toMatchObject({ status: "success", completedPath: "/out.mp4" });
    expect(get(store).statusMessage).toContain("/out.mp4");

    store.beginMerge();
    store.failMerge("영상 합치기 실패: boom");
    expect(get(store)).toMatchObject({ status: "error", completedPath: null });
  });

  it("returns to the merging status when cancellation fails", () => {
    store.beginMerge();
    store.requestCancel();

    store.cancelFailed("취소 실패: no process");

    expect(get(store)).toMatchObject({ status: "merging", statusMessage: "취소 실패: no process" });
  });

  it("does not restart while a merge is already running", () => {
    store.beginMerge();
    store.completeMerge("/out.mp4");

    store.beginMerge();
    store.requestCancel();
    store.beginMerge();

    expect(get(store).status).toBe("cancelling");
  });

  it("resets to the initial state", () => {
    store.addFiles([first]);
    store.setOutputPath("/out.mp4");
    store.completeMerge("/out.mp4");

    store.reset();

    expect(get(store)).toEqual(initialVideoMergeState);
  });

  it("updates the progress message only while a merge is active", () => {
    store.setStatusMessage("대기 중");
    expect(get(store).statusMessage).toBe("");

    store.beginMerge();
    store.setStatusMessage("코덱/해상도 불일치 감지됨: 초고속 최적화 인코딩으로 전환 중...");
    expect(get(store).status).toBe("merging");
    expect(get(store).statusMessage).toContain("전환 중");
  });

  it("pipes backend progress events into the store with a single listener", async () => {
    const unlisten = vi.fn();
    let handler:
      | ((event: { payload: { stage: string; message: string; percent: number } }) => void)
      | undefined;
    listenMock.mockImplementation(async (_event, callback) => {
      handler = callback;
      return unlisten;
    });

    videoMergeStore.beginMerge();
    const unsubscribe = subscribeToVideoMergeProgress();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    expect(listenMock.mock.calls[0][0]).toBe("video-merge-progress");

    handler?.({
      payload: { stage: "fallback", message: "최적화 인코딩으로 전환 중...", percent: 0 },
    });
    expect(get(videoMergeStore).statusMessage).toBe("최적화 인코딩으로 전환 중...");
    expect(get(videoMergeStore).progressPercent).toBe(0);

    handler?.({
      payload: { stage: "encoding", message: "인코딩 병합 중... (42%)", percent: 42.5 },
    });
    expect(get(videoMergeStore).statusMessage).toBe("인코딩 병합 중... (42%)");
    expect(get(videoMergeStore).progressPercent).toBe(42.5);

    // 추가 구독은 같은 리스너를 공유하고, 마지막 해제 시 한 번만 정리한다.
    const secondUnsubscribe = subscribeToVideoMergeProgress();
    expect(listenMock).toHaveBeenCalledTimes(1);
    unsubscribe();
    secondUnsubscribe();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));

    // 중복 해제는 무시된다.
    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("resets and completes the progress percent with the merge lifecycle", () => {
    videoMergeStore.beginMerge();
    videoMergeStore.setProgressPercent(42.5);
    expect(get(videoMergeStore).progressPercent).toBe(42.5);

    // 실행 중이 아니면 이벤트로 들어온 진행률을 무시한다.
    videoMergeStore.finishCancelled();
    videoMergeStore.setProgressPercent(80);
    expect(get(videoMergeStore).progressPercent).toBe(0);

    videoMergeStore.beginMerge();
    videoMergeStore.setProgressPercent(999);
    expect(get(videoMergeStore).progressPercent).toBe(100);

    videoMergeStore.completeMerge("/out.mp4");
    expect(get(videoMergeStore).progressPercent).toBe(100);

    videoMergeStore.beginMerge();
    expect(get(videoMergeStore).progressPercent).toBe(0);

    videoMergeStore.reset();
    expect(get(videoMergeStore).progressPercent).toBe(0);
  });

  it("treats only merging and cancelling as active", () => {
    expect(isMergeActive("merging")).toBe(true);
    expect(isMergeActive("cancelling")).toBe(true);
    expect(isMergeActive("idle")).toBe(false);
    expect(isMergeActive("success")).toBe(false);
    expect(isMergeActive("error")).toBe(false);
    expect(isMergeActive("info")).toBe(false);
  });
});