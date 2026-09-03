"use strict";

const mqtt = require("mqtt");

const HOST = "ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud";
const PORT = 8883;
let client;
let connectPromise;

function requiredCredentials(env = process.env) {
  const username = env.MQTT_SERVICE_USERNAME?.trim();
  const password = env.MQTT_SERVICE_PASSWORD;
  if (!username || !password) throw new Error("MQTT service credentials are unavailable");
  return { username, password };
}

function getClient(env = process.env) {
  if (client?.connected) return Promise.resolve(client);
  if (connectPromise) return connectPromise;

  const credentials = requiredCredentials(env);
  client = mqtt.connect(`mqtts://${HOST}:${PORT}`, {
    ...credentials,
    clientId: `voltix-api-${process.pid}-${Date.now().toString(36)}`,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    connectTimeout: 10000,
    reconnectPeriod: 0,
  });

  connectPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MQTT connection timeout")), 10000);
    client.once("connect", () => {
      clearTimeout(timer);
      connectPromise = null;
      resolve(client);
    });
    client.once("error", error => {
      clearTimeout(timer);
      connectPromise = null;
      client?.end(true);
      client = null;
      reject(error);
    });
  });
  return connectPromise;
}

async function publishJson(topic, payload, options = {}, dependencies = {}) {
  const mqttClient = dependencies.client || await getClient(dependencies.env || process.env);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 8192) throw new Error("MQTT payload is too large");
  await new Promise((resolve, reject) => {
    mqttClient.publish(topic, body, {
      qos: options.qos ?? 1,
      retain: options.retain === true,
    }, error => error ? reject(error) : resolve());
  });
}

module.exports = { HOST, PORT, getClient, publishJson, requiredCredentials };
