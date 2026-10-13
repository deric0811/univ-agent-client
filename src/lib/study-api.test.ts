import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  AuthExpiredError,
  parseUploadResponse,
  pollJobResult,
  type JobStatus,
  type JobStatusResponse,
} from "./study-api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const jobId = "lecture-job-1";
const json = (body: unknown) => JSON.stringify(body);
const status = (state: JobStatus, waitingCount = 0): JobStatusResponse => ({
  job_id: jobId,
  status: state,
  waiting_count: waitingCount,
  error_message: null,
});
const result = {
  job_id: jobId,
  status: "completed",
  content: "# 강의 요약\n\n핵심 내용",
  timestamps: [{ seconds: 205, label: "03:25" }],
};
const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upload response", () => {
  it("parses the Rust command's raw JSON", () => {
    expect(parseUploadResponse(json({
      job_id: jobId, status: "queued", waiting_count: 2,
    }))).toEqual({ job_id: jobId, status: "queued", waiting_count: 2 });
  });

  it("accepts the minimal backend response and keeps polling", async () => {
    const parsed = parseUploadResponse(json({ job_id: jobId, status: "queued" }));
    expect(parsed).toEqual({ job_id: jobId, status: "queued", waiting_count: 0 });

    invokeMock
      .mockResolvedValueOnce(json(status("completed")))
      .mockResolvedValueOnce(json(result));
    const onStatus = vi.fn();
    const pending = pollJobResult(parsed.job_id, onStatus, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("get_job_status", { jobId: parsed.job_id });
  });

  it("accepts camelCase aliases and object payloads", () => {
    expect(parseUploadResponse({ jobId: "uuid-camel", queuePosition: 3 })).toEqual({
      job_id: "uuid-camel", status: "queued", waiting_count: 3,
    });
    expect(parseUploadResponse({ job_id: "snake", queue_position: 1 })).toEqual({
      job_id: "snake", status: "queued", waiting_count: 1,
    });
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"job_id":""}',
    '{"jobId":"   "}',
    '{"job_id":123}',
  ])("rejects upload data without a usable job id: %s", (response) => {
    expect(() => parseUploadResponse(response)).toThrow();
  });
});

describe("job polling through Rust IPC", () => {
  it("reports every stage at two-second intervals and requests the final result once", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("queued", 1)))
      .mockResolvedValueOnce(json(status("transcribing")))
      .mockResolvedValueOnce(json(status("summarizing")))
      .mockResolvedValueOnce(json(status("completed")))
      .mockResolvedValueOnce(json(result));
    const onStatus = vi.fn();
    const pending = pollJobResult(jobId, onStatus, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledWith(status("queued", 1));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus).toHaveBeenLastCalledWith(status("transcribing"));
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(pending).resolves.toEqual(result);
    expect(onStatus.mock.calls.map(([job]) => job.status)).toEqual([
      "queued", "transcribing", "summarizing", "completed",
    ]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_result", { jobId }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes legacy uppercase statuses during polling", async () => {
    invokeMock
      .mockResolvedValueOnce(json({ ...status("queued"), status: "RUNNING_STT" }))
      .mockResolvedValueOnce(json({ ...status("queued"), status: "COMPLETED" }))
      .mockResolvedValueOnce(json({ ...result, status: "COMPLETED" }));
    const onStatus = vi.fn();
    const pending = pollJobResult(jobId, onStatus, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(status("transcribing"));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(result);
  });

  it("stops immediately on failed and exposes the server error", async () => {
    invokeMock.mockResolvedValueOnce(json({ ...status("failed"), error_message: "STT 처리 실패" }));
    const onStatus = vi.fn();
    await expect(pollJobResult(jobId, onStatus, new AbortController().signal))
      .rejects.toThrow("STT 처리 실패");
    expect(onStatus).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops immediately on an expired token without retrying", async () => {
    invokeMock.mockRejectedValue("Study job query failed (HTTP 401 Unauthorized): token expired");
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toBeInstanceOf(AuthExpiredError);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a missing login as an auth failure", async () => {
    invokeMock.mockRejectedValue("로그인이 필요합니다.");
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toBeInstanceOf(AuthExpiredError);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("retries transient network errors up to three attempts, then reports", async () => {
    invokeMock.mockRejectedValue("Failed to query the study job: connection refused");
    const onStatus = vi.fn();
    const pending = pollJobResult(jobId, onStatus, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("서버와 통신하지 못했습니다");

    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invokeMock).toHaveBeenCalledTimes(3);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries the final result command before giving up", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("completed")))
      .mockRejectedValue("Study job query failed (HTTP 500): result unavailable");
    const pending = pollJobResult(jobId, vi.fn(), new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("서버와 통신하지 못했습니다");
    await vi.advanceTimersByTimeAsync(0);
    // status(1) + result retries(3) with two 1s delays.
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_job_result")).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...status("queued"), job_id: "another-job" },
    { ...status("queued"), status: "UNKNOWN" },
    { ...status("queued"), waiting_count: "1" },
    { ...status("queued"), error_message: undefined },
  ])("rejects malformed status responses", async (response) => {
    invokeMock.mockResolvedValueOnce(json(response));
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("작업 상태 응답이 올바르지 않습니다");
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it.each(["status", "result"])("rejects non-JSON %s responses", async (stage) => {
    if (stage === "result") invokeMock.mockResolvedValueOnce(json(status("completed")));
    invokeMock.mockResolvedValue("<html>upstream error</html>");
    const pending = pollJobResult(jobId, vi.fn(), new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("서버가 올바른 JSON을 반환하지 않았습니다");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed result responses", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("completed")))
      .mockResolvedValueOnce(json({ ...result, content: null }));
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("마크다운 응답이 올바르지 않습니다");
  });

  it("passes the original job ID to Rust for URL encoding", async () => {
    const specialId = "job/with spaces?";
    invokeMock
      .mockResolvedValueOnce(json({ ...status("completed"), job_id: specialId }))
      .mockResolvedValueOnce(json({ ...result, job_id: specialId }));
    await pollJobResult(specialId, vi.fn(), new AbortController().signal);
    expect(invokeMock.mock.calls).toEqual([
      ["get_job_status", { jobId: specialId }],
      ["get_job_result", { jobId: specialId }],
    ]);
  });

  it("does not invoke a command if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pollJobResult(jobId, vi.fn(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cancels the polling timer on teardown", async () => {
    invokeMock.mockResolvedValueOnce(json(status("queued")));
    const controller = new AbortController();
    const pending = pollJobResult(jobId, vi.fn(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending retry delay on teardown", async () => {
    invokeMock.mockRejectedValue("Failed to query the study job: connection refused");
    const controller = new AbortController();
    const pending = pollJobResult(jobId, vi.fn(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledOnce();
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"])("ignores a late IPC %s after teardown", async (outcome) => {
    let resolveStatus!: (response: string) => void;
    let rejectStatus!: (error: string) => void;
    invokeMock.mockImplementationOnce(() => new Promise<string>((resolve, reject) => {
      resolveStatus = resolve;
      rejectStatus = reject;
    }));
    const controller = new AbortController();
    const onStatus = vi.fn();
    const pending = pollJobResult(jobId, onStatus, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    if (outcome === "resolve") resolveStatus(json(status("completed")));
    else rejectStatus("late network error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a final result received after teardown", async () => {
    let resolveResult!: (response: string) => void;
    invokeMock
      .mockResolvedValueOnce(json(status("completed")))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveResult = resolve; }));
    const controller = new AbortController();
    const pending = pollJobResult(jobId, vi.fn(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenLastCalledWith("get_job_result", { jobId });
    controller.abort();
    await rejected;
    resolveResult(json(result));
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps slow status commands", async () => {
    let resolveStatus!: (response: string) => void;
    invokeMock
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveStatus = resolve; }))
      .mockResolvedValueOnce(json(result));
    const pending = pollJobResult(jobId, vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invokeMock).toHaveBeenCalledOnce();
    resolveStatus(json(status("completed")));
    await expect(pending).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
