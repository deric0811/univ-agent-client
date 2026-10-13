<script lang="ts">
  import { onDestroy } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { formatCreatedAt, openProjectFolder, type StudyProject } from "$lib/study-projects";
  import { analysisModeLabel } from "$lib/models-store";
  import { summaryMarkdown } from "$lib/summary-markdown";
  import { resolveVideoSegment, type VideoSegment } from "$lib/video-playback";

  let { project, onback }: { project: StudyProject; onback: () => void } = $props();
  let videoElement = $state<HTMLVideoElement>();
  let currentTime = $state(0);
  let pendingSeek = $state<number | null>(null);
  let activeVideoIndex = $state(0);
  let playerError = $state("");
  let linkError = $state("");
  let folderError = $state("");

  /** 현재 강의의 로컬 저장 폴더를 OS 파일 탐색기로 연다. */
  async function openFolder() {
    folderError = "";
    try {
      await openProjectFolder(project.meta.project_id);
    } catch (error) {
      if (!disposed) folderError = `폴더를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let disposed = false;
  let seekVersion = 0;

  const videoPaths = $derived.by(() => {
    const paths = project.meta.video_paths;
    if (Array.isArray(paths) && paths.length > 0) {
      return paths.filter(
        (path): path is string => typeof path === "string" && path.trim().length > 0,
      );
    }
    return project.meta.video_path ? [project.meta.video_path] : [];
  });
  const videoDurations = $derived.by(() =>
    Array.isArray(project.meta.video_durations)
      ? project.meta.video_durations.filter((value): value is number => typeof value === "number")
      : [],
  );
  const hasSegmentDurations = $derived(
    videoPaths.length > 0 &&
      videoDurations.length >= videoPaths.length &&
      videoPaths.every((_, index) => videoDurations[index] > 0),
  );
  const activeVideoPath = $derived(videoPaths[activeVideoIndex] ?? "");
  const videoSrc = $derived(activeVideoPath ? convertFileSrc(activeVideoPath) : "");
  // 요약 하이라이트용 통합 재생 시각. 단일 영상이면 로컬 시각과 같다.
  const globalCurrentTime = $derived.by(() => {
    if (!hasSegmentDurations || activeVideoIndex === 0) return currentTime;
    let offset = 0;
    for (let index = 0; index < activeVideoIndex; index += 1) {
      offset += videoDurations[index];
    }
    return offset + currentTime;
  });
  const isDocumentOnly = $derived(videoPaths.length === 0);
  const pdfPaths = $derived.by(() => {
    const paths = project.meta.pdf_paths;
    const list = Array.isArray(paths)
      ? paths.filter(
          (path): path is string => typeof path === "string" && path.trim().length > 0,
        )
      : [];
    if (list.length > 0) return list;
    return project.meta.pdf_path ? [project.meta.pdf_path] : [];
  });
  const activePdfPath = $derived(pdfPaths[0] ?? "");
  const pdfSrc = $derived(activePdfPath ? convertFileSrc(activePdfPath) : "");

  onDestroy(() => {
    disposed = true;
    stopResize();
    videoElement?.pause();
  });

  /** 현재 활성 영상 안에서 localSeconds 위치로 이동해 재생한다. */
  async function seekLocal(seconds: number) {
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

  const MIN_RATIO = 20;
  const MAX_RATIO = 80;
  let splitRatio = $state(50);
  let splitView: HTMLElement | undefined = $state();
  let resizing = $state(false);

  function clampRatio(value: number): number {
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
  }

  function onResizeMove(event: MouseEvent) {
    if (!splitView) return;
    const rect = splitView.getBoundingClientRect();
    if (rect.width <= 0) return;
    splitRatio = clampRatio(((event.clientX - rect.left) / rect.width) * 100);
  }

  function stopResize() {
    resizing = false;
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", stopResize);
  }

  function startResize(event: MouseEvent) {
    event.preventDefault();
    resizing = true;
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", stopResize);
  }

  function onResizeKey(event: KeyboardEvent) {
    if (event.key === "ArrowLeft") splitRatio = clampRatio(splitRatio - 2);
    else if (event.key === "ArrowRight") splitRatio = clampRatio(splitRatio + 2);
    else return;
    event.preventDefault();
  }

  /** 통합 타임스탬프를 올바른 영상과 로컬 시점으로 변환해 재생한다. */
  async function seekTo(targetSeconds: number) {
    // 문서 전용 강의에는 이동할 영상이 없다.
    if (isDocumentOnly) return;
    if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return;
    if (videoPaths.length === 0) {
      playerError = "이 강의에는 원본 비디오 경로가 없습니다.";
      return;
    }
    if (!hasSegmentDurations || videoPaths.length === 1) {
      await seekLocal(targetSeconds);
      return;
    }
    let segment: VideoSegment;
    try {
      segment = resolveVideoSegment(targetSeconds, videoPaths, videoDurations);
    } catch (error) {
      if (!disposed) {
        playerError = `타임스탬프를 영상으로 변환하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      }
      return;
    }
    if (segment.videoIndex !== activeVideoIndex) {
      // src 교체 후 loadedmetadata에서 pendingSeek 위치로 이동해 재생한다.
      playerError = "";
      pendingSeek = segment.localSeconds;
      activeVideoIndex = segment.videoIndex;
      return;
    }
    await seekLocal(segment.localSeconds);
  }

  function onMetadata() {
    if (pendingSeek !== null) void seekLocal(pendingSeek);
  }

  function onEnded() {
    // 다음 파트가 있으면 0초부터 이어서 재생한다.
    if (activeVideoIndex + 1 >= videoPaths.length) return;
    pendingSeek = 0;
    activeVideoIndex += 1;
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
  const metaBadge = $derived.by(() => {
    const parts = [
      analysisModeLabel(project.meta.analysis_mode),
      typeof project.meta.model === "string" && project.meta.model ? project.meta.model : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? `[${parts.join(" | ")}]` : "";
  });
</script>

<section class="viewer" aria-labelledby="viewer-title">
  <div class="viewer-heading">
    <div>
      <div class="title-row">
        <h2 id="viewer-title">{project.meta.title}</h2>
        {#if isDocumentOnly}<span class="badge">문서 전용 강의 (영상 없음)</span>{/if}
        {#if metaBadge}<span class="badge meta-badge" data-testid="meta-badge">{metaBadge}</span>{/if}
      </div>
      <p class="muted">{formatCreatedAt(project.meta.created_at)}</p>
    </div>
    <div class="heading-actions">
      <button type="button" class="back" data-testid="open-folder" onclick={openFolder}>폴더 열기</button>
      <button type="button" class="back" onclick={onback}>서재 목록으로</button>
    </div>
  </div>
  {#if folderError}<p class="error" role="alert">{folderError}</p>{/if}
  <div
    class="split-view"
    class:document-only={isDocumentOnly}
    class:resizing
    bind:this={splitView}
    style:grid-template-columns={isDocumentOnly ? undefined : `minmax(0, ${splitRatio}fr) 12px minmax(0, ${100 - splitRatio}fr)`}
  >
    <section class="video-panel" aria-label={isDocumentOnly ? "강의자료 PDF 뷰어" : "강의 비디오 플레이어"}>
      {#if isDocumentOnly}
        {#if pdfSrc}
          <iframe class="pdf-frame" src={pdfSrc} title="강의자료 PDF"></iframe>
          <p class="path">{activePdfPath}</p>
          <p class="muted">강의자료 원문은 왼쪽에서, 요약 노트는 오른쪽에서 확인할 수 있습니다.</p>
        {:else}
          <p class="notice">표시할 강의자료가 없습니다. 요약은 계속 읽을 수 있습니다.</p>
        {/if}
      {:else}
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
            onended={onEnded}
            onerror={onVideoError}
          >브라우저가 비디오 재생을 지원하지 않습니다.</video>
        {:else}
          <p class="notice">원본 비디오 경로가 없는 프로젝트입니다. 요약은 계속 읽을 수 있습니다.</p>
        {/if}
        <p class="path">{activeVideoPath}</p>
        {#if videoPaths.length > 1}
          <p class="muted">Part {activeVideoIndex + 1} / {videoPaths.length} · 다음 파트로 자동 이어 재생됩니다.</p>
        {/if}
        <p class="muted">오른쪽 요약의 시간 버튼을 누르면 해당 장면으로 이동합니다.</p>
        {#if pendingSeek !== null}<p role="status">영상 정보를 불러온 뒤 선택한 시점으로 이동합니다...</p>{/if}
        {#if playerError}<p class="error" role="alert">{playerError}</p>{/if}
      {/if}
    </section>
    {#if !isDocumentOnly}
      <div
        class="resizer-handle"
        role="slider"
        aria-orientation="vertical"
        aria-label="영상과 요약 노트 너비 조절"
        aria-valuemin={MIN_RATIO}
        aria-valuemax={MAX_RATIO}
        aria-valuenow={Math.round(splitRatio)}
        tabindex="0"
        onmousedown={startResize}
        onkeydown={onResizeKey}
      ></div>
    {/if}
    <section class="summary-panel" aria-labelledby="summary-title">
      <h3 id="summary-title">학습 요약</h3>
      {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
      {#if !project.markdown.trim()}<p class="muted">저장된 요약 내용이 없습니다.</p>{/if}
      <div
        class="markdown"
        use:summaryMarkdown={{ markdown: project.markdown, currentTime: globalCurrentTime, onTimestamp: seekTo, onLink: openLink }}
      ></div>
    </section>
  </div>
  <footer class="legal-notice" data-testid="legal-notice">
    <p>⚠️ 학습 참고용 안내: AI가 생성한 자료이므로 일부 오류가 있을 수 있습니다. 시험 대비 시 반드시 교안 원본을 대조하여 확인하세요.</p>
    <p>⛔ 저작권 안내: 본 강의 영상 및 AI 요약본을 학교 커뮤니티나 외부로 무단 배포하는 행위를 엄격히 금지합니다.</p>
  </footer>
</section>

<style>
  .viewer { margin-top: 24px; }
  .viewer-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
  .heading-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .badge { padding: 4px 10px; border-radius: 999px; background: #eef1ff; color: #344694; font-size: 0.72rem; font-weight: 700; }
  h2 { margin: 0; font-size: 1.5rem; overflow-wrap: anywhere; }
  h3 { margin: 0 0 16px; }
  .muted { color: #59647a; font-size: 0.85rem; }
  .back { flex-shrink: 0; padding: 10px 16px; border: 1px solid #cbd2e5; border-radius: 9px; background: white; color: #26396d; cursor: pointer; font: inherit; }
  .split-view { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  .split-view:not(.document-only) { gap: 0; }
  .split-view:not(.document-only) .video-panel { padding-right: 12px; }
  .split-view:not(.document-only) .summary-panel { margin-left: 0; }
  .split-view.resizing { user-select: none; cursor: col-resize; }
  .resizer-handle { align-self: stretch; position: relative; cursor: col-resize; border-radius: 6px; }
  .resizer-handle::after { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 3px; transform: translateX(-50%); border-radius: 2px; background: #dfe4ef; transition: background 0.15s; }
  .resizer-handle:hover::after, .resizer-handle:focus-visible::after, .resizing .resizer-handle::after { background: #4255bf; }
  .resizer-handle:focus-visible { outline: 2px solid #8597f1; }
  .video-panel { position: sticky; top: 20px; min-width: 0; }
  video { display: block; width: 100%; max-height: 65vh; background: #111827; border-radius: 12px; }
  .pdf-frame { display: block; width: 100%; height: 65vh; border: 1px solid #dfe4ef; border-radius: 12px; background: white; }
  .path { font-size: 0.8rem; color: #59647a; overflow-wrap: anywhere; }
  .summary-panel { min-width: 0; padding: 24px; border: 1px solid #dfe4ef; border-radius: 12px; background: white; max-height: calc(100vh - 220px); overflow: auto; }
  .legal-notice { margin-top: 16px; padding: 12px 16px; border-radius: 10px; background: #f3f5fa; color: #6b7488; font-size: 0.8rem; line-height: 1.6; }
  .legal-notice p { margin: 2px 0; }
  .markdown { line-height: 1.7; overflow-wrap: anywhere; }
  .markdown :global(h1) { margin: 1.4em 0 0.6em; font-size: 1.6rem; line-height: 1.3; }
  .markdown :global(h2) { margin: 1.3em 0 0.5em; font-size: 1.3rem; line-height: 1.35; padding-bottom: 0.25em; border-bottom: 1px solid #e6e9f2; }
  .markdown :global(h3) { margin: 1.2em 0 0.4em; font-size: 1.1rem; }
  .markdown :global(p) { margin: 0.6em 0 0.9em; }
  .markdown :global(ul), .markdown :global(ol) { margin: 0.5em 0 1em; padding-left: 1.5em; }
  .markdown :global(li) { margin: 0.25em 0; }
  .markdown :global(hr) { margin: 1.6em 0; border: none; border-top: 1px solid #dfe4ef; }
  .markdown :global(blockquote) { margin: 1em 0; padding: 0.4em 1em; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(pre) { padding: 16px; overflow-x: auto; background: #f3f5fa; border-radius: 8px; }
  .markdown :global(code) { font-family: ui-monospace, monospace; background: #f3f5fa; }
  .markdown :global(blockquote) { margin-left: 0; padding-left: 16px; border-left: 3px solid #aab6ee; color: #59647a; }
  .markdown :global(table) { display: block; overflow-x: auto; border-collapse: collapse; }
  .markdown :global(th), .markdown :global(td) { padding: 8px 12px; border: 1px solid #dfe4ef; }
  .markdown :global(a[href]) { color: #344eaf; }
  .markdown :global(button[data-seconds]), .markdown :global(.timestamp-link) { display: inline; padding: 2px 7px; border: 1px solid #c2cef5; border-radius: 6px; background: #eef2ff; color: #304ba6; cursor: pointer; font: inherit; font-weight: 700; }
  .markdown :global(button[data-seconds]:hover), .markdown :global(button[aria-current="true"]) { background: #4255bf; color: white; }
  .markdown :global(button:focus-visible), .back:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  .error, .notice { padding: 14px; border-radius: 8px; background: #fff0f0; color: #a12525; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .split-view, .split-view:not(.document-only) { grid-template-columns: 1fr !important; }
    .resizer-handle { display: none; }
    .video-panel { position: static; }
    .summary-panel { max-height: none; padding: 18px; }
    .viewer-heading { align-items: start; flex-direction: column; }
  }
</style>
