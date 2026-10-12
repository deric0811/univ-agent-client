<script lang="ts">
  import { onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { dirname, downloadDir, join } from "@tauri-apps/api/path";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { cancelVideoMerge } from "$lib/video-tools";
  import {
    videoMergeStore,
    type VideoMergeFile,
    type VideoMergeStatus,
  } from "$lib/stores/videoMergeStore";

  let selecting = $state(false);
  let draggedIndex = $state<number | null>(null);
  // 파일 선택/저장 대화상자 콜백이 언마운트 뒤에 로컬 상태를 건드리지 않도록 막는다.
  // 병합 작업 상태는 스토어가 소유하므로 컴포넌트 수명과 무관하게 유지된다.
  let disposed = false;

  const videos = $derived($videoMergeStore.fileList);
  const outputPath = $derived($videoMergeStore.outputPath);
  const status = $derived($videoMergeStore.status);
  const statusMessage = $derived($videoMergeStore.statusMessage);
  const completedPath = $derived($videoMergeStore.completedPath);
  const progressPercent = $derived($videoMergeStore.progressPercent);
  const running = $derived($videoMergeStore.status === "merging" || $videoMergeStore.status === "cancelling");
  const cancelling = $derived($videoMergeStore.status === "cancelling");
  const canReset = $derived(
    !running &&
      (videos.length > 0 ||
        outputPath.trim().length > 0 ||
        status !== "idle" ||
        statusMessage.length > 0),
  );

  onDestroy(() => {
    disposed = true;
  });

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function videoName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  }

  async function suggestOutputPath(item: VideoMergeFile) {
    const suggestedFilename = `[합본] ${item.name}`;
    let suggestedPath = suggestedFilename;
    try {
      suggestedPath = await join(await dirname(item.path), suggestedFilename);
    } catch {
      try {
        suggestedPath = await join(await downloadDir(), suggestedFilename);
      } catch {
        suggestedPath = suggestedFilename;
      }
    }
    videoMergeStore.setOutputPath(suggestedPath, { auto: true });
  }

  async function addVideos() {
    if (running || selecting) return;
    selecting = true;
    try {
      const selected = await open({
        title: "합칠 영상 선택",
        multiple: true,
        directory: false,
        filters: [
          { name: "영상 파일", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] },
        ],
      });
      if (disposed || selected === null) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const added: VideoMergeFile[] = [];
      for (const path of paths) {
        if (typeof path === "string" && path.trim()) {
          added.push({ path, name: videoName(path) });
        }
      }
      if (added.length === 0) return;
      const isFirstSelection = get(videoMergeStore).fileList.length === 0;
      videoMergeStore.addFiles(added);
      if (isFirstSelection && !get(videoMergeStore).outputPath.trim()) {
        await suggestOutputPath(added[0]);
      }
    } catch (error) {
      if (!disposed) {
        videoMergeStore.failMerge(`영상 파일 추가 실패: ${describeError(error)}`);
      }
    } finally {
      selecting = false;
    }
  }

  async function chooseOutput() {
    if (running || selecting) return;
    try {
      const selected = await save({
        title: "합친 영상 저장 위치",
        defaultPath: get(videoMergeStore).outputPath || "merged_lecture.mp4",
        filters: [{ name: "MP4 영상", extensions: ["mp4"] }],
      });
      if (disposed || typeof selected !== "string") return;
      videoMergeStore.setOutputPath(selected);
    } catch (error) {
      if (!disposed) {
        videoMergeStore.failMerge(`저장 위치 선택 실패: ${describeError(error)}`);
      }
    }
  }

  async function syncOutputIfNeeded() {
    const fileList = get(videoMergeStore).fileList;
    if (fileList.length === 0) {
      videoMergeStore.setOutputPath("", { auto: true });
      return;
    }
    if (get(videoMergeStore).autoOutputPath) {
      await suggestOutputPath(fileList[0]);
    }
  }

  async function openInFolder() {
    const path = get(videoMergeStore).completedPath;
    if (!path) return;
    try {
      await invoke("open_file_in_folder", { filePath: path });
    } catch (error) {
      videoMergeStore.failMerge(`폴더 열기 실패: ${describeError(error)}`);
    }
  }

  function removeVideo(index: number) {
    videoMergeStore.removeFile(index);
    void syncOutputIfNeeded();
  }

  function moveVideo(fromIndex: number, toIndex: number) {
    videoMergeStore.moveFile(fromIndex, toIndex);
    void syncOutputIfNeeded();
  }

  function moveVideoUp(index: number) {
    if (index > 0) moveVideo(index, index - 1);
  }

  function moveVideoDown(index: number) {
    if (index < videos.length - 1) moveVideo(index, index + 1);
  }

  function handleDragStart(event: DragEvent, index: number) {
    if (running) {
      event.preventDefault();
      return;
    }
    draggedIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
  }

  function handleDragOver(event: DragEvent) {
    if (running) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event: DragEvent, index: number) {
    event.preventDefault();
    const fromIndex = draggedIndex;
    draggedIndex = null;
    if (running || fromIndex === null || fromIndex === index) return;
    moveVideo(fromIndex, index);
  }

  function handleDragEnd() {
    draggedIndex = null;
  }

  async function runConcat() {
    const snapshot = get(videoMergeStore);
    if (running || selecting || snapshot.fileList.length === 0 || !snapshot.outputPath.trim()) return;
    videoMergeStore.beginMerge();
    try {
      const videoPaths = snapshot.fileList.map((item) => item.path);
      const result = await invoke<string>("concat_videos_ffmpeg", {
        videoPaths,
        outputPath: snapshot.outputPath,
      });
      if (get(videoMergeStore).status === "cancelling") {
        videoMergeStore.finishCancelled();
      } else {
        videoMergeStore.completeMerge(result);
      }
    } catch (error) {
      if (get(videoMergeStore).status === "cancelling") {
        videoMergeStore.finishCancelled();
      } else {
        videoMergeStore.failMerge(`영상 합치기 실패: ${describeError(error)}`);
      }
    }
  }

  async function cancelMerge() {
    if (!running || cancelling) return;
    videoMergeStore.requestCancel();
    try {
      await cancelVideoMerge();
    } catch (error) {
      videoMergeStore.cancelFailed(`취소 실패: ${describeError(error)}`);
    }
  }

  function resetWorkspace() {
    if (running) return;
    videoMergeStore.reset();
  }

  function messageClass(statusValue: VideoMergeStatus): string {
    return statusValue === "success" ? "success" : statusValue === "error" ? "error" : "info";
  }
</script>

<section class="tools-view" aria-labelledby="tools-heading">
  <section class="card">
    <div class="tools-heading">
      <h2 id="tools-heading">영상 합치기</h2>
      <p class="hint">여러 강의 영상을 선택한 순서대로 하나의 파일로 이어 붙입니다.</p>
    </div>

    <div class="tool-actions">
      <button type="button" onclick={addVideos} disabled={running}>
        {selecting ? "추가 중..." : "영상 파일 추가"}
      </button>
      <button type="button" class="reset" onclick={resetWorkspace} disabled={!canReset}>초기화</button>
    </div>

    <div class="output-row">
      <label for="output-path">출력 경로</label>
      <div class="output-control">
        <p id="output-path" class="file-path">
          {outputPath || "첫 영상의 폴더 또는 다운로드 폴더에 자동 지정됩니다."}
        </p>
        <button type="button" onclick={chooseOutput} disabled={running}>변경</button>
      </div>
    </div>

    {#if videos.length > 0}
      <ol class="video-list">
        {#each videos as video, index (video.path + index)}
          <li
            draggable={!running}
            class:dragging={draggedIndex === index}
            ondragstart={(event) => handleDragStart(event, index)}
            ondragover={handleDragOver}
            ondrop={(event) => handleDrop(event, index)}
            ondragend={handleDragEnd}
          >
            <span class="index">{index + 1}</span>
            <span class="name">{video.name}</span>
            <button type="button" aria-label={`${video.name} 위로 이동`} onclick={() => moveVideoUp(index)} disabled={running || index === 0}>▲</button>
            <button type="button" aria-label={`${video.name} 아래로 이동`} onclick={() => moveVideoDown(index)} disabled={running || index === videos.length - 1}>▼</button>
            <button type="button" class="remove" aria-label={`${video.name} 제거`} onclick={() => removeVideo(index)} disabled={running}>×</button>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty">합칠 영상을 추가해 주세요.</p>
    {/if}

    <button
      type="button"
      class="primary"
      onclick={runConcat}
      disabled={running || videos.length === 0 || !outputPath.trim()}
    >
      {running ? "합치는 중..." : "영상 하나로 합치기"}
    </button>

    {#if running}
      <div class="running" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span>{statusMessage || "초고속 스트림 병합 시도 중..."}</span>
        <button type="button" class="cancel" onclick={cancelMerge} disabled={cancelling}>
          {cancelling ? "취소 중..." : "취소"}
        </button>
      </div>

      <div class="progress-row">
        <div
          class="progress-track"
          role="progressbar"
          aria-label="영상 병합 진행률"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(progressPercent)}
        >
          <div class="progress-fill" style="width: {progressPercent}%"></div>
        </div>
        <span class="progress-value">{Math.round(progressPercent)}%</span>
      </div>
    {/if}

    {#if !running && status !== "idle" && statusMessage}
      <div
        class="message {messageClass(status)}"
        role="status"
        aria-live="polite"
      >
        <span class="message-text">{statusMessage}</span>
        {#if status === "success" && completedPath}
          <button type="button" onclick={openInFolder} disabled={running}>폴더에서 보기</button>
        {/if}
      </div>
    {/if}
  </section>
</section>

<style>
  .tools-view { max-width: 960px; margin: 0 auto; }
  .card { background: white; border: 1px solid #dfe4ef; border-radius: 16px; padding: 24px; }
  .tools-heading h2 { margin: 0; font-size: 1.15rem; }
  .hint { margin: 6px 0 0; color: #59647a; font-size: 0.85rem; }
  .tool-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
  .output-row { margin-top: 20px; }
  .output-row label { display: block; font-size: 0.9rem; font-weight: 600; }
  .output-control { display: flex; gap: 10px; align-items: flex-start; margin-top: 6px; }
  .output-control .file-path { flex: 1 1 auto; margin: 0; min-width: 0; }
  .file-path { margin: 6px 0 0; font-size: 0.9rem; color: #59647a; overflow-wrap: anywhere; }
  .video-list { list-style: none; margin: 20px 0 0; padding: 0; display: grid; gap: 8px; }
  .video-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid #dfe4ef;
    border-radius: 10px;
    background: #fafbfe;
    cursor: grab;
  }
  .video-list li.dragging { opacity: 0.5; }
  .video-list .index { flex: 0 0 auto; color: #344694; font-weight: 700; }
  .video-list .name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .video-list button { padding: 6px 9px; font-size: 0.78rem; }
  .video-list button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  .empty { margin: 20px 0 0; padding: 20px 0; color: #59647a; }
  button {
    flex-shrink: 0;
    padding: 10px 18px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #eef1ff; border-color: #4758c4; }
  button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary { width: 100%; margin-top: 20px; background: #4255bf; border-color: #4255bf; color: white; }
  .primary:hover:not(:disabled) { background: #3345a8; }
  .running { display: flex; align-items: center; gap: 10px; margin-top: 16px; color: #344694; font-size: 0.9rem; }
  .running .cancel {
    margin-left: auto;
    padding: 7px 14px;
    border-color: #e7b8b8;
    color: #a12525;
  }
  .running .cancel:hover:not(:disabled) { background: #fff0f0; border-color: #c62f2f; }
  .spinner {
    width: 18px;
    height: 18px;
    border: 3px solid #c6cff5;
    border-top-color: #4255bf;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .progress-track {
    flex: 1 1 auto;
    height: 8px;
    border-radius: 999px;
    background: #e6eaf5;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 999px;
    background: #4255bf;
    transition: width 0.2s ease;
  }
  .progress-value {
    flex: 0 0 auto;
    min-width: 42px;
    text-align: right;
    font-size: 0.85rem;
    font-weight: 700;
    color: #344694;
  }
  .message {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 14px 16px;
    border-radius: 10px;
    overflow-wrap: anywhere;
  }
  .message-text { flex: 1 1 auto; min-width: 0; }
  .success { background: #ecf9f1; color: #1b6540; }
  .error { background: #fff0f0; color: #a12525; }
  .info { background: #eef1ff; color: #344694; }
</style>