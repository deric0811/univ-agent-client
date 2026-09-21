<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    parseUploadResponse,
    pollJobResult,
    type JobStatusResponse,
  } from "$lib/study-api";
  import StudyProjectViewer from "$lib/components/StudyProjectViewer.svelte";
  import {
    listStudyProjects, loadStudyProject, parseProjectMeta, videoFilename, formatCreatedAt,
    type StudyProject, type StudyProjectMeta,
  } from "$lib/study-projects";

  type Phase =
    | "IDLE"
    | "EXTRACTING_AUDIO"
    | "UPLOADING"
    | "POLLING"
    | "SAVING"
    | "COMPLETED"
    | "FAILED";

  let authChecking = $state(true);
  let authenticated = $state(false);
  let username = $state("");
  let loginUsername = $state("");
  let loginPassword = $state("");
  let loginLoading = $state(false);
  let loginError = $state("");
  let videoPath = $state("");
  let pdfPath = $state("");
  let lectureTitle = $state("");
  let mode = $state<"analysis" | "library">("analysis");
  let projects = $state<StudyProjectMeta[]>([]);
  let selectedProject = $state<StudyProject | null>(null);
  let libraryLoading = $state(false);
  let libraryError = $state("");
  let loadingProjectId = $state<string | null>(null);
  let refreshVersion = 0;
  let openVersion = 0;
  let phase = $state<Phase>("IDLE");
  let selecting = $state(false);
  let job = $state<JobStatusResponse | null>(null);
  let markdown = $state<string | null>(null);
  let projectId = $state("");
  let metadataJson = $state("");
  let projectDirectory = $state("");
  let errorMessage = $state("");
  let activeController: AbortController | null = null;
  let destroyed = false;

  const busy = $derived(
    phase === "EXTRACTING_AUDIO" ||
      phase === "UPLOADING" ||
      phase === "POLLING" ||
      phase === "SAVING",
  );
  const controlsDisabled = $derived(busy || selecting);
  const canRetrySave = $derived(
    phase === "FAILED" && markdown !== null && metadataJson !== "" && projectId !== "",
  );
  const statusMessage = $derived.by(() => {
    switch (phase) {
      case "IDLE":
        return "강의 영상과 PDF를 선택한 후 분석을 시작하세요.";
      case "EXTRACTING_AUDIO":
        return "오디오 추출 중... (16kHz · 모노 · MP3)";
      case "UPLOADING":
        return "오디오와 PDF를 서버에 업로드 중...";
      case "POLLING":
        switch (job?.status) {
          case "PENDING":
            return `대기 중... 내 앞 대기열 ${job.waiting_count}명`;
          case "RUNNING_STT":
            return "STT 변환 중... 강의 음성을 텍스트로 변환하고 있습니다.";
          case "POSTPROCESSING":
            return "후처리 중... 강의 내용을 정리하고 있습니다.";
          case "SUMMARIZING":
            return "요약 생성 중...";
          case "COMPLETED":
            return "분석 완료! 결과 마크다운을 가져오는 중...";
          case "FAILED":
            return "서버에서 분석에 실패했습니다.";
          default:
            return "작업 상태를 확인하는 중...";
        }
      case "SAVING":
        return "분석 결과를 로컬 프로젝트에 저장 중...";
      case "COMPLETED":
        return "분석과 로컬 저장이 완료되었습니다.";
      case "FAILED":
        return markdown !== null ? "결과를 받았지만 로컬 저장에 실패했습니다." : "분석이 중단되었습니다.";
    }
  });

  onMount(() => { void checkAuthentication(); });

  onDestroy(() => {
    destroyed = true;
    activeController?.abort();
  });

  async function checkAuthentication() {
    authChecking = true;
    loginError = "";
    try {
      authenticated = await invoke<boolean>("is_authenticated");
      if (authenticated) void refreshProjects();
    } catch (error) {
      authenticated = false;
      loginError = `인증 상태를 확인하지 못했습니다: ${describeError(error)}`;
    } finally {
      authChecking = false;
    }
  }

  async function handleLogin(event: SubmitEvent) {
    event.preventDefault();
    if (loginLoading) return;
    loginError = "";
    loginLoading = true;
    try {
      username = await invoke<string>("login", {
        username: loginUsername,
        password: loginPassword,
      });
      loginPassword = "";
      authenticated = true;
      void refreshProjects();
    } catch (error) {
      authenticated = false;
      loginError = `로그인 실패: ${describeError(error)}`;
    } finally {
      loginLoading = false;
    }
  }

  async function handleLogout() {
    if (busy) activeController?.abort();
    loginError = "";
    try {
      await invoke("logout");
      authenticated = false;
      username = "";
      loginPassword = "";
      resetAnalysis();
    } catch (error) {
      errorMessage = `로그아웃하지 못했습니다: ${describeError(error)}`;
    }
  }

  async function refreshProjects() {
    if (destroyed) return;
    const version = ++refreshVersion;
    libraryLoading = true;
    libraryError = "";
    try {
      const library = await listStudyProjects();
      if (!destroyed && version === refreshVersion) projects = library;
    } catch (error) {
      if (!destroyed && version === refreshVersion) libraryError = describeError(error);
    } finally {
      if (!destroyed && version === refreshVersion) libraryLoading = false;
    }
  }

  function showAnalysis() {
    openVersion += 1;
    loadingProjectId = null;
    mode = "analysis";
  }

  function showLibrary() {
    openVersion += 1;
    loadingProjectId = null;
    selectedProject = null;
    mode = "library";
    void refreshProjects();
  }

  async function openProject(id: string) {
    const version = ++openVersion;
    loadingProjectId = id;
    libraryError = "";
    try {
      const project = await loadStudyProject(id);
      if (destroyed || version !== openVersion) return;
      selectedProject = project;
      mode = "library";
    } catch (error) {
      if (!destroyed && version === openVersion) libraryError = describeError(error);
    } finally {
      if (!destroyed && version === openVersion) loadingProjectId = null;
    }
  }

  function resetAnalysis() {
    phase = "IDLE";
    job = null;
    markdown = null;
    projectId = "";
    metadataJson = "";
    projectDirectory = "";
    errorMessage = "";
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function selectFile(kind: "video" | "pdf") {
    if (controlsDisabled) return;
    selecting = true;
    try {
      const path = await open({
        title: kind === "video" ? "강의 영상 선택" : "교안 PDF 선택",
        multiple: false,
        directory: false,
        filters: [
          kind === "video"
            ? { name: "강의 영상", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] }
            : { name: "교안 PDF", extensions: ["pdf"] },
        ],
      });
      if (destroyed || typeof path !== "string") return;
      resetAnalysis();
      if (kind === "video") videoPath = path;
      else pdfPath = path;
    } catch (error) {
      if (!destroyed) errorMessage = `파일 선택 실패: ${describeError(error)}`;
    } finally {
      if (!destroyed) selecting = false;
    }
  }

  async function saveResult(signal: AbortSignal) {
    signal.throwIfAborted();
    if (markdown === null || !projectId || !metadataJson) {
      throw new Error("저장할 분석 결과가 없습니다.");
    }
    phase = "SAVING";
    const savedProject: StudyProject = {
      meta: parseProjectMeta(JSON.parse(metadataJson)),
      markdown,
    };
    const directory = await invoke<string>("save_study_project", {
      projectId,
      metadataJson,
      markdownContent: markdown,
    });
    signal.throwIfAborted();
    projectDirectory = directory;
    phase = "COMPLETED";
    // Invalidate any older library load, then open the exact content just saved.
    openVersion += 1;
    loadingProjectId = null;
    selectedProject = savedProject;
    mode = "library";
    projects = [savedProject.meta, ...projects.filter((item) => item.project_id !== projectId)];
    void refreshProjects();
  }

  function handleFailure(error: unknown, controller: AbortController) {
    if (destroyed || controller.signal.aborted) return;
    errorMessage = describeError(error);
    phase = "FAILED";
  }

  async function startAnalysis() {
    if (controlsDisabled || !videoPath || !pdfPath) return;
    resetAnalysis();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;
    const sourceVideo = videoPath;
    const sourcePdf = pdfPath;
    const sourceTitle = lectureTitle.trim() || videoFilename(sourceVideo);
    const startedAt = new Date().toISOString();

    try {
      phase = "EXTRACTING_AUDIO";
      const audioPath = await invoke<string>("extract_audio_ffmpeg", {
        videoPath: sourceVideo,
      });
      // Rust invocations cannot be aborted from JS, but no next step runs after teardown.
      signal.throwIfAborted();

      phase = "UPLOADING";
      const response = await invoke<string>("upload_job", { audioPath, pdfPath: sourcePdf });
      signal.throwIfAborted();
      const uploaded = parseUploadResponse(response);
      job = { ...uploaded, error_message: null };

      phase = "POLLING";
      const result = await pollJobResult(uploaded.job_id, (status) => { job = status; }, signal);
      signal.throwIfAborted();
      markdown = result.content;
      // Keep the local folder ID independent of the server's job ID/path syntax.
      projectId = crypto.randomUUID();
      metadataJson = JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        title: sourceTitle,
        job_id: result.job_id,
        status: result.status,
        video_path: sourceVideo,
        pdf_path: sourcePdf,
        created_at: startedAt,
        completed_at: new Date().toISOString(),
      }, null, 2);
      await saveResult(signal);
    } catch (error) {
      handleFailure(error, controller);
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  async function retrySave() {
    if (controlsDisabled || !canRetrySave) return;
    const controller = new AbortController();
    activeController = controller;
    errorMessage = "";
    try {
      await saveResult(controller.signal);
    } catch (error) {
      handleFailure(error, controller);
    } finally {
      if (activeController === controller) activeController = null;
    }
  }
</script>

<svelte:head>
  <title>강의 학습 도우미</title>
  <meta name="description" content="강의 영상과 PDF를 분석하고 학습 요약을 로컬에 저장합니다." />
</svelte:head>

<main>
  <header>
    <p class="eyebrow">UNIV AGENT · STUDY LIBRARY</p>
    <h1>강의 학습 도우미</h1>
    <p class="intro">강의 영상과 교안을 함께 분석해 나만의 학습 요약을 만드세요.</p>
  </header>

  {#if authChecking}
    <section class="card auth-card" aria-live="polite">
      <p role="status">로그인 상태를 확인하는 중...</p>
    </section>
  {:else if !authenticated}
    <section class="card auth-card" aria-labelledby="login-heading">
      <h2 id="login-heading">로그인</h2>
      <p class="hint">분석 서비스를 이용하려면 계정으로 로그인해 주세요.</p>
      <form class="login-form" onsubmit={handleLogin}>
        <label for="username">아이디</label>
        <input
          id="username"
          name="username"
          autocomplete="username"
          bind:value={loginUsername}
          disabled={loginLoading}
          required
        />
        <label for="password">비밀번호</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          bind:value={loginPassword}
          disabled={loginLoading}
          required
        />
        {#if loginError}<p class="error" role="alert">{loginError}</p>{/if}
        <button class="primary" type="submit" disabled={loginLoading}>
          {loginLoading ? "로그인 중..." : "로그인"}
        </button>
      </form>
    </section>
  {:else}
    <div class="user-bar">
      <strong>{username || "사용자"}님 환영합니다!</strong>
      <button type="button" onclick={handleLogout}>로그아웃</button>
    </div>

  <nav class="mode-nav" aria-label="학습 모드">
    <button type="button" aria-pressed={mode === "analysis"} onclick={showAnalysis}>
      새 강의 분석{busy ? " · 진행 중" : ""}
    </button>
    <button type="button" aria-pressed={mode === "library"} onclick={showLibrary}>내 강의 서재</button>
  </nav>

  {#if mode === "library"}
    {#if selectedProject}
      {#key selectedProject.meta.project_id}
        <StudyProjectViewer project={selectedProject} onback={showLibrary} />
      {/key}
    {:else}
      <section class="card" aria-labelledby="library-heading">
        <div class="section-heading">
          <h2 id="library-heading">내 강의 서재 · {projects.length}개</h2>
          <button type="button" onclick={refreshProjects} disabled={libraryLoading}>새로고침</button>
        </div>
        {#if libraryLoading}<p role="status">서재를 불러오는 중...</p>{/if}
        {#if libraryError}<p class="error" role="alert">{libraryError}</p>{/if}
        {#if !libraryLoading && projects.length === 0}
          <p class="empty">아직 저장된 강의가 없습니다. 새 강의를 분석해 서재에 추가하세요.</p>
        {/if}
        <div class="project-list">
          {#each projects as project (project.project_id)}
            <button
              type="button"
              class="project-entry"
              onclick={() => openProject(project.project_id)}
              disabled={loadingProjectId !== null}
            >
              <strong>{project.title}</strong>
              <span>{formatCreatedAt(project.created_at)}</span>
              <span class="file-path">{project.video_path || "원본 비디오 경로 없음"}</span>
              <span class="open-label">{loadingProjectId === project.project_id ? "불러오는 중..." : "강의 열기 →"}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}
  {:else}
  <div class="analysis">
  <section class="card" aria-labelledby="files-heading">
    <h2 id="files-heading">1. 학습 자료 선택</h2>
    <div class="title-field">
      <label for="lecture-title">강의 제목 (선택)</label>
      <input
        id="lecture-title"
        bind:value={lectureTitle}
        placeholder={videoPath ? videoFilename(videoPath) : "비워 두면 영상 파일명을 사용합니다"}
        disabled={controlsDisabled}
      />
    </div>
    <div class="file-row">
      <div class="file-info">
        <h3>강의 영상</h3>
        <p class="hint">MP4, MKV, MOV, AVI, WEBM, M4V</p>
        <p class="file-path">{videoPath || "선택된 영상이 없습니다."}</p>
      </div>
      <button type="button" onclick={() => selectFile("video")} disabled={controlsDisabled}>영상 선택</button>
    </div>
    <div class="file-row">
      <div class="file-info">
        <h3>교안 PDF</h3>
        <p class="hint">강의에 해당하는 PDF 파일</p>
        <p class="file-path">{pdfPath || "선택된 PDF가 없습니다."}</p>
      </div>
      <button type="button" onclick={() => selectFile("pdf")} disabled={controlsDisabled}>PDF 선택</button>
    </div>
    <p class="hint">영상은 로컬 FFmpeg로 오디오만 추출합니다. 추출된 오디오와 PDF가 분석 서버로 전송됩니다.</p>
    <button
      type="button"
      class="primary"
      onclick={startAnalysis}
      disabled={controlsDisabled || !videoPath || !pdfPath}
    >
      {busy ? "분석 진행 중..." : phase === "IDLE" ? "분석 시작" : "새로 분석 시작"}
    </button>
  </section>

  <section class="card" aria-labelledby="status-heading">
    <div class="section-heading">
      <h2 id="status-heading">2. 분석 진행 상태</h2>
      <span class="badge">{phase}</span>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true">{statusMessage}</p>
    {#if busy}<progress aria-label="분석 진행 중"></progress>{/if}
    {#if job}
      <dl>
        <div><dt>작업 ID</dt><dd>{job.job_id}</dd></div>
        <div><dt>서버 상태</dt><dd>{job.status}</dd></div>
        <div><dt>내 앞 대기열</dt><dd>{job.waiting_count}명</dd></div>
      </dl>
      {#if phase === "POLLING"}<p class="hint">2초 간격으로 서버 상태를 확인합니다.</p>{/if}
    {/if}
    {#if errorMessage}
      <div class="error" role="alert">
        <strong>작업을 완료하지 못했습니다.</strong>
        <p>{errorMessage}</p>
        {#if canRetrySave}
          <button type="button" onclick={retrySave} disabled={controlsDisabled}>로컬 저장 다시 시도</button>
        {/if}
      </div>
    {/if}
    {#if projectDirectory}
      <div class="success">
        <strong>로컬 저장 완료</strong>
        <p class="file-path">{projectDirectory}</p>
        <p class="hint">meta.json · summary.md</p>
      </div>
    {/if}
  </section>

  {#if markdown !== null}
    <section class="card" aria-labelledby="result-heading">
      <h2 id="result-heading">3. 학습 요약 (Markdown 원문)</h2>
      <!-- Display untrusted server content as text, never unsanitized HTML. -->
      <pre class="markdown">{markdown}</pre>
    </section>
  {/if}
  </div>
  {/if}
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f3f5fa;
    color: #17213a;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6;
  }

  :global(*) { box-sizing: border-box; }
  main { max-width: 1440px; margin: 0 auto; padding: 36px 24px 56px; }
  .analysis { max-width: 960px; margin: 0 auto; }
  header { margin-bottom: 28px; }
  .auth-card { max-width: 440px; margin: 48px auto 0; }
  .login-form { display: grid; gap: 10px; margin-top: 20px; }
  .login-form label { font-size: 0.9rem; font-weight: 600; }
  .login-form input { width: 100%; border: 1px solid #cbd2e5; border-radius: 8px; padding: 12px; font: inherit; }
  .login-form input:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .login-form .error { margin: 6px 0 0; }
  .user-bar { display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-bottom: 18px; }
  .mode-nav { display: flex; gap: 12px; flex-wrap: wrap; }
  .mode-nav button[aria-pressed="true"] { background: #4255bf; border-color: #4255bf; color: white; }
  .title-field { margin-top: 20px; display: grid; gap: 8px; }
  .title-field label { font-size: 0.9rem; font-weight: 600; }
  .title-field input { width: 100%; border: 1px solid #cbd2e5; border-radius: 8px; padding: 12px; font: inherit; }
  .title-field input:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px; margin-top: 20px; }
  .project-entry { display: flex; flex-direction: column; align-items: start; gap: 6px; text-align: left; padding: 20px; overflow-wrap: anywhere; }
  .project-entry strong { font-size: 1.1rem; }
  .project-entry span { font-size: 0.8rem; color: #59647a; }
  .project-entry .open-label { margin-top: 12px; color: #344eaf; }
  .empty { color: #59647a; padding: 24px 0; }
  .eyebrow { color: #4758c4; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.1em; }
  h1 { margin: 6px 0; font-size: 2rem; }
  h2 { margin: 0; font-size: 1.15rem; }
  h3 { margin: 0; font-size: 1rem; }
  .intro, .hint { color: #59647a; }
  .hint { margin: 6px 0; font-size: 0.85rem; }
  .card { background: white; border: 1px solid #dfe4ef; border-radius: 16px; padding: 24px; margin-top: 20px; }
  .file-row { display: flex; gap: 20px; align-items: center; justify-content: space-between; padding: 20px 0; border-bottom: 1px solid #edf0f6; }
  .file-row + .file-row { margin-bottom: 16px; }
  .file-info { min-width: 0; }
  .file-path { margin: 6px 0 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  button { flex-shrink: 0; padding: 10px 18px; border: 1px solid #cbd2e5; border-radius: 9px; background: #fff; color: #26396d; font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { background: #eef1ff; border-color: #4758c4; }
  button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary { width: 100%; margin-top: 16px; background: #4255bf; border-color: #4255bf; color: white; }
  .primary:hover:not(:disabled) { background: #3345a8; }
  .section-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
  .badge { background: #eef1ff; color: #344694; padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; }
  progress { width: 100%; height: 6px; accent-color: #4255bf; }
  dl { margin-bottom: 0; font-size: 0.9rem; }
  dl > div { display: grid; grid-template-columns: 105px 1fr; gap: 12px; margin-top: 6px; }
  dt { color: #59647a; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .error, .success { margin-top: 16px; padding: 16px; border-radius: 10px; overflow-wrap: anywhere; }
  .error { background: #fff0f0; color: #a12525; }
  .error p { white-space: pre-wrap; }
  .success { background: #ecf9f1; color: #1b6540; }
  .markdown { margin: 20px 0 0; padding: 20px; background: #f6f7fb; border-radius: 10px; font: 0.9rem/1.8 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }

  @media (max-width: 560px) {
    main { padding: 24px 14px; }
    .card { padding: 18px; }
    .file-row { flex-direction: column; align-items: stretch; gap: 12px; }
    h1 { font-size: 1.65rem; }
  }
</style>
