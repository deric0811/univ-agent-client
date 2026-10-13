export const SERVER_DOWN_MESSAGE = "서버가 점검 중이거나 꺼져 있습니다. 개발자에게 문의하세요.";

/** 연결 실패 또는 502/503/504 응답이면 true. */
export function isServerUnavailable(message: string): boolean {
  return (
    message.includes(SERVER_DOWN_MESSAGE) ||
    /HTTP\s*50[234]\b/.test(message) ||
    /error sending request|connection refused|timed out|연결하지 못했습니다/i.test(message)
  );
}
