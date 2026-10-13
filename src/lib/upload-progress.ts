import { writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const AUDIO_UPLOAD_PROGRESS_EVENT = "audio-upload-progress";

export interface AudioUploadProgress {
  chunkIndex: number;
  totalChunks: number;
  message: string;
}

/** 백엔드 오디오 청크 업로드 진행 상황(마지막 이벤트 기준). */
export const audioUploadProgress = writable<AudioUploadProgress | null>(null);

let unlisten: UnlistenFn | null = null;
let pending: Promise<void> | null = null;
let subscribers = 0;

/**
 * Rust가 emit하는 오디오 업로드 진행 이벤트를 구독한다. 여러 번 호출해도
 * 리스너는 하나만 등록되고, 마지막 해제 시 함께 정리된다.
 */
export function subscribeToAudioUploadProgress(): () => void {
  subscribers += 1;
  if (!pending && !unlisten) {
    pending = listen<AudioUploadProgress>(AUDIO_UPLOAD_PROGRESS_EVENT, (event) => {
      const payload = event.payload;
      if (payload && typeof payload.message === "string") {
        audioUploadProgress.set(payload);
      }
    })
      .then((fn) => {
        pending = null;
        if (subscribers > 0) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // Tauri 이벤트 채널이 없는 환경(테스트/브라우저)에서는 무시한다.
        pending = null;
      });
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}
