import { invoke } from "@tauri-apps/api/core";

export interface StudyProjectMeta {
  project_id: string;
  title: string;
  created_at: string;
  video_path: string;
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
  if (
    typeof meta.project_id !== "string" || !meta.project_id.trim() ||
    typeof meta.title !== "string" || !meta.title.trim() ||
    typeof meta.created_at !== "string" || typeof meta.video_path !== "string"
  ) {
    throw new Error("강의 메타데이터의 필수 항목이 올바르지 않습니다.");
  }
  return meta as StudyProjectMeta;
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

export function videoFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || "제목 없는 강의";
}

export function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "생성일 정보 없음" : date.toLocaleString("ko-KR");
}
