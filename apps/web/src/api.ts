export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init
  });
  if (res.status === 401) {
    if (location.pathname !== "/login") location.href = "/login";
    throw new Error("未登录");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `请求失败: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
