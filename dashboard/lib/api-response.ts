// JSON is untrusted at the HTTP boundary, even for the local dashboard.
export async function readApiObject(response: Pick<Response, 'ok' | 'json'>, fallback = '요청을 처리하지 못했습니다.'): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok ? '서버 응답을 읽지 못했습니다.' : fallback);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(response.ok ? '서버 응답 형식이 올바르지 않습니다.' : fallback);
  }
  const data = payload as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === 'string' && data.error.trim() ? data.error : fallback);
  return data;
}
