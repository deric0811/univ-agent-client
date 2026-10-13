<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { appCacheDir, join } from "@tauri-apps/api/path";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { open } from "@tauri-apps/plugin-dialog";
  import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
  import { mergePdfFiles } from "$lib/pdf-utils";
  import {
    AuthExpiredError,
    parseUploadResponse,
    pollJobResult,
    type JobStatusResponse,
  } from "$lib/study-api";
  import StudyProjectViewer from "$lib/components/StudyProjectViewer.svelte";
  import ProjectCard from "$lib/components/ProjectCard.svelte";
  import ToolsView from "$lib/components/ToolsView.svelte";
  import NoticeAndSupportModal from "$lib/components/NoticeAndSupportModal.svelte";
  import MediaFileList from "$lib/components/MediaFileList.svelte";
  import { appendMediaFiles, isPptPath, moveWithin, type MediaFile } from "$lib/media-files";
  import {
    listStudyProjects, loadStudyProject, parseProjectMeta, uniqueCourseNames, videoFilename,
    type StudyProject, type StudyProjectMeta,
  } from "$lib/study-projects";
  import {
    ANALYSIS_MODE_OPTIONS,
    loadModels,
    modelsError,
    models,
    pickDefaultModel,
    type AnalysisMode,
  } from "$lib/models-store";
  import {
    SCHOOL_DISPLAY_NAME,
    clearSessionProfile,
    loadSessionProfile,
    saveSessionProfile,
  } from "$lib/auth-store";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { SERVER_DOWN_MESSAGE, isServerUnavailable } from "$lib/server-status";
  import { subscribeToVideoMergeProgress } from "$lib/stores/videoMergeStore";
  import { audioUploadProgress, subscribeToAudioUploadProgress } from "$lib/upload-progress";

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
  let loginMode = $state<"school" | "account">("school");
  let schoolApiKey = $state("");
  let schoolLoginLoading = $state(false);
  let schoolLoginError = $state("");
  let showSchoolKey = $state(false);
  let pptWarning = $state("");
  let noticeModalOpen = $state(false);
  let serverDownNotice = $state("");
  let videos = $state<MediaFile[]>([]);
  let pdfs = $state<MediaFile[]>([]);
  let lectureTitle = $state("");
  let lectureCourse = $state("");
  let lectureChapter = $state("");
  let selectedModel = $state("");
  let analysisMode = $state<AnalysisMode>("summary");
  let mode = $state<"analysis" | "library" | "tools">("analysis");
  let projects = $state<StudyProjectMeta[]>([]);
  let selectedProject = $state<StudyProject | null>(null);
  let activeCourse = $state("all");
  let libraryLoading = $state(false);
  let libraryError = $state("");
  let loadingProjectId = $state<string | null>(null);
  let refreshVersion = 0;
  let openVersion = 0;
  let phase = $state<Phase>("IDLE");
  let documentMode = $state(false);
  let selecting = $state(false);
  let job = $state<JobStatusResponse | null>(null);
  let markdown = $state<string | null>(null);
  let projectId = $state("");
  let metadataJson = $state("");
  let projectDirectory = $state("");
  let errorMessage = $state("");
  let authExpired = $state(false);
  let pendingTempPaths: string[] = [];
  let activeController: AbortController | null = null;
  let zoomPercent = $state(100);
  let zoomToastVisible = $state(false);
  let zoomToastTimer: ReturnType<typeof setTimeout> | null = null;
  let mergeProgressUnsubscribe: (() => void) | null = null;
  let audioUploadUnsubscribe: (() => void) | null = null;
  let externalDropUnsubscribe: (() => void) | null = null;
  let destroyed = false;

  const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"];

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
  const canRetryAnalysis = $derived(
    phase === "FAILED" &&
      !authExpired &&
      !busy &&
      videos.length > 0 &&
      pdfs.length > 0,
  );
  const UNCATEGORIZED_COURSE = "미분류";
  function projectCourse(project: StudyProjectMeta): string {
    const value = (project.course ?? "").trim();
    return value || UNCATEGORIZED_COURSE;
  }
  const courses = $derived(
    Array.from(new Set(projects.map((project) => projectCourse(project)))).sort((left, right) => {
      if (left === UNCATEGORIZED_COURSE) return 1;
      if (right === UNCATEGORIZED_COURSE) return -1;
      return left.localeCompare(right, "ko");
    }),
  );
  const filteredProjects = $derived(
    activeCourse === "all"
      ? projects
      : projects.filter((project) => projectCourse(project) === activeCourse),
  );
  // 기존 강의들의 과목명을 중복 없이 모아 과목명 입력의 추천 목록으로 제공한다.
  const courseOptions = $derived(uniqueCourseNames(projects));
  const activeModelId = $derived(pickDefaultModel($models, selectedModel));
  const selectedModeLabel = $derived(
    ANALYSIS_MODE_OPTIONS.find((option) => option.value === analysisMode)?.label ?? "분석",
  );
  const statusMessage = $derived.by(() => {
    // 문서 전용 모드에서는 STT 없이 요약만 진행된다는 점을 명확히 안내한다.
    if (documentMode && (phase === "UPLOADING" || phase === "POLLING")) {
      return "문서 분석 모드: 음성 인식을 건너뛰고 강의자료 요약 중...";
    }
    switch (phase) {
      case "IDLE":
        return "강의 영상과 PDF를 선택한 후 분석을 시작하세요.";
      case "EXTRACTING_AUDIO":
        return "오디오 추출 중... (16kHz · 모노 · WAV)";
      case "UPLOADING":
        return $audioUploadProgress?.message ?? "강의 오디오 및 자료 백엔드 전송 중...";
      case "POLLING":
        switch (job?.status) {
          case "queued":
            return `분석 대기 중... 내 앞 대기열 ${job.waiting_count}명`;
          case "transcribing":
            return "음성 인식 및 타임스탬프 추출 중 (Faster-Whisper)...";
          case "summarizing":
            return `${activeModelId} 기반 ${selectedModeLabel} 생성 중...`;
          case "completed":
            return "분석 완료: 결과를 가져오는 중...";
          case "failed":
            return "서버에서 분석에 실패했습니다.";
          default:
            return "작업 상태를 확인하는 중...";
        }
      case "SAVING":
        return "분석 완료: 로컬 서재에 저장하는 중...";
      case "COMPLETED":
        return "분석과 로컬 저장이 완료되었습니다.";
      case "FAILED":
        return markdown !== null ? "결과를 받았지만 로컬 저장에 실패했습니다." : "분석이 중단되었습니다.";
    }
  });

  onMount(() => {
    void checkAuthentication();
    window.addEventListener("keydown", handleKeydown);
    mergeProgressUnsubscribe = subscribeToVideoMergeProgress();
    audioUploadUnsubscribe = subscribeToAudioUploadProgress();
    void registerExternalDrop();
  });

  onDestroy(() => {
    destroyed = true;
    activeController?.abort();
    window.removeEventListener("keydown", handleKeydown);
    mergeProgressUnsubscribe?.();
    mergeProgressUnsubscribe = null;
    audioUploadUnsubscribe?.();
    audioUploadUnsubscribe = null;
    externalDropUnsubscribe?.();
    externalDropUnsubscribe = null;
    if (zoomToastTimer) clearTimeout(zoomToastTimer);
    document.body.style.zoom = "";
  });

  /** OS에서 창으로 떨어뜨린 영상/PDF를 각각의 목록에 추가한다. */
  async function registerExternalDrop() {
    // Tauri 런타임이 없는 환경(테스트/브라우저)에서는 조용히 건너뜬다.
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        handleDroppedPaths(event.payload.paths ?? []);
      });
      if (destroyed) unlisten();
      else externalDropUnsubscribe = unlisten;
    } catch {
      // 드래그&드롭을 지원하지 않는 환경에서는 무시한다.
    }
  }

  const PPT_WARNING =
    "PPT/PPTX 파일은 직접 등록할 수 없습니다. PowerPoint에서 [다른 이름으로 저장 > PDF]로 변환 후 업로드해 주세요.";

  /** 떨어뜨린 경로 중 지원 형식만 등록하고, PPT/PPTX는 차단·경고한다. */
  function handleDroppedPaths(paths: string[]) {
    if (paths.some(isPptPath)) {
      pptWarning = PPT_WARNING;
    }
    const droppedVideos = paths.filter((path) =>
      VIDEO_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)),
    );
    const droppedPdfs = paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
    if (droppedVideos.length > 0 || droppedPdfs.length > 0) resetAnalysis();
    if (droppedVideos.length > 0) videos = appendMediaFiles(videos, droppedVideos);
    if (droppedPdfs.length > 0) pdfs = appendMediaFiles(pdfs, droppedPdfs);
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return tagName === "input" || tagName === "textarea" || target.isContentEditable;
  }

  function applyZoom(percent: number) {
    zoomPercent = percent;
    document.body.style.zoom = String(percent / 100);
    zoomToastVisible = true;
    if (zoomToastTimer) clearTimeout(zoomToastTimer);
    zoomToastTimer = setTimeout(() => { zoomToastVisible = false; }, 1_200);
  }

  async function toggleFullscreen() {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    } catch {
      // Tauri 창이 없는 환경(테스트/브라우저)에서는 무시한다.
    }
  }

  function handleZoomShortcut(event: KeyboardEvent): boolean {
    if (!event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+") {
      event.preventDefault();
      applyZoom(Math.min(150, zoomPercent + 10));
      return true;
    }
    if (event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-") {
      event.preventDefault();
      applyZoom(Math.max(70, zoomPercent - 10));
      return true;
    }
    if (event.code === "Digit0" || event.code === "Numpad0" || event.key === "0") {
      event.preventDefault();
      applyZoom(100);
      return true;
    }
    return false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "F11") {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (handleZoomShortcut(event)) return;
    if (!authenticated || isEditableTarget(event.target)) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code === "Digit1") {
      event.preventDefault();
      showAnalysis();
    } else if (event.code === "Digit2") {
      event.preventDefault();
      showLibrary();
    } else if (event.code === "Digit3") {
      event.preventDefault();
      showTools();
    }
  }

  async function checkAuthentication() {
    authChecking = true;
    loginError = "";
    try {
      authenticated = await invoke<boolean>("is_authenticated");
      if (authenticated) {
        // 재시작/새로고침 후에도 학교 키 사용자의 표시 이름을 복원한다.
        const profile = loadSessionProfile();
        if (profile) username = profile.displayName;
        void refreshProjects();
        void refreshModels();
      }
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
      clearSessionProfile();
      authenticated = true;
      void refreshProjects();
      void refreshModels();
    } catch (error) {
      authenticated = false;
      loginError = `로그인 실패: ${describeError(error)}`;
    } finally {
      loginLoading = false;
    }
  }

  async function handleSchoolLogin(event: SubmitEvent) {
    event.preventDefault();
    if (schoolLoginLoading) return;
    schoolLoginError = "";
    schoolLoginLoading = true;
    try {
      username = await invoke<string>("login_school_key", {
        schoolApiKey,
      });
      schoolApiKey = "";
      username = SCHOOL_DISPLAY_NAME;
      saveSessionProfile({ displayName: SCHOOL_DISPLAY_NAME, is_byok: true });
      authenticated = true;
      void refreshProjects();
      void refreshModels();
    } catch (error) {
      authenticated = false;
      schoolLoginError = `학교 AI 로그인 실패: ${describeError(error)}`;
    } finally {
      schoolLoginLoading = false;
    }
  }

  async function handleLogout() {
    if (busy) activeController?.abort();
    loginError = "";
    try {
      await invoke("logout");
      authenticated = false;
      username = "";
      clearSessionProfile();
      loginPassword = "";
      resetAnalysis();
    } catch (error) {
      errorMessage = `로그아웃하지 못했습니다: ${describeError(error)}`;
    }
  }

  /** 로그인 후 사용 가능한 모델 목록을 불러오고 선택값을 보정한다. */
  async function refreshModels() {
    const list = await loadModels();
    selectedModel = pickDefaultModel(list, selectedModel);
    const failure = get(modelsError);
    if (failure !== null && isServerUnavailable(failure)) serverDownNotice = SERVER_DOWN_MESSAGE;
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
    activeCourse = "all";
    mode = "library";
    void refreshProjects();
  }

  function showTools() {
    openVersion += 1;
    loadingProjectId = null;
    selectedProject = null;
    mode = "tools";
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
    authExpired = false;
    pendingTempPaths = [];
    documentMode = false;
    audioUploadProgress.set(null);
  }

  function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return isServerUnavailable(message) ? SERVER_DOWN_MESSAGE : message;
  }

  async function addFiles(kind: "video" | "pdf") {
    if (controlsDisabled) return;
    selecting = true;
    try {
      const isPdf = kind === "pdf";
      const selected = await open({
        title: isPdf ? "교안 PDF 선택" : "강의 영상 선택",
        multiple: true,
        directory: false,
        filters: isPdf
          ? [{ name: "교안 PDF", extensions: ["pdf"] }]
          : [{ name: "강의 영상", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] }],
      });
      if (destroyed || selected === null) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).filter(
        (path): path is string => typeof path === "string" && path.trim().length > 0,
      );
      if (paths.length === 0) return;
      resetAnalysis();
      if (isPdf) pdfs = appendMediaFiles(pdfs, paths);
      else videos = appendMediaFiles(videos, paths);
    } catch (error) {
      if (!destroyed) errorMessage = `파일 선택 실패: ${describeError(error)}`;
    } finally {
      if (!destroyed) selecting = false;
    }
  }

  function removeVideo(index: number) {
    videos = videos.filter((_, itemIndex) => itemIndex !== index);
  }

  function moveVideo(index: number, delta: number) {
    videos = moveWithin(videos, index, index + delta);
  }

  function reorderVideos(fromIndex: number, toIndex: number) {
    videos = moveWithin(videos, fromIndex, toIndex);
  }

  function removePdf(index: number) {
    pdfs = pdfs.filter((_, itemIndex) => itemIndex !== index);
  }

  function movePdf(index: number, delta: number) {
    pdfs = moveWithin(pdfs, index, index + delta);
  }

  function reorderPdfs(fromIndex: number, toIndex: number) {
    pdfs = moveWithin(pdfs, fromIndex, toIndex);
  }

  /** 여러 PDF를 pdf-lib으로 무손실 병합해 캐시에 임시 파일로 기록한다. */
  async function prepareMergedPdf(): Promise<{ path: string; temporary: boolean }> {
    const paths = pdfs.map((item) => item.path);
    if (paths.length === 1) return { path: paths[0], temporary: false };
    const buffers = await Promise.all(paths.map((path) => readFile(path)));
    const merged = await mergePdfFiles(buffers);
    const cacheDir = await appCacheDir();
    await mkdir(cacheDir, { recursive: true });
    const temporaryPdfPath = await join(cacheDir, `merged_lecture_${crypto.randomUUID()}.pdf`);
    await writeFile(temporaryPdfPath, merged);
    return { path: temporaryPdfPath, temporary: true };
  }

  /** 저장이 끝나면 임시 오디오/병합 PDF를 지운다. 실패해도 완료 처리는 막지 않는다. */
  async function cleanupTempFiles() {
    const paths = pendingTempPaths;
    pendingTempPaths = [];
    if (paths.length === 0) return;
    try {
      await invoke("cleanup_temp_files", { paths });
    } catch {
      // 정리 실패는 결과 저장 성공을 되돌리지 않는다.
    }
  }

  async function mergedAudioOutputPath(): Promise<string> {
    const cacheDir = await appCacheDir();
    await mkdir(cacheDir, { recursive: true });
    return join(cacheDir, `merged_audio_${crypto.randomUUID()}.wav`);
  }

  async function saveResult(signal: AbortSignal) {
    signal.throwIfAborted();
    if (markdown === null || !projectId || !metadataJson) {
      throw new Error("저장할 분석 결과가 없습니다.");
    }
    phase = "SAVING";
    const inMemoryProject: StudyProject = {
      meta: parseProjectMeta(JSON.parse(metadataJson)),
      markdown,
    };
    const directory = await invoke<string>("save_study_project", {
      projectId,
      metadataJson,
      markdownContent: markdown,
    });
    signal.throwIfAborted();
    // 디스크에 원자적으로 저장된 최신 메타(video_paths 등)를 다시 읽어 뷰어 상태를 동기화한다.
    // 재로드가 실패하면 방금 저장한 메모리 내용으로 대체한다.
    let savedProject = inMemoryProject;
    try {
      const reloaded = await loadStudyProject(projectId);
      if (reloaded.meta.project_id === projectId) savedProject = reloaded;
    } catch {
      // 저장은 이미 성공했으므로 메모리 상태로 계속 진행한다.
    }
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
    authExpired = error instanceof AuthExpiredError;
    errorMessage = describeError(error);
    phase = "FAILED";
  }

  async function startAnalysis() {
    if (controlsDisabled || (videos.length === 0 && pdfs.length === 0)) return;
    resetAnalysis();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;
    const hasVideos = videos.length > 0;
    documentMode = !hasVideos;
    const sourceVideos = videos.map((item) => item.path);
    const sourceTitle =
      lectureTitle.trim() ||
      (hasVideos ? videoFilename(sourceVideos[0]) : pdfs[0]?.name ?? "제목 없는 강의");
    const sourceCourse = lectureCourse.trim();
    const sourceChapter = lectureChapter.trim();
    const sourceModel = pickDefaultModel($models, selectedModel);
    const sourceMode = analysisMode;
    const startedAt = new Date().toISOString();

    try {
      // 문서 전용이면 오디오 추출 단계를 건너뛰고 곧바로 업로드/요약으로 간다.
      phase = hasVideos ? "EXTRACTING_AUDIO" : "UPLOADING";
      // 여러 PDF는 pdf-lib으로 먼저 하나로 병합하고, 여러 영상은 오디오만 추출해 이어 붙인다.
      const pdfSource = await prepareMergedPdf();
      signal.throwIfAborted();

      let extracted: { audioPath: string; videoDurations: number[] } | null = null;
      if (hasVideos) {
        const outputAudioPath = await mergedAudioOutputPath();
        signal.throwIfAborted();
        extracted = await invoke<{ audioPath: string; videoDurations: number[] }>(
          "extract_and_merge_audio_from_videos",
          { videoPaths: sourceVideos, outputAudioPath },
        );
        // Rust invocations cannot be aborted from JS, but no next step runs after teardown.
        signal.throwIfAborted();
      }

      // 저장이 끝나면 삭제할 임시 산출물(추출 오디오 + 병합 PDF)을 기록해 둔다.
      pendingTempPaths = extracted ? [extracted.audioPath] : [];
      if (pdfSource.temporary) pendingTempPaths.push(pdfSource.path);

      phase = "UPLOADING";
      const response = await invoke<string>("upload_job", {
        audioPath: extracted?.audioPath ?? null,
        pdfPath: pdfSource.path,
        model: sourceModel,
        analysisMode: sourceMode,
        metadataJson: JSON.stringify({
          document_only: !hasVideos,
          title: sourceTitle,
          course: sourceCourse || undefined,
          chapter: sourceChapter || undefined,
          model: sourceModel,
          analysis_mode: sourceMode,
          video_paths: hasVideos ? sourceVideos : [],
          video_durations: extracted?.videoDurations ?? [],
          pdf_paths: pdfs.map((item) => item.path),
        }),
      });
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
        course: sourceCourse || undefined,
        chapter: sourceChapter || undefined,
        model: sourceModel,
        analysis_mode: sourceMode,
        job_id: result.job_id,
        status: result.status,
        document_only: !hasVideos,
        video_path: hasVideos ? sourceVideos[0] : null,
        video_paths: hasVideos ? sourceVideos : [],
        video_durations: extracted?.videoDurations ?? [],
        pdf_path: pdfSource.path,
        pdf_paths: pdfs.map((item) => item.path),
        timestamps: result.timestamps ?? undefined,
        created_at: startedAt,
        completed_at: new Date().toISOString(),
      }, null, 2);
      await saveResult(signal);
    } catch (error) {
      handleFailure(error, controller);
    } finally {
      if (activeController === controller) activeController = null;
      // 성공/실패/취소와 무관하게 임시 오디오/병합 PDF를 정리한다.
      await cleanupTempFiles();
    }
  }

  async function retrySave() {
    if (controlsDisabled || !canRetrySave) return;
    const controller = new AbortController();
    activeController = controller;
    errorMessage = "";
    authExpired = false;
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
      <div class="login-tabs" role="tablist" aria-label="로그인 방식">
        <button
          type="button"
          role="tab"
          aria-selected={loginMode === "school"}
          onclick={() => { loginMode = "school"; }}
        >학교 AI 키 로그인</button>
        <button
          type="button"
          role="tab"
          aria-selected={loginMode === "account"}
          onclick={() => { loginMode = "account"; }}
        >기존 계정 로그인</button>
      </div>

      {#if loginMode === "school"}
        <div class="key-steps">
          <h3>고려대 세종 학생 전용 무료 AI 로그인</h3>
          <ol>
            <li><strong>1단계</strong>: <code>kusllm.korea.ac.kr</code> (고려대 세종 BAZE 포털)에 통합 계정으로 로그인합니다.</li>
            <li><strong>2단계</strong>: 좌측 하단 메뉴에서 <strong>[API Gateway]</strong>를 클릭하고 <strong>[API 키 생성]</strong> 버튼을 누릅니다.</li>
            <li><strong>3단계</strong>: 발급된 <code>sk-factchat-...</code> 형식의 키를 아래에 복사해 넣으세요.</li>
          </ol>
          <p class="key-credit">학교에서 매월 <strong>3,000 크레딧</strong>을 무료로 제공합니다. (2시간 강의 요약 시 약 30크레딧 소모 = 한 달에 100개 이상 요약 가능!)</p>
        </div>
        <form class="login-form" onsubmit={handleSchoolLogin}>
          <label for="school-api-key">학교 AI API Key</label>
          <div class="password-row">
            <input
              id="school-api-key"
              name="school-api-key"
              type={showSchoolKey ? "text" : "password"}
              autocomplete="off"
              bind:value={schoolApiKey}
              disabled={schoolLoginLoading}
              required
            />
            <button
              type="button"
              onclick={() => { showSchoolKey = !showSchoolKey; }}
              disabled={schoolLoginLoading}
            >{showSchoolKey ? "숨기기" : "표시"}</button>
          </div>
          <p class="key-warning">API 키는 생성 시 단 1회만 표시되므로 안전한 곳에 복사해 두세요.</p>
          {#if schoolLoginError}<p class="error" role="alert">{schoolLoginError}</p>{/if}
          <button class="primary" type="submit" disabled={schoolLoginLoading}>
            {schoolLoginLoading ? "확인 중..." : "학교 AI 키로 로그인"}
          </button>
        </form>
      {:else}
        <p class="hint">관리자/지인용 계정으로 로그인합니다.</p>
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
      {/if}
    </section>
  {:else}
    <div class="workspace">
      <aside class="sidebar" aria-label="주요 메뉴">
        <nav class="sidebar-nav" aria-label="학습 모드">
          <button type="button" aria-pressed={mode === "analysis"} onclick={showAnalysis}>
            <span>새 강의 분석{busy ? " · 진행 중" : ""}</span>
            <kbd>Alt+1</kbd>
          </button>
          <button type="button" aria-pressed={mode === "library"} onclick={showLibrary}>
            <span>내 강의 서재</span>
            <kbd>Alt+2</kbd>
          </button>
          <button type="button" aria-pressed={mode === "tools"} onclick={showTools}>
            <span>영상 합치기</span>
            <kbd>Alt+3</kbd>
          </button>
        </nav>
        <div class="sidebar-footer">
          <span class="user-name"><strong>{username || "사용자"}</strong>{username.endsWith("님") ? "" : " 님"}</span>
          <button type="button" onclick={() => { noticeModalOpen = true; }}>공지 / 후원 / 문의</button>
          <button type="button" onclick={handleLogout}>로그아웃</button>
        </div>
      </aside>

      <section class="content">
        <!-- 탭 전환 시에도 각 뷰를 DOM에 유지해 진행 중인 작업 상태를 보존한다. -->
        <div class="tab-panel" hidden={mode !== "tools"} aria-hidden={mode !== "tools"}>
          <ToolsView />
        </div>

        <div class="tab-panel" hidden={mode !== "library"} aria-hidden={mode !== "library"}>
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
              {#if courses.length > 0}
                <div class="course-tabs" aria-label="과목 필터">
                  <button
                    type="button"
                    aria-pressed={activeCourse === "all"}
                    onclick={() => { activeCourse = "all"; }}
                  >전체</button>
                  {#each courses as course (course)}
                    <button
                      type="button"
                      aria-pressed={activeCourse === course}
                      onclick={() => { activeCourse = course; }}
                    >{course}</button>
                  {/each}
                </div>
              {/if}
              {#if libraryLoading}<p role="status">서재를 불러오는 중...</p>{/if}
              {#if libraryError}<p class="error" role="alert">{libraryError}</p>{/if}
              {#if !libraryLoading && projects.length === 0}
                <p class="empty">아직 저장된 강의가 없습니다. 새 강의를 분석해 서재에 추가하세요.</p>
              {/if}
              <div class="project-list">
                {#each filteredProjects as project (project.project_id)}
                  <ProjectCard
                    project={project}
                    disabled={loadingProjectId !== null}
                    onopen={openProject}
                    onchanged={refreshProjects}
                  />
                {/each}
              </div>
            </section>
          {/if}
        </div>

        <div class="tab-panel" hidden={mode !== "analysis"} aria-hidden={mode !== "analysis"}>
          <div class="analysis">
            <section class="card" aria-labelledby="files-heading">
              <h2 id="files-heading">1. 학습 자료 선택</h2>
              <div class="field-grid">
                <div class="title-field">
                  <label for="lecture-title">강의 제목 (선택)</label>
                  <input
                    id="lecture-title"
                    bind:value={lectureTitle}
                    placeholder={videos.length > 0 ? videoFilename(videos[0].path) : "비워 두면 영상 파일명을 사용합니다"}
                    disabled={controlsDisabled}
                  />
                </div>
                <div class="title-field">
                  <label for="lecture-course">과목명 (선택)</label>
                  <input
                    id="lecture-course"
                    list="course-options"
                    bind:value={lectureCourse}
                    placeholder="예: 알고리즘 분석"
                    disabled={controlsDisabled}
                  />
                  <datalist id="course-options">
                    {#each courseOptions as course (course)}
                      <option value={course}></option>
                    {/each}
                  </datalist>
                </div>
                <div class="title-field">
                  <label for="lecture-chapter">챕터 / 주차 / 목차 (선택)</label>
                  <input
                    id="lecture-chapter"
                    bind:value={lectureChapter}
                    placeholder="예: 3주차, Ch.02"
                    disabled={controlsDisabled}
                  />
                </div>
                <div class="title-field">
                  <label for="analysis-model">분석 모델 선택</label>
                  <select
                    id="analysis-model"
                    bind:value={selectedModel}
                    disabled={controlsDisabled}
                  >
                    {#each $models as model (model.id)}
                      <option value={model.id}>{model.name}</option>
                    {/each}
                  </select>
                </div>
                <div class="title-field mode-field">
                  <span id="analysis-mode-label">학습 산출물 모드</span>
                  <div class="mode-group" role="radiogroup" aria-labelledby="analysis-mode-label">
                    {#each ANALYSIS_MODE_OPTIONS as option (option.value)}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={analysisMode === option.value}
                        disabled={controlsDisabled}
                        onclick={() => { analysisMode = option.value; }}
                      >{option.label}</button>
                    {/each}
                  </div>
                </div>
              </div>
              <MediaFileList
                items={videos}
                heading="강의 영상"
                hint="MP4, MKV, MOV, AVI, WEBM, M4V · 여러 개 선택 시 순서대로 오디오를 이어 붙입니다."
                addLabel={selecting ? "추가 중..." : "영상 파일 추가"}
                emptyText="병합할 강의 영상을 추가해 주세요."
                disabled={controlsDisabled}
                onadd={() => addFiles("video")}
                onremove={removeVideo}
                onmove={moveVideo}
                onreorder={reorderVideos}
              />
              <MediaFileList
                items={pdfs}
                heading="교안 PDF"
                hint="여러 PDF를 선택하면 pdf-lib으로 무손실 병합됩니다."
                addLabel={selecting ? "추가 중..." : "PDF 파일 추가"}
                emptyText="분석할 교안 PDF를 추가해 주세요."
                badgeLabel="PDF 전용"
                badgeTooltip="교안 파일은 PDF 형식만 지원합니다. PPT 자료는 PDF로 내보낸 뒤 추가해 주세요."
                disabled={controlsDisabled}
                onadd={() => addFiles("pdf")}
                onremove={removePdf}
                onmove={movePdf}
                onreorder={reorderPdfs}
              />
              <p class="hint">영상은 로컬 FFmpeg로 오디오만 추출해 이어 붙입니다. 추출된 오디오와 PDF가 분석 서버로 전송됩니다.</p>
              <button
                type="button"
                class="primary"
                onclick={startAnalysis}
                disabled={controlsDisabled || (videos.length === 0 && pdfs.length === 0)}
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
                  <strong>{authExpired ? "인증이 필요합니다." : "작업을 완료하지 못했습니다."}</strong>
                  <p>{errorMessage}</p>
                  {#if canRetrySave}
                    <button type="button" onclick={retrySave} disabled={controlsDisabled}>로컬 저장 다시 시도</button>
                  {:else if canRetryAnalysis}
                    <button type="button" onclick={startAnalysis} disabled={controlsDisabled}>다시 시도</button>
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
        </div>
      </section>
    </div>
  {/if}
</main>

{#if zoomToastVisible}
  <div class="zoom-toast" role="status" aria-live="polite">{zoomPercent}%</div>
{/if}

{#if noticeModalOpen}
  <NoticeAndSupportModal onclose={() => { noticeModalOpen = false; }} />
{/if}

{#if serverDownNotice}
  <div class="ppt-toast" role="alert">
    <span>{serverDownNotice}</span>
    <button type="button" aria-label="알림 닫기" onclick={() => { serverDownNotice = ""; }}>×</button>
  </div>
{/if}

{#if pptWarning}
  <div class="ppt-toast" role="alert">
    <span>{pptWarning}</span>
    <button type="button" aria-label="경고 닫기" onclick={() => { pptWarning = ""; }}>×</button>
  </div>
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #f3f5fa;
    color: #17213a;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6;
  }

  :global(*) { box-sizing: border-box; }
  main { max-width: 1440px; margin: 0 auto; padding: 32px 24px 56px; }
  .zoom-toast {
    position: fixed;
    right: 24px;
    bottom: 24px;
    padding: 8px 14px;
    border-radius: 999px;
    background: #17213a;
    color: white;
    font-size: 0.9rem;
    font-weight: 700;
    box-shadow: 0 8px 24px rgba(23, 33, 58, 0.24);
    z-index: 1000;
  }
  .ppt-toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(680px, calc(100vw - 32px));
    padding: 12px 16px;
    border-radius: 12px;
    border: 1px solid #f0c98a;
    background: #fff4e5;
    color: #8a4b00;
    font-size: 0.88rem;
    box-shadow: 0 10px 30px rgba(23, 33, 58, 0.18);
    z-index: 1100;
  }
  .ppt-toast button {
    border: none;
    background: transparent;
    color: inherit;
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
  }
  .login-tabs {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .login-tabs button {
    flex: 1 1 auto;
    padding: 9px 12px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .login-tabs button[aria-selected="true"],
  .login-tabs button[aria-selected="true"]:hover:not(:disabled) {
    background: #4255bf;
    border-color: #4255bf;
    color: white;
  }
  .password-row { display: flex; gap: 8px; }
  .password-row input { flex: 1 1 auto; }
  .password-row button {
    flex-shrink: 0;
    padding: 8px 12px;
    border: 1px solid #cbd2e5;
    border-radius: 8px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  header { margin-bottom: 26px; }
  .auth-card { max-width: 440px; margin: 48px auto 0; }
  .login-form { display: grid; gap: 10px; margin-top: 20px; }
  .login-form label { font-size: 0.9rem; font-weight: 600; }
  .login-form input { width: 100%; border: 1px solid #cbd2e5; border-radius: 8px; padding: 12px; font: inherit; }
  .login-form input:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .login-form .error { margin: 6px 0 0; }

  .workspace { display: flex; gap: 24px; align-items: flex-start; }
  .sidebar {
    position: sticky;
    top: 24px;
    flex: 0 0 200px;
    width: 200px;
    min-height: calc(100vh - 150px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    background: white;
    border: 1px solid #dfe4ef;
    border-radius: 16px;
  }
  .sidebar-nav { display: grid; gap: 8px; }
  .sidebar-nav button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
    padding: 11px 12px;
    border: 1px solid #cbd2e5;
    border-radius: 10px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .sidebar-nav button kbd {
    flex-shrink: 0;
    padding: 2px 6px;
    border: 1px solid #d5dbe9;
    border-radius: 6px;
    background: #f6f7fb;
    color: #59647a;
    font-family: inherit;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.4;
  }
  .sidebar-nav button[aria-pressed="true"] kbd {
    border-color: rgba(255, 255, 255, 0.45);
    background: rgba(255, 255, 255, 0.18);
    color: white;
  }
  .sidebar-nav button:hover:not(:disabled):not([aria-pressed="true"]) { background: #eef1ff; border-color: #4758c4; }
  .sidebar-nav button[aria-pressed="true"] { background: #4255bf; border-color: #4255bf; color: white; }
  .sidebar-nav button[aria-pressed="true"]:hover:not(:disabled) { background: #3345a8; border-color: #3345a8; color: white; }
  .sidebar-footer {
    margin-top: auto;
    display: grid;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid #edf0f6;
  }
  .user-name { font-size: 0.88rem; color: #59647a; overflow-wrap: anywhere; }
  .sidebar-footer button {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .sidebar-footer button:hover { background: #eef1ff; border-color: #4758c4; }

  .content { flex: 1 1 auto; min-width: 0; }
  .tab-panel[hidden] { display: none; }
  .analysis { max-width: 960px; margin: 0 auto; }

  .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 20px; }
  .field-grid .title-field { margin-top: 0; }
  .title-field { display: grid; gap: 8px; }
  .title-field label { font-size: 0.9rem; font-weight: 600; }
  .title-field input { width: 100%; border: 1px solid #cbd2e5; border-radius: 8px; padding: 12px; font: inherit; }
  .title-field input:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .mode-field { grid-column: 1 / -1; }
  .mode-group { display: flex; flex-wrap: wrap; gap: 8px; }
  .mode-group button { padding: 7px 14px; }
  .mode-group button[aria-checked="true"],
  .mode-group button[aria-checked="true"]:hover:not(:disabled) { background: #4255bf; border-color: #4255bf; color: #ffffff; }
  #analysis-model { padding: 9px 10px; border: 1px solid #cbd2e5; border-radius: 8px; font: inherit; }
  .course-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .course-tabs button { padding: 7px 14px; }
  .course-tabs button:hover:not(:disabled):not([aria-pressed="true"]) { background: #eef1ff; border-color: #4758c4; }
  .course-tabs button[aria-pressed="true"] { background: #4255bf; border-color: #4255bf; color: white; }
  .course-tabs button[aria-pressed="true"]:hover:not(:disabled) { background: #3345a8; border-color: #3345a8; color: white; }
  .project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 16px; margin-top: 20px; }
  .empty { color: #59647a; padding: 24px 0; }
  .eyebrow { color: #4758c4; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.1em; }
  h1 { margin: 6px 0; font-size: 2rem; }
  h2 { margin: 0; font-size: 1.15rem; }
  .intro, .hint { color: #59647a; }
  .hint { margin: 6px 0; font-size: 0.85rem; }
  .card { background: white; border: 1px solid #dfe4ef; border-radius: 16px; padding: 24px; margin-top: 20px; }
  .content .card:first-child { margin-top: 0; }
  .file-path { margin: 6px 0 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  button { flex-shrink: 0; padding: 10px 18px; border: 1px solid #cbd2e5; border-radius: 9px; background: #fff; color: #26396d; font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled):not([aria-pressed="true"]) { background: #eef1ff; border-color: #4758c4; }
  button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary { width: 100%; margin-top: 16px; background: #4255bf; border-color: #4255bf; color: white; }
  /* 전역 button:hover(밝은 배경)보다 우선하도록 명시도를 높이고 글자색을 유지한다. */
  .primary:hover:not(:disabled):not([aria-pressed="true"]) { background: #3345a8; border-color: #3345a8; color: #ffffff; }
  .key-steps h3 { margin: 16px 0 8px; font-size: 1rem; }
  .key-steps ol { margin: 0; padding-left: 20px; font-size: 0.88rem; line-height: 1.7; color: #3b475e; }
  .key-steps code { padding: 1px 5px; border-radius: 4px; background: #eef1ff; color: #344694; }
  .key-credit { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid #b9c5f5; border-radius: 8px; background: #eef1ff; color: #26396d; font-size: 0.85rem; }
  .key-warning { margin: 6px 0 0; padding: 8px 10px; border: 1px solid #f0c98a; border-radius: 8px; background: #fff4e5; color: #8a4b00; font-size: 0.82rem; }
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

  @media (max-width: 760px) {
    .workspace { flex-direction: column; }
    .sidebar { position: static; width: 100%; flex: 1 1 auto; min-height: 0; }
    .sidebar-nav { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  }

  @media (max-width: 560px) {
    main { padding: 24px 14px; }
    .card { padding: 18px; }
    .field-grid { grid-template-columns: 1fr; }
    h1 { font-size: 1.65rem; }
  }
</style>