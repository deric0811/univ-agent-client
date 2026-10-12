import { writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface VideoMergeFile {
  path: string;
  name: string;
}

export type VideoMergeStatus = "idle" | "merging" | "cancelling" | "success" | "error" | "info";

export interface VideoMergeState {
  fileList: VideoMergeFile[];
  status: VideoMergeStatus;
  statusMessage: string;
  outputPath: string;
  /** 출력 경로가 첫 영상 기준으로 자동 지정되었는지 여부 */
  autoOutputPath: boolean;
  /** 가장 최근에 성공한 합치기 결과 경로 */
  completedPath: string | null;
  /** 2단계 인코딩 진행률(0~100) */
  progressPercent: number;
}

export const initialVideoMergeState: VideoMergeState = {
  fileList: [],
  status: "idle",
  statusMessage: "",
  outputPath: "",
  autoOutputPath: true,
  completedPath: null,
  progressPercent: 0,
};

export function isMergeActive(status: VideoMergeStatus): boolean {
  return status === "merging" || status === "cancelling";
}

export interface VideoMergeStore extends Readable<VideoMergeState> {
  addFiles(files: VideoMergeFile[]): void;
  removeFile(index: number): void;
  moveFile(fromIndex: number, toIndex: number): void;
  setOutputPath(path: string, options?: { auto?: boolean }): void;
  beginMerge(): void;
  requestCancel(): void;
  cancelFailed(message: string): void;
  completeMerge(outputPath: string): void;
  failMerge(message: string): void;
  finishCancelled(): void;
  setStatusMessage(message: string): void;
  setProgressPercent(percent: number): void;
  reset(): void;
}

export function createVideoMergeStore(): VideoMergeStore {
  const store = writable<VideoMergeState>({ ...initialVideoMergeState, fileList: [] });
  const { update } = store;

  return {
    subscribe: store.subscribe,

    addFiles(files: VideoMergeFile[]): void {
      const added = files
        .filter((file) => file.path.trim().length > 0)
        .map((file) => ({ path: file.path, name: file.name }));
      if (added.length === 0) return;
      update((state) => {
        if (isMergeActive(state.status)) return state;
        return {
          ...state,
          fileList: [...state.fileList, ...added],
          status: "idle",
          statusMessage: "",
          completedPath: null,
        };
      });
    },

    removeFile(index: number): void {
      update((state) => {
        if (isMergeActive(state.status)) return state;
        if (index < 0 || index >= state.fileList.length) return state;
        return { ...state, fileList: state.fileList.filter((_, itemIndex) => itemIndex !== index) };
      });
    },

    moveFile(fromIndex: number, toIndex: number): void {
      update((state) => {
        if (isMergeActive(state.status)) return state;
        if (fromIndex === toIndex) return state;
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.fileList.length ||
          toIndex >= state.fileList.length
        ) {
          return state;
        }
        const fileList = [...state.fileList];
        const [moved] = fileList.splice(fromIndex, 1);
        fileList.splice(toIndex, 0, moved);
        return { ...state, fileList };
      });
    },

    setOutputPath(path: string, options?: { auto?: boolean }): void {
      update((state) => ({
        ...state,
        outputPath: path,
        autoOutputPath: options?.auto ?? false,
      }));
    },

    beginMerge(): void {
      update((state) => {
        if (isMergeActive(state.status)) return state;
        return {
          ...state,
          status: "merging",
          statusMessage: "초고속 스트림 병합 시도 중...",
          completedPath: null,
          progressPercent: 0,
        };
      });
    },

    requestCancel(): void {
      update((state) => {
        if (state.status !== "merging") return state;
        return { ...state, status: "cancelling", statusMessage: "영상 합치기를 취소하는 중입니다." };
      });
    },

    cancelFailed(message: string): void {
      update((state) => {
        if (state.status !== "cancelling") return state;
        return { ...state, status: "merging", statusMessage: message };
      });
    },

    completeMerge(outputPath: string): void {
      update((state) => ({
        ...state,
        status: "success",
        statusMessage: `영상 합치기 완료: ${outputPath}`,
        completedPath: outputPath,
        progressPercent: 100,
      }));
    },

    failMerge(message: string): void {
      update((state) => ({
        ...state,
        status: "error",
        statusMessage: message,
        completedPath: null,
        progressPercent: 0,
      }));
    },

    finishCancelled(): void {
      update((state) => ({
        ...state,
        status: "info",
        statusMessage: "영상 합치기 작업을 취소했습니다.",
        completedPath: null,
        progressPercent: 0,
      }));
    },

    setStatusMessage(message: string): void {
      update((state) =>
        isMergeActive(state.status) ? { ...state, statusMessage: message } : state,
      );
    },

    setProgressPercent(percent: number): void {
      const clamped = Math.min(100, Math.max(0, percent));
      update((state) =>
        isMergeActive(state.status) ? { ...state, progressPercent: clamped } : state,
      );
    },

    reset(): void {
      store.set({ ...initialVideoMergeState, fileList: [] });
    },
  };
}

export const videoMergeStore = createVideoMergeStore();

export const VIDEO_MERGE_PROGRESS_EVENT = "video-merge-progress";

export interface VideoMergeProgress {
  stage: "stream-copy" | "fallback" | "encoding";
  message: string;
  percent: number;
}

let progressUnlisten: UnlistenFn | null = null;
let progressSubscription: Promise<void> | null = null;
let progressSubscribers = 0;

/**
 * 백엔드 병합 진행 이벤트(1단계/2단계 전환)를 구독한다. 여러 컴포넌트가
 * 호출해도 리스너는 하나만 등록되고, 마지막 구독이 해제될 때 함께 정리된다.
 */
export function subscribeToVideoMergeProgress(): () => void {
  progressSubscribers += 1;
  if (!progressSubscription && !progressUnlisten) {
    progressSubscription = listen<VideoMergeProgress>(VIDEO_MERGE_PROGRESS_EVENT, (event) => {
      const payload = event.payload;
      const message = typeof payload?.message === "string" ? payload.message : "";
      if (message) videoMergeStore.setStatusMessage(message);
      if (payload?.stage === "encoding" && typeof payload.percent === "number") {
        videoMergeStore.setProgressPercent(payload.percent);
      }
    })
      .then((unlisten) => {
        progressSubscription = null;
        if (progressSubscribers > 0) progressUnlisten = unlisten;
        else unlisten();
      })
      .catch(() => {
        // Tauri 이벤트 채널을 사용할 수 없는 환경(테스트/브라우저)에서는 무시한다.
        progressSubscription = null;
      });
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    progressSubscribers = Math.max(0, progressSubscribers - 1);
    if (progressSubscribers === 0 && progressUnlisten) {
      progressUnlisten();
      progressUnlisten = null;
    }
  };
}