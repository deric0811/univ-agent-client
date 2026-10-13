import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listStudyProjects, loadStudyProject, parseProjectMeta, uniqueCourseNames, videoFilename, formatCreatedAt } from "./study-projects";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const meta = {
  project_id: "local-uuid", title: "자료구조", created_at: "2026-09-18T00:00:00Z",
  video_path: "/videos/자료구조.mp4", job_id: "remote-job",
};

beforeEach(() => { invokeMock.mockReset(); });

describe("project library IPC", () => {
  it("lists metadata from a JSON array", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify([meta]));
    await expect(listStudyProjects()).resolves.toEqual([meta]);
    expect(invokeMock).toHaveBeenCalledWith("list_study_projects");
  });

  it("handles an empty library", async () => {
    invokeMock.mockResolvedValueOnce("[]");
    await expect(listStudyProjects()).resolves.toEqual([]);
  });

  it.each(["not JSON", "null", "{}", '[{"project_id":"id"}]'])("rejects malformed libraries", async (json) => {
    invokeMock.mockResolvedValueOnce(json);
    await expect(listStudyProjects()).rejects.toThrow();
  });

  it("loads metadata and the unchanged Markdown", async () => {
    const project = { meta, markdown: "# 요약\n[03:25] 핵심 내용\n" };
    invokeMock.mockResolvedValueOnce(JSON.stringify(project));
    await expect(loadStudyProject(meta.project_id)).resolves.toEqual(project);
    expect(invokeMock).toHaveBeenCalledWith("load_study_project", { projectId: meta.project_id });
  });

  it.each([
    { meta: { ...meta, project_id: "another-project" }, markdown: "summary" },
    { meta, markdown: null },
  ])("rejects mismatched or incomplete project responses", async (project) => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(project));
    await expect(loadStudyProject(meta.project_id)).rejects.toThrow();
  });

  it("preserves native file errors", async () => {
    invokeMock.mockRejectedValueOnce("Failed to read summary.md");
    await expect(loadStudyProject(meta.project_id)).rejects.toBe("Failed to read summary.md");
  });
});

it("uses Unix and Windows video filenames as fallback titles", () => {
  expect(videoFilename("/videos/강의 1.mp4")).toBe("강의 1.mp4");
  expect(videoFilename("C:\\Videos\\Lecture.mkv")).toBe("Lecture.mkv");
  expect(videoFilename("")).toBe("제목 없는 강의");
});

it("handles missing legacy creation dates", () => {
  expect(formatCreatedAt("")).toBe("생성일 정보 없음");
});

it("accepts document-only metadata without a video path", () => {
  const parsed = parseProjectMeta({
    project_id: "doc-only",
    title: "문서 전용 강의",
    created_at: "2026-09-18T00:00:00Z",
    video_path: null,
    video_paths: [],
    video_durations: [],
    pdf_path: "/notes/slides.pdf",
    pdf_paths: ["/notes/slides.pdf"],
  });
  expect(parsed.video_path).toBe("");
  expect(parsed.video_paths).toEqual([]);
  expect(parsed.pdf_path).toBe("/notes/slides.pdf");
});

it("collects unique trimmed course names for autocomplete", () => {
  const projects = [
    { ...meta, project_id: "1", course: "클라우드 컴퓨팅" },
    { ...meta, project_id: "2", course: " cloudComputing " },
    { ...meta, project_id: "3", course: "클라우드 컴퓨팅" },
    { ...meta, project_id: "4" },
    { ...meta, project_id: "5", course: "   " },
    { ...meta, project_id: "6", course: "알고리즘" },
  ];
  expect(uniqueCourseNames(projects)).toEqual(["알고리즘", "클라우드 컴퓨팅", "cloudComputing"]);
  expect(uniqueCourseNames([])).toEqual([]);
});
