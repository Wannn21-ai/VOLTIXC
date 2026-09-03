export async function authenticatedApi(user, path, options = {}) {
  if (typeof user?.getIdToken !== "function") {
    throw new Error("Authentication is unavailable");
  }
  const token = await user.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Cloud API failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
