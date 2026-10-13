import { invoke } from "@tauri-apps/api/core";

export interface StudyProjectMeta {
  project_id: string;
  title: string;
  created_at: string;
  video_path: string;
  course?: string;
  chapter?: string;
  /** 분석에 사용한 모델 ID */
  model?: string;
  /** 분석 모드: summary | quiz | easy_concept | cheatsheet */
  analysis_mode?: string;
  /** 다중 영상 프로젝트의 전체 영상 경로(입력 순서) */
  video_paths?: string[];
  /** 다중 영상 프로젝트의 영상별 재생시간(초, 입력 순서) */
  video_durations?: number[];
  /** 병합/단일 강의자료 PDF 경로 */
  pdf_path?: string;
  /** 업로드된 원본 강의자료 PDF 경로 목록 */
  pdf_paths?: string[];
  [key: string]: unknown;
}

export interface StudyProject {
  meta: StudyProjectMeta;
  markdown: string;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("서재 응답이 올바른 JSON이 아닙니다.");
  }
}

export function parseProjectMeta(value: unknown): StudyProjectMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("강의 메타데이터가 올바르지 않습니다.");
  }
  const meta = value as Record<string, unknown>;
  const videoPath = meta.video_path;
  if (
    typeof meta.project_id !== "string" || !meta.project_id.trim() ||
    typeof meta.title !== "string" || !meta.title.trim() ||
    typeof meta.created_at !== "string" ||
    // 문서 전용 강의는 video_path가 null/누락일 수 있다.
    !(videoPath === undefined || videoPath === null || typeof videoPath === "string")
  ) {
    throw new Error("강의 메타데이터의 필수 항목이 올바르지 않습니다.");
  }
  return {
    ...meta,
    video_path: typeof videoPath === "string" ? videoPath : "",
  } as StudyProjectMeta;
}

export async function listStudyProjects(): Promise<StudyProjectMeta[]> {
  const value = parseJson(await invoke<string>("list_study_projects"));
  if (!Array.isArray(value)) throw new Error("서재 목록이 올바르지 않습니다.");
  return value.map(parseProjectMeta);
}

export async function loadStudyProject(projectId: string): Promise<StudyProject> {
  const value = parseJson(await invoke<string>("load_study_project", { projectId }));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("강의 프로젝트 응답이 올바르지 않습니다.");
  }
  const project = value as Record<string, unknown>;
  const meta = parseProjectMeta(project.meta);
  if (meta.project_id !== projectId || typeof project.markdown !== "string") {
    throw new Error("요청한 강의의 요약을 불러오지 못했습니다.");
  }
  return { meta, markdown: project.markdown };
}

export async function deleteStudyProject(projectId: string): Promise<void> {
  await invoke("delete_study_project", { projectId });
}

export async function renameStudyProject(
  projectId: string,
  newTitle: string,
  course?: string,
  chapter?: string,
): Promise<void> {
  await invoke("rename_study_project", { projectId, newTitle, course, chapter });
}

export async function openProjectFolder(projectId: string): Promise<void> {
  await invoke("open_project_folder", { projectId });
}

export function videoFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || "제목 없는 강의";
}

/**
 * 서재에 저장된 강의들의 과목명을 공백 정리 후 중복 없이 모아 사전순으로 돌려준다.
 * 신규 강의 등록 시 기존 표기와 어긋나지 않도록 선택 목록으로 사용한다.
 */
export function uniqueCourseNames(projects: StudyProjectMeta[]): string[] {
  const names = new Set<string>();
  for (const project of projects) {
    const course = (project.course ?? "").trim();
    if (course) names.add(course);
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right, "ko"));
}

export function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "생성일 정보 없음" : date.toLocaleString("ko-KR");
}
