function historyKey(session) {
  return session?.sessionId || session?.id || session?._key || "";
}

export function deletePathsForSession(session, activeDeviceId = "") {
  if (!session || session._source === "local") return [];

  const deviceId = session.deviceId || activeDeviceId;
  const key = historyKey(session);
  if (!deviceId || !key) return [];

  return [
    `devices/${deviceId}/history/${key}`,
    `devices/${deviceId}/completedSessions/${key}`,
  ];
}

export function deleteAllPathsForSessions(sessions, activeDeviceId = "") {
  const paths = new Set();
  sessions.forEach(session => {
    deletePathsForSession(session, activeDeviceId).forEach(path => paths.add(path));
  });
  return [...paths];
}

export async function deleteFirebasePaths(paths, deletePath) {
  console.log("[history] Delete attempted paths", paths);
  const results = await Promise.allSettled(paths.map(async path => {
    try {
      await deletePath(path);
      return path;
    } catch (error) {
      console.error("[history] Delete failed", {
        path,
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      throw error;
    }
  }));

  const failures = results
    .filter(result => result.status === "rejected")
    .map(result => result.reason);
  return {
    successCount: results.length - failures.length,
    failures,
    permissionDenied: failures.some(error => error?.code === "PERMISSION_DENIED" || error?.code === "permission-denied"),
  };
}
