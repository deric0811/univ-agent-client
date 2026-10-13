import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioUploadProgress, subscribeToAudioUploadProgress } from "./upload-progress";

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

beforeEach(() => {
  listenMock.mockReset();
  audioUploadProgress.set(null);
});

describe("audio upload progress", () => {
  it("mirrors the Rust chunk event into the store with a single listener", async () => {
    const unlisten = vi.fn();
    let handler:
      | ((event: { payload: { chunkIndex: number; totalChunks: number; message: string } }) => void)
      | undefined;
    listenMock.mockImplementation(async (_event, callback) => {
      handler = callback;
      return unlisten;
    });

    const unsubscribe = subscribeToAudioUploadProgress();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    expect(listenMock.mock.calls[0][0]).toBe("audio-upload-progress");

    handler?.({
      payload: { chunkIndex: 1, totalChunks: 7, message: "오디오 전송 중... (2/7 조각)" },
    });
    expect(get(audioUploadProgress)?.message).toBe("오디오 전송 중... (2/7 조각)");
    expect(get(audioUploadProgress)?.totalChunks).toBe(7);

    // 중복 구독은 같은 리스너를 공유하고 마지막 해제 시 한 번만 정리한다.
    const second = subscribeToAudioUploadProgress();
    expect(listenMock).toHaveBeenCalledTimes(1);
    unsubscribe();
    second();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
