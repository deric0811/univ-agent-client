import { invoke } from "@tauri-apps/api/core";

const POLL_INTERVAL_MS = 2_000;
type JobQueryCommand = "get_job_status" | "get_job_result";

const JOB_STATUSES = [
  "PENDING",
  "RUNNING_STT",
  "POSTPROCESSING",
  "SUMMARIZING",
  "COMPLETED",
  "FAILED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface UploadJobResponse {
  job_id: string;
  status: "PENDING";
  waiting_count: number;
}

export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  waiting_count: number;
  error_message: string | null;
}

export interface JobResultResponse {
  job_id: string;
  status: "COMPLETED";
  content: string;
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("서버 응답 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function hasJobId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasWaitingCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseUploadResponse(json: string): UploadJobResponse {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("업로드 응답이 올바른 JSON이 아닙니다.");
  }
  const data = objectResponse(value);
  if (
    !hasJobId(data.job_id) ||
    data.status !== "PENDING" ||
    !hasWaitingCount(data.waiting_count)
  ) {
    throw new Error("업로드 응답에 유효한 작업 ID 또는 대기열 정보가 없습니다.");
  }
  return {
    job_id: data.job_id,
    status: data.status,
    waiting_count: data.waiting_count,
  };
}

function parseJobStatus(value: unknown, jobId: string): JobStatusResponse {
  const data = objectResponse(value);
  if (
    data.job_id !== jobId ||
    typeof data.status !== "string" ||
    !JOB_STATUSES.includes(data.status as JobStatus) ||
    !hasWaitingCount(data.waiting_count) ||
    !(data.error_message === null || typeof data.error_message === "string")
  ) {
    throw new Error("작업 상태 응답이 올바르지 않습니다.");
  }
  return {
    job_id: jobId,
    status: data.status as JobStatus,
    waiting_count: data.waiting_count,
    error_message: data.error_message,
  };
}

function parseJobResult(value: unknown, jobId: string): JobResultResponse {
  const data = objectResponse(value);
  if (
    data.job_id !== jobId ||
    data.status !== "COMPLETED" ||
    typeof data.content !== "string"
  ) {
    throw new Error("완료된 작업의 마크다운 응답이 올바르지 않습니다.");
  }
  return { job_id: jobId, status: "COMPLETED", content: data.content };
}

async function requestJson(
  command: JobQueryCommand,
  jobId: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let stopWaiting = () => {};

  try {
    const response = await new Promise<string>((resolve, reject) => {
      stopWaiting = () => reject(signal.reason);
      signal.addEventListener("abort", stopWaiting, { once: true });
      // IPC has no AbortSignal support. Stop waiting on teardown, consume late
      // responses/errors, and let Rust enforce the HTTP request timeout.
      invoke<string>(command, { jobId }).then(resolve, reject);
    });
    signal.throwIfAborted();
    return JSON.parse(response) as unknown;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SyntaxError) {
      throw new Error("서버가 올바른 JSON을 반환하지 않았습니다.");
    }
    // Result::Err(String) rejects invoke with a string, not an Error instance.
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    signal.removeEventListener("abort", stopWaiting);
  }
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollJobResult(
  jobId: string,
  onStatus: (job: JobStatusResponse) => void,
  signal: AbortSignal,
): Promise<JobResultResponse> {
  // Await each request before starting the timer: slow responses never overlap.
  while (true) {
    signal.throwIfAborted();
    const job = parseJobStatus(await requestJson("get_job_status", jobId, signal), jobId);
    signal.throwIfAborted();
    onStatus(job);

    if (job.status === "FAILED") {
      throw new Error(job.error_message || "서버에서 강의 분석에 실패했습니다.");
    }
    if (job.status === "COMPLETED") {
      const result = await requestJson("get_job_result", jobId, signal);
      signal.throwIfAborted();
      return parseJobResult(result, jobId);
    }
    await waitForNextPoll(signal);
  }
}
