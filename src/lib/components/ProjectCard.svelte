<script lang="ts">
  import { ask } from "@tauri-apps/plugin-dialog";
  import {
    deleteStudyProject,
    formatCreatedAt,
    openProjectFolder,
    renameStudyProject,
    videoFilename,
    type StudyProjectMeta,
  } from "$lib/study-projects";

  let {
    project,
    disabled = false,
    onopen,
    onchanged,
  }: {
    project: StudyProjectMeta;
    disabled?: boolean;
    onopen: (projectId: string) => void;
    onchanged: () => void;
  } = $props();

  let editing = $state(false);
  let editingName = $state("");
  let actionError = $state("");
  let pending = $state<"folder" | "rename" | "delete" | null>(null);

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function handleOpenFolder() {
    if (pending) return;
    pending = "folder";
    actionError = "";
    try {
      await openProjectFolder(project.project_id);
    } catch (error) {
      actionError = describeError(error);
    } finally {
      pending = null;
    }
  }

  function startEditing() {
    editingName = project.title;
    editing = true;
    actionError = "";
  }

  function cancelEditing() {
    editing = false;
    editingName = "";
    actionError = "";
  }

  async function saveTitle() {
    const title = editingName.trim();
    if (!title) {
      actionError = "제목을 입력해 주세요.";
      return;
    }
    if (pending) return;
    pending = "rename";
    actionError = "";
    try {
      await renameStudyProject(project.project_id, title);
      editing = false;
      onchanged();
    } catch (error) {
      actionError = describeError(error);
    } finally {
      pending = null;
    }
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTitle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  }

  async function handleDelete() {
    if (pending) return;
    const confirmed = await ask(
      `'${project.title}' 프로젝트를 삭제하시겠습니까?\n저장된 요약과 메타데이터가 영구히 삭제됩니다.`,
      { title: "프로젝트 삭제", kind: "warning" },
    );
    if (!confirmed) return;
    pending = "delete";
    actionError = "";
    try {
      await deleteStudyProject(project.project_id);
      onchanged();
    } catch (error) {
      actionError = describeError(error);
    } finally {
      pending = null;
    }
  }

  function handleOpen() {
    if (disabled || editing) return;
    onopen(project.project_id);
  }
</script>

<article class="project-card" class:editing>
  <button
    type="button"
    class="project-main"
    onclick={handleOpen}
    disabled={disabled || editing}
    aria-label={`${project.title} 강의 열기`}
  >
    <strong class="project-title">{project.title}</strong>
    {#if project.course?.trim() || project.chapter?.trim()}
      <span class="project-badges">
        {#if project.course?.trim()}<span class="meta-badge">{project.course.trim()}</span>{/if}
        {#if project.chapter?.trim()}<span class="meta-badge">{project.chapter.trim()}</span>{/if}
      </span>
    {/if}
    <span class="project-meta">생성일 {formatCreatedAt(project.created_at)}</span>
    <span class="project-video">원본 비디오 {videoFilename(project.video_path)}</span>
    <span class="project-open">
      {disabled ? "다른 강의를 여는 중..." : "강의 열기"}
    </span>
  </button>

  <div class="project-actions">
    <button type="button" onclick={handleOpenFolder} disabled={pending !== null}>
      {pending === "folder" ? "여는 중..." : "폴더 열기"}
    </button>
    <button type="button" onclick={startEditing} disabled={pending !== null || editing}>
      제목 수정
    </button>
    <button type="button" class="danger" onclick={handleDelete} disabled={pending !== null}>
      {pending === "delete" ? "삭제 중..." : "삭제"}
    </button>
  </div>

  {#if editing}
    <div class="rename-row">
      <input
        bind:value={editingName}
        aria-label="새 강의 제목"
        placeholder="새 강의 제목"
        onkeydown={handleRenameKeydown}
        disabled={pending !== null}
      />
      <button type="button" class="save" onclick={saveTitle} disabled={pending !== null}>
        {pending === "rename" ? "저장 중..." : "저장"}
      </button>
      <button type="button" onclick={cancelEditing} disabled={pending !== null}>취소</button>
    </div>
  {/if}

  {#if actionError}<p class="project-error" role="alert">{actionError}</p>{/if}
</article>

<style>
  .project-card {
    display: grid;
    gap: 14px;
    padding: 20px;
    background: white;
    border: 1px solid #dfe4ef;
    border-radius: 16px;
  }
  .project-card.editing {
    border-color: #8796eb;
    box-shadow: 0 0 0 3px #8597f13d;
  }
  .project-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .project-main:hover:not(:disabled) .project-title { color: #344eaf; }
  .project-main:focus-visible { outline: 3px solid #8597f1; outline-offset: 4px; border-radius: 8px; }
  .project-main:disabled { opacity: 0.65; cursor: wait; }
  .project-title { font-size: 1.1rem; overflow-wrap: anywhere; }
  .project-badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .meta-badge {
    padding: 3px 9px;
    border: 1px solid #d5dcf3;
    border-radius: 999px;
    background: #f1f4ff;
    color: #344694;
    font-size: 0.72rem;
    font-weight: 700;
  }
  .project-meta, .project-video { font-size: 0.8rem; color: #59647a; overflow-wrap: anywhere; }
  .project-open { margin-top: 10px; color: #344eaf; font-size: 0.85rem; font-weight: 700; }
  .project-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
  button {
    padding: 8px 12px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #eef1ff; border-color: #4758c4; }
  button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { color: #a12525; border-color: #e7b8b8; }
  button.danger:hover:not(:disabled) { background: #fff0f0; border-color: #c62f2f; }
  .rename-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .rename-row input {
    flex: 1 1 180px;
    padding: 9px 11px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    font: inherit;
  }
  .rename-row input:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .rename-row .save { background: #4255bf; border-color: #4255bf; color: white; }
  .rename-row .save:hover:not(:disabled) { background: #3345a8; }
  .project-error {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: #fff0f0;
    color: #a12525;
    font-size: 0.82rem;
    overflow-wrap: anywhere;
  }
</style>