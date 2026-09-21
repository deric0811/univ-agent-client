<script lang="ts">
  import { onDestroy } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { formatCreatedAt, type StudyProject } from "$lib/study-projects";
  import { summaryMarkdown } from "$lib/summary-markdown";

  let { project, onback }: { project: StudyProject; onback: () => void } = $props();
  let videoElement = $state<HTMLVideoElement>();
  let currentTime = $state(0);
  let pendingSeek = $state<number | null>(null);
  let playerError = $state("");
  let linkError = $state("");
  let disposed = false;
  let seekVersion = 0;
  const videoSrc = $derived(project.meta.video_path ? convertFileSrc(project.meta.video_path) : "");

  onDestroy(() => {
    disposed = true;
    videoElement?.pause();
  });

  async function seekTo(seconds: number) {
    const version = ++seekVersion;
    const video = videoElement;
    if (!video) {
      playerError = "이 강의에는 원본 비디오 경로가 없습니다.";
      return;
    }
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (video.error) {
      onVideoError();
      return;
    }
    playerError = "";
    if (video.readyState === 0) {
      pendingSeek = seconds;
      return;
    }
    pendingSeek = null;
    if (Number.isFinite(video.duration) && seconds > video.duration) {
      playerError = "선택한 타임스탬프가 영상 길이를 초과합니다.";
      return;
    }
    try {
      video.currentTime = seconds;
      currentTime = seconds;
      await video.play();
    } catch (error) {
      if (!disposed && version === seekVersion) {
        playerError = `재생하지 못했습니다. 플레이어의 재생 버튼을 눌러 주세요. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  function onMetadata() {
    if (pendingSeek !== null) void seekTo(pendingSeek);
  }

  function onVideoError() {
    pendingSeek = null;
    seekVersion += 1;
    playerError = "영상을 열 수 없습니다. 원본 파일이 이동·삭제되었거나 WebView가 코덱을 지원하지 않을 수 있습니다. Linux에서는 GStreamer 코덱 설치 상태도 확인해 주세요.";
  }

  async function openLink(url: string) {
    linkError = "";
    try {
      await openUrl(url);
    } catch (error) {
      if (!disposed) linkError = `링크 열기 실패: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
</script>

<section class="viewer" aria-labelledby="viewer-title">
  <div class="viewer-heading">
    <div>
      <h2 id="viewer-title">{project.meta.title}</h2>
      <p class="muted">{formatCreatedAt(project.meta.created_at)}</p>
    </div>
    <button type="button" class="back" onclick={onback}>서재 목록으로</button>
  </div>
  <div class="split-view">
    <section class="video-panel" aria-label="강의 비디오 플레이어">
      {#if videoSrc}
        <!-- svelte-ignore a11y_media_has_caption (원본 영상에 대응하는 자막 파일은 제공되지 않습니다.) -->
        <video
          controls
          playsinline
          preload="metadata"
          src={videoSrc}
          bind:this={videoElement}
          onloadedmetadata={onMetadata}
          ontimeupdate={() => { currentTime = videoElement?.currentTime ?? 0; }}
          onerror={onVideoError}
        >브라우저가 비디오 재생을 지원하지 않습니다.</video>
      {:else}
        <p class="notice">원본 비디오 경로가 없는 프로젝트입니다. 요약은 계속 읽을 수 있습니다.</p>
      {/if}
      <p class="path">{project.meta.video_path}</p>
      <p class="muted">오른쪽 요약의 시간 버튼을 누르면 해당 장면으로 이동합니다.</p>
      {#if pendingSeek !== null}<p role="status">영상 정보를 불러온 뒤 선택한 시점으로 이동합니다...</p>{/if}
      {#if playerError}<p class="error" role="alert">{playerError}</p>{/if}
    </section>
    <section class="summary-panel" aria-labelledby="summary-title">
      <h3 id="summary-title">학습 요약</h3>
      {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
      {#if !project.markdown.trim()}<p class="muted">저장된 요약 내용이 없습니다.</p>{/if}
      <div
        class="markdown"
        use:summaryMarkdown={{ markdown: project.markdown, currentTime, onTimestamp: seekTo, onLink: openLink }}
      ></div>
    </section>
  </div>
</section>

<style>
  .viewer { margin-top: 24px; }
  .viewer-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
  h2 { margin: 0; font-size: 1.5rem; overflow-wrap: anywhere; }
  h3 { margin: 0 0 16px; }
  .muted { color: #59647a; font-size: 0.85rem; }
  .back { flex-shrink: 0; padding: 10px 16px; border: 1px solid #cbd2e5; border-radius: 9px; background: white; color: #26396d; cursor: pointer; font: inherit; }
  .split-view { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  .video-panel { position: sticky; top: 20px; min-width: 0; }
  video { display: block; width: 100%; max-height: 65vh; background: #111827; border-radius: 12px; }
  .path { font-size: 0.8rem; color: #59647a; overflow-wrap: anywhere; }
  .summary-panel { min-width: 0; padding: 24px; border: 1px solid #dfe4ef; border-radius: 12px; background: white; max-height: calc(100vh - 220px); overflow: auto; }
  .markdown { line-height: 1.85; overflow-wrap: anywhere; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(pre) { padding: 16px; overflow-x: auto; background: #f3f5fa; border-radius: 8px; }
  .markdown :global(code) { font-family: ui-monospace, monospace; background: #f3f5fa; }
  .markdown :global(blockquote) { margin-left: 0; padding-left: 16px; border-left: 3px solid #aab6ee; color: #59647a; }
  .markdown :global(table) { display: block; overflow-x: auto; border-collapse: collapse; }
  .markdown :global(th), .markdown :global(td) { padding: 8px 12px; border: 1px solid #dfe4ef; }
  .markdown :global(a[href]) { color: #344eaf; }
  .markdown :global(button[data-seconds]) { display: inline; padding: 2px 7px; border: 1px solid #c2cef5; border-radius: 6px; background: #eef2ff; color: #304ba6; cursor: pointer; font: inherit; font-weight: 700; }
  .markdown :global(button[data-seconds]:hover), .markdown :global(button[aria-current="true"]) { background: #4255bf; color: white; }
  .markdown :global(button:focus-visible), .back:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  .error, .notice { padding: 14px; border-radius: 8px; background: #fff0f0; color: #a12525; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .split-view { grid-template-columns: 1fr; }
    .video-panel { position: static; }
    .summary-panel { max-height: none; padding: 18px; }
    .viewer-heading { align-items: start; flex-direction: column; }
  }
</style>
