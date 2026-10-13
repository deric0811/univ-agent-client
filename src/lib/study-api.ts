import { invoke } from "@tauri-apps/api/core";

const POLL_INTERVAL_MS = 2_000;
const RETRY_DELAY_MS = 1_000;
const MAX_NETWORK_ATTEMPTS = 3;
type JobQueryCommand = "get_job_status" | "get_job_result";

const JOB_STATUSES = ["queued", "transcribing", "summarizing", "completed", "failed"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

// 백엔드가 대문자/레거시 상태명을 돌려줘도 같은 흐름으로 매핑한다.
const JOB_STATUS_ALIASES: Record<string, JobStatus> = {
  queued: "queued",
  pending: "queued",
  transcribing: "transcribing",
  running_stt: "transcribing",
  summarizing: "summarizing",
  postprocessing: "summarizing",
  completed: "completed",
  failed: "failed",
};

function normalizeJobStatus(value: unknown): JobStatus | null {
  if (typeof value !== "string") return null;
  return JOB_STATUS_ALIASES[value.trim().toLowerCase()] ?? null;
}

export interface UploadJobResponse {
  job_id: string;
  status: "queued";
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
  status: "completed";
  content: string;
  /** 서버가 함께 돌려주는 타임스탬프 목록(있으면 메타데이터에 보존한다). */
  timestamps: unknown[] | null;
}

/** 인증 토큰 만료/실패(HTTP 401·403)를 네트워크 오류와 구분한다. */
export class AuthExpiredError extends Error {
  constructor() {
    super("인증 토큰이 만료되었습니다. 설정을 확인하세요.");
    this.name = "AuthExpiredError";
  }
}

/** 최대 재시도 후에도 통신하지 못했을 때의 사용자 안내 오류. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("서버 응답 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("업로드 응답이 올바른 JSON이 아닙니다.");
  }
}

/** snake_case / camelCase 어느 쪽으로 와도 비어있지 않은 문자열을 찾아낸다. */
function readStringField(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** 대기열 정보 필드명이 달라도 음이 아닌 정수를 찾아낸다. */
function readCountField(data: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function hasWaitingCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthFailure(error: unknown): boolean {
  const message = describeError(error);
  return /HTTP\s*40[13]\b/.test(message) || message.includes("로그인이 필요합니다");
}

/**
 * 업로드 응답을 관대하게 해석한다. JSON 문자열/객체 모두 허용하고,
 * job_id/jobId 와 waiting_count/queue_position/queuePosition 을 모두 지원한다.
 * 유효한 jobId만 있으면 즉시 작업으로 승인한다.
 */
export function parseUploadResponse(data: unknown): UploadJobResponse {
  const value = typeof data === "string" ? parseJsonText(data) : data;
  const record = objectResponse(value);
  const jobId = readStringField(record, "jobId", "job_id");
  if (jobId === null) {
    throw new Error("업로드 응답에 유효한 작업 ID 또는 대기열 정보가 없습니다.");
  }
  const waitingCount =
    readCountField(
      record,
      "waiting_count",
      "waitingCount",
      "queue_position",
      "queuePosition",
    ) ?? 0;
  return { job_id: jobId, status: "queued", waiting_count: waitingCount };
}

function parseJobStatus(value: unknown, jobId: string): JobStatusResponse {
  const data = objectResponse(value);
  const responseJobId = readStringField(data, "jobId", "job_id");
  const status = normalizeJobStatus(data.status);
  if (
    responseJobId !== jobId ||
    status === null ||
    !hasWaitingCount(data.waiting_count) ||
    !(data.error_message === null || typeof data.error_message === "string")
  ) {
    throw new Error("작업 상태 응답이 올바르지 않습니다.");
  }
  return {
    job_id: jobId,
    status,
    waiting_count: data.waiting_count,
    error_message: data.error_message,
  };
}

function parseJobResult(value: unknown, jobId: string): JobResultResponse {
  const data = objectResponse(value);
  const responseJobId = readStringField(data, "jobId", "job_id");
  if (
    responseJobId !== jobId ||
    normalizeJobStatus(data.status) !== "completed" ||
    typeof data.content !== "string"
  ) {
    throw new Error("완료된 작업의 마크다운 응답이 올바르지 않습니다.");
  }
  return {
    job_id: jobId,
    status: "completed",
    content: data.content,
    timestamps: Array.isArray(data.timestamps) ? data.timestamps : null,
  };
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

function waitForRetry(signal: AbortSignal): Promise<void> {
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
    }, RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 인증 실패는 즉시 중단하고, 일시적 통신 오류만 최대 3회까지 재시도한다. */
async function requestWithRetry(
  command: JobQueryCommand,
  jobId: string,
  signal: AbortSignal,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await requestJson(command, jobId, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (isAuthFailure(error)) throw new AuthExpiredError();
      lastError = error;
      if (attempt < MAX_NETWORK_ATTEMPTS) await waitForRetry(signal);
    }
  }
  throw new NetworkError(
    `서버와 통신하지 못했습니다. 네트워크 상태를 확인한 뒤 [다시 시도]를 눌러 주세요. (${describeError(lastError)})`,
  );
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
    const job = parseJobStatus(await requestWithRetry("get_job_status", jobId, signal), jobId);
    signal.throwIfAborted();
    onStatus(job);

    if (job.status === "failed") {
      throw new Error(job.error_message || "서버에서 강의 분석에 실패했습니다.");
    }
    if (job.status === "completed") {
      const result = await requestWithRetry("get_job_result", jobId, signal);
      signal.throwIfAborted();
      return parseJobResult(result, jobId);
    }
    await waitForNextPoll(signal);
  }
}
