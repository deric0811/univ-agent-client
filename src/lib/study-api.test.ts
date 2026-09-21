import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
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
const result = { job_id: jobId, status: "COMPLETED", content: "# 강의 요약\n\n핵심 내용" };
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
      job_id: jobId, status: "PENDING", waiting_count: 2,
    }))).toEqual({ job_id: jobId, status: "PENDING", waiting_count: 2 });
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"job_id":"","status":"PENDING","waiting_count":0}',
    '{"job_id":"id","status":"COMPLETED","waiting_count":0}',
    '{"job_id":"id","status":"PENDING","waiting_count":-1}',
  ])("rejects invalid upload data: %s", (response) => {
    expect(() => parseUploadResponse(response)).toThrow();
  });
});

describe("job polling through Rust IPC", () => {
  it("reports every stage at two-second intervals and requests the final result once", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("PENDING", 1)))
      .mockResolvedValueOnce(json(status("RUNNING_STT")))
      .mockResolvedValueOnce(json(status("POSTPROCESSING")))
      .mockResolvedValueOnce(json(status("SUMMARIZING")))
      .mockResolvedValueOnce(json(status("COMPLETED")))
      .mockResolvedValueOnce(json(result));
    const onStatus = vi.fn();
    const pending = pollJobResult(jobId, onStatus, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledWith(status("PENDING", 1));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus).toHaveBeenLastCalledWith(status("RUNNING_STT"));
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(pending).resolves.toEqual(result);
    expect(onStatus.mock.calls.map(([job]) => job.status)).toEqual([
      "PENDING", "RUNNING_STT", "POSTPROCESSING", "SUMMARIZING", "COMPLETED",
    ]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_status", { jobId }],
      ["get_job_result", { jobId }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops immediately on FAILED and exposes the server error", async () => {
    invokeMock.mockResolvedValueOnce(json({ ...status("FAILED"), error_message: "STT 처리 실패" }));
    const onStatus = vi.fn();
    await expect(pollJobResult(jobId, onStatus, new AbortController().signal))
      .rejects.toThrow("STT 처리 실패");
    expect(onStatus).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "Study job query failed (HTTP 404 Not Found): job not found",
    "Failed to query the study job: operation timed out",
  ])("propagates Rust HTTP/network errors: %s", async (error) => {
    invokeMock.mockRejectedValueOnce(error);
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow(error);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...status("PENDING"), job_id: "another-job" },
    { ...status("PENDING"), status: "UNKNOWN" },
    { ...status("PENDING"), waiting_count: "1" },
    { ...status("PENDING"), error_message: undefined },
  ])("rejects malformed status responses", async (response) => {
    invokeMock.mockResolvedValueOnce(json(response));
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("작업 상태 응답이 올바르지 않습니다");
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it.each(["status", "result"])("rejects non-JSON %s responses", async (stage) => {
    if (stage === "result") invokeMock.mockResolvedValueOnce(json(status("COMPLETED")));
    invokeMock.mockResolvedValueOnce("<html>upstream error</html>");
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("서버가 올바른 JSON을 반환하지 않았습니다");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed result responses", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("COMPLETED")))
      .mockResolvedValueOnce(json({ ...result, content: null }));
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("마크다운 응답이 올바르지 않습니다");
  });

  it("propagates a failed result command without restarting polling", async () => {
    invokeMock
      .mockResolvedValueOnce(json(status("COMPLETED")))
      .mockRejectedValueOnce("Study job query failed (HTTP 500): result unavailable");
    await expect(pollJobResult(jobId, vi.fn(), new AbortController().signal))
      .rejects.toThrow("result unavailable");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith("get_job_result", { jobId });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the original job ID to Rust for URL encoding", async () => {
    const specialId = "job/with spaces?";
    invokeMock
      .mockResolvedValueOnce(json({ ...status("COMPLETED"), job_id: specialId }))
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
    invokeMock.mockResolvedValueOnce(json(status("PENDING")));
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

    if (outcome === "resolve") resolveStatus(json(status("COMPLETED")));
    else rejectStatus("late network error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a final result received after teardown", async () => {
    let resolveResult!: (response: string) => void;
    invokeMock
      .mockResolvedValueOnce(json(status("COMPLETED")))
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
    resolveStatus(json(status("COMPLETED")));
    await expect(pending).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
