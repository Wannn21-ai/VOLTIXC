const CONFIG_ENDPOINT = "/api/mqtt-web-config";

function isValidConfig(config) {
  return config &&
    typeof config.host === "string" &&
    config.host.endsWith(".hivemq.cloud") &&
    Number(config.port) === 8884 &&
    config.path === "/mqtt" &&
    typeof config.deviceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(config.deviceId) &&
    typeof config.username === "string" && config.username.length > 0 &&
    typeof config.password === "string" && config.password.length > 0;
}

export async function loadMqttWebConfig(user) {
  if (typeof user?.getIdToken !== "function") {
    return null;
  }

  const idToken = await user.getIdToken();
  const response = await fetch(CONFIG_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${idToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`MQTT web config unavailable (${response.status})`);
  }

  const config = await response.json();
  if (!isValidConfig(config)) {
    throw new Error("MQTT web config response is invalid");
  }

  return Object.freeze({
    url: `wss://${config.host}:${config.port}${config.path}`,
    deviceId: config.deviceId,
    username: config.username,
    password: config.password,
    baseTopic: `voltix/${config.deviceId}`,
  });
}
