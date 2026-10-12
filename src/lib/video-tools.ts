import { invoke } from "@tauri-apps/api/core";

/**
 * 실행 중인 영상 합치기(univ-ffmpeg) 사이드카 프로세스를 즉시 종료합니다.
 * 진행 중인 작업이 없어도 Rust 측에서 안전하게 성공(Ok)을 반환합니다.
 */
export async function cancelVideoMerge(): Promise<void> {
  try {
    await invoke("cancel_merge_video");
  } catch (error) {
    // Result::Err(String) rejects invoke with a string, not an Error instance.
    throw error instanceof Error ? error : new Error(String(error));
  }
}
