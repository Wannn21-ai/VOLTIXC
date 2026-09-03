#include "mqtt_manager.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_err.h>
#include <mqtt_client.h>

#include <string.h>

#include "mqtt_config.h"

namespace {

esp_mqtt_client_handle_t mqttClient = nullptr;
volatile bool mqttIsConnected = false;
bool mqttInitialized = false;
bool mqttStarted = false;
unsigned long nextStartAttemptMs = 0;

MqttCommandHandler commandHandler = nullptr;
MqttConfigHandler configHandler = nullptr;
MqttHistoryAckHandler historyAckHandler = nullptr;
MqttHistoryCleanupHandler historyCleanupHandler = nullptr;

char inboundPayload[MqttConfig::MAX_INBOUND_PAYLOAD_BYTES + 1];
char inboundTopic[96];
size_t inboundReceivedBytes = 0;
size_t inboundExpectedBytes = 0;
bool inboundRejected = false;

bool hasText(const char* value) {
  return value != nullptr && value[0] != '\0';
}

bool topicEquals(const char* topic, const char* expected) {
  return topic != nullptr && expected != nullptr && strcmp(topic, expected) == 0;
}

const char* commandName(MqttCommandType type) {
  switch (type) {
    case MqttCommandType::START: return "start";
    case MqttCommandType::STOP: return "stop";
    case MqttCommandType::RELAY: return "relay";
    case MqttCommandType::RESET: return "reset";
  }
  return "unknown";
}

template <size_t Capacity>
bool enqueueJson(
  const char* topic,
  StaticJsonDocument<Capacity>& document,
  int qos,
  bool retain
) {
  if (!mqttIsConnected || mqttClient == nullptr) {
    return false;
  }

  char payload[Capacity];
  const size_t length = serializeJson(document, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload)) {
    Serial.print("[mqtt] JSON payload too large topic=");
    Serial.println(topic);
    return false;
  }

  const int messageId = esp_mqtt_client_enqueue(
    mqttClient,
    topic,
    payload,
    static_cast<int>(length),
    qos,
    retain ? 1 : 0,
    qos > 0
  );
  return messageId >= 0;
}

bool enqueuePayload(const char* topic, const char* payload, size_t length, int qos, bool retain) {
  if (!mqttIsConnected || mqttClient == nullptr || payload == nullptr || length == 0) {
    return false;
  }
  const int messageId = esp_mqtt_client_enqueue(
    mqttClient,
    topic,
    payload,
    static_cast<int>(length),
    qos,
    retain ? 1 : 0,
    qos > 0
  );
  return messageId >= 0;
}

bool publishAvailability(bool online) {
  StaticJsonDocument<64> document;
  document["online"] = online;
  return enqueueJson(MqttConfig::TOPIC_STATUS, document, 1, true);
}

void dispatchCommand(const char* payload, size_t length) {
  StaticJsonDocument<768> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  if (error || !document.is<JsonObject>()) {
    Serial.print("[mqtt] Rejected invalid command JSON: ");
    Serial.println(error ? error.c_str() : "object required");
    return;
  }

  const char* commandText = document["command"] | nullptr;
  if (!hasText(commandText)) {
    Serial.println("[mqtt] Rejected command without command field");
    return;
  }

  MqttCommand command{};
  if (strcmp(commandText, "start") == 0) {
    command.type = MqttCommandType::START;
  } else if (strcmp(commandText, "stop") == 0) {
    command.type = MqttCommandType::STOP;
  } else if (strcmp(commandText, "relay") == 0) {
    command.type = MqttCommandType::RELAY;
    if (document["value"].is<bool>()) {
      command.hasRelayValue = true;
      command.relayValue = document["value"].as<bool>();
    }
  } else if (strcmp(commandText, "reset") == 0) {
    command.type = MqttCommandType::RESET;
  } else {
    Serial.print("[mqtt] Rejected unsupported command: ");
    Serial.println(commandText);
    return;
  }

  strlcpy(command.id, document["id"] | "", sizeof(command.id));
  strlcpy(command.uid, document["uid"] | "", sizeof(command.uid));
  strlcpy(command.sessionId, document["sessionId"] | "", sizeof(command.sessionId));
  strlcpy(command.deviceName, document["deviceName"] | "", sizeof(command.deviceName));
  command.issuedAt = document["issuedAt"] | 0ULL;
  command.expiresAt = document["expiresAt"] | 0ULL;
  if (document["tariff"].is<float>()) {
    command.hasTariff = true;
    command.tariff = document["tariff"].as<float>();
  }
  if (document["overloadThreshold"].is<float>()) {
    command.hasOverloadThreshold = true;
    command.overloadThreshold = document["overloadThreshold"].as<float>();
  }
  if (document["loadPowerThreshold"].is<float>()) {
    command.hasLoadPowerThreshold = true;
    command.loadPowerThreshold = document["loadPowerThreshold"].as<float>();
  }
  if (document["loadCurrentThreshold"].is<float>()) {
    command.hasLoadCurrentThreshold = true;
    command.loadCurrentThreshold = document["loadCurrentThreshold"].as<float>();
  }

  if (commandHandler != nullptr) {
    commandHandler(command);
    return;
  }

  Serial.print("[mqtt] Command parsed but not connected to system logic: ");
  Serial.println(commandName(command.type));
}

void dispatchHistoryAck(const char* payload, size_t length) {
  StaticJsonDocument<192> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  const char* sessionId = document["sessionId"] | "";
  if (error || sessionId[0] == '\0' || !document["stored"].is<bool>()) {
    Serial.println("[mqtt] Rejected invalid history ACK");
    return;
  }
  if (historyAckHandler != nullptr) {
    historyAckHandler(sessionId, document["stored"].as<bool>());
  }
}

void dispatchConfig(const char* payload, size_t length) {
  StaticJsonDocument<512> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  if (error || !document.is<JsonObject>()) {
    Serial.print("[mqtt] Rejected invalid config JSON: ");
    Serial.println(error ? error.c_str() : "object required");
    return;
  }

  if (configHandler != nullptr) {
    configHandler(payload, length);
    return;
  }

  Serial.println("[mqtt] Config parsed but not connected to system settings");
}

void dispatchHistoryCleanup(const char* payload, size_t length) {
  if (historyCleanupHandler != nullptr) {
    historyCleanupHandler(payload, length);
  }
}

void dispatchInboundMessage() {
  if (topicEquals(inboundTopic, MqttConfig::TOPIC_COMMAND)) {
    dispatchCommand(inboundPayload, inboundExpectedBytes);
  } else if (topicEquals(inboundTopic, MqttConfig::TOPIC_CONFIG)) {
    dispatchConfig(inboundPayload, inboundExpectedBytes);
  } else if (topicEquals(inboundTopic, MqttConfig::TOPIC_HISTORY_ACK)) {
    dispatchHistoryAck(inboundPayload, inboundExpectedBytes);
  } else if (topicEquals(inboundTopic, MqttConfig::TOPIC_HISTORY_CLEANUP)) {
    dispatchHistoryCleanup(inboundPayload, inboundExpectedBytes);
  } else {
    Serial.print("[mqtt] Ignored unexpected topic: ");
    Serial.println(inboundTopic);
  }
}

void receiveMqttData(esp_mqtt_event_handle_t event) {
  if (event == nullptr || event->total_data_len < 0 || event->data_len < 0) {
    return;
  }

  if (event->current_data_offset == 0) {
    inboundReceivedBytes = 0;
    inboundExpectedBytes = static_cast<size_t>(event->total_data_len);
    inboundRejected =
      inboundExpectedBytes > MqttConfig::MAX_INBOUND_PAYLOAD_BYTES ||
      event->topic == nullptr ||
      event->topic_len <= 0 ||
      static_cast<size_t>(event->topic_len) >= sizeof(inboundTopic);

    if (inboundRejected) {
      Serial.println("[mqtt] Rejected inbound message: topic or payload too large");
      return;
    }

    memcpy(inboundTopic, event->topic, static_cast<size_t>(event->topic_len));
    inboundTopic[event->topic_len] = '\0';
  }

  if (inboundRejected) {
    return;
  }

  const size_t offset = static_cast<size_t>(event->current_data_offset);
  const size_t chunkLength = static_cast<size_t>(event->data_len);
  if (offset != inboundReceivedBytes || offset + chunkLength > inboundExpectedBytes) {
    inboundRejected = true;
    Serial.println("[mqtt] Rejected malformed fragmented message");
    return;
  }

  if (chunkLength > 0 && event->data != nullptr) {
    memcpy(inboundPayload + offset, event->data, chunkLength);
  }
  inboundReceivedBytes += chunkLength;

  if (inboundReceivedBytes == inboundExpectedBytes) {
    inboundPayload[inboundExpectedBytes] = '\0';
    dispatchInboundMessage();
  }
}

void handleMqttEvent(
  void*,
  esp_event_base_t,
  int32_t eventId,
  void* eventData
) {
  esp_mqtt_event_handle_t event = static_cast<esp_mqtt_event_handle_t>(eventData);

  switch (static_cast<esp_mqtt_event_id_t>(eventId)) {
    case MQTT_EVENT_CONNECTED:
      mqttIsConnected = true;
      Serial.println("[mqtt] Connected to HiveMQ Cloud");
      esp_mqtt_client_subscribe(mqttClient, MqttConfig::TOPIC_COMMAND, 1);
      esp_mqtt_client_subscribe(mqttClient, MqttConfig::TOPIC_CONFIG, 1);
      esp_mqtt_client_subscribe(mqttClient, MqttConfig::TOPIC_HISTORY_ACK, 1);
      esp_mqtt_client_subscribe(mqttClient, MqttConfig::TOPIC_HISTORY_CLEANUP, 1);
      publishAvailability(true);
      break;

    case MQTT_EVENT_DISCONNECTED:
      mqttIsConnected = false;
      Serial.println("[mqtt] Disconnected; background reconnect remains active");
      break;

    case MQTT_EVENT_DATA:
      receiveMqttData(event);
      break;

    case MQTT_EVENT_ERROR:
      mqttIsConnected = false;
      Serial.println("[mqtt] Transport/TLS error; local operation continues");
      break;

    default:
      break;
  }
}

}  // namespace

void mqttBegin() {
  if (mqttInitialized) {
    return;
  }

  if (!hasText(MqttConfig::USERNAME) || !hasText(MqttConfig::PASSWORD)) {
    Serial.println("[mqtt] Disabled: configure MQTT username/password in credentials.h");
    return;
  }

  if (!hasText(MqttConfig::ROOT_CA)) {
    Serial.println("[mqtt] Disabled: configure the HiveMQ TLS root CA in credentials.h");
    return;
  }

  esp_mqtt_client_config_t config{};
  config.host = MqttConfig::HOST;
  config.port = MqttConfig::PORT;
  config.transport = MQTT_TRANSPORT_OVER_SSL;
  config.client_id = MqttConfig::CLIENT_ID;
  config.username = MqttConfig::USERNAME;
  config.password = MqttConfig::PASSWORD;
  config.cert_pem = MqttConfig::ROOT_CA;
  config.skip_cert_common_name_check = false;
  config.lwt_topic = MqttConfig::TOPIC_STATUS;
  config.lwt_msg = MqttConfig::OFFLINE_WILL_PAYLOAD;
  config.lwt_qos = 1;
  config.lwt_retain = 1;
  config.keepalive = MqttConfig::KEEP_ALIVE_SECONDS;
  config.reconnect_timeout_ms = MqttConfig::RECONNECT_INTERVAL_MS;
  config.network_timeout_ms = MqttConfig::NETWORK_TIMEOUT_MS;
  config.disable_auto_reconnect = false;

  mqttClient = esp_mqtt_client_init(&config);
  if (mqttClient == nullptr) {
    Serial.println("[mqtt] Initialization failed; local operation continues");
    nextStartAttemptMs = millis() + MqttConfig::RECONNECT_INTERVAL_MS;
    return;
  }

  const esp_err_t registerResult = esp_mqtt_client_register_event(
    mqttClient,
    MQTT_EVENT_ANY,
    handleMqttEvent,
    nullptr
  );
  if (registerResult != ESP_OK) {
    Serial.print("[mqtt] Event registration failed code=");
    Serial.println(static_cast<int>(registerResult));
    esp_mqtt_client_destroy(mqttClient);
    mqttClient = nullptr;
    nextStartAttemptMs = millis() + MqttConfig::RECONNECT_INTERVAL_MS;
    return;
  }

  mqttInitialized = true;
  Serial.println("[mqtt] Initialized; waiting for WiFi");
}

void mqttLoop() {
  if (!mqttInitialized || mqttStarted || WiFi.status() != WL_CONNECTED) {
    return;
  }

  const unsigned long now = millis();
  if (static_cast<long>(now - nextStartAttemptMs) < 0) {
    return;
  }

  const esp_err_t startResult = esp_mqtt_client_start(mqttClient);
  if (startResult == ESP_OK) {
    mqttStarted = true;
    Serial.println("[mqtt] Background connection started");
    return;
  }

  nextStartAttemptMs = now + MqttConfig::RECONNECT_INTERVAL_MS;
  Serial.print("[mqtt] Start failed code=");
  Serial.println(static_cast<int>(startResult));
}

bool mqttConnected() {
  return mqttIsConnected;
}

void mqttSetCommandHandler(MqttCommandHandler handler) {
  commandHandler = handler;
}

void mqttSetConfigHandler(MqttConfigHandler handler) {
  configHandler = handler;
}

void mqttSetHistoryAckHandler(MqttHistoryAckHandler handler) {
  historyAckHandler = handler;
}

void mqttSetHistoryCleanupHandler(MqttHistoryCleanupHandler handler) {
  historyCleanupHandler = handler;
}

bool mqttPublishStatus(bool online, const char* mode, bool relayOn) {
  const MqttStatusMessage message{
    online,
    mode,
    relayOn,
    nullptr,
    false,
    false,
    false
  };
  return mqttPublishStatus(message);
}

bool mqttPublishStatus(const MqttStatusMessage& message) {
  StaticJsonDocument<256> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["online"] = message.online;
  if (hasText(message.mode)) {
    document["mode"] = message.mode;
  }
  document["relay"] = message.relayOn;
  if (hasText(message.sessionState)) {
    document["sessionState"] = message.sessionState;
  }
  document["sessionActive"] = message.sessionActive;
  document["sensorValid"] = message.sensorValid;
  document["loadDetected"] = message.loadDetected;
  document["uptimeMs"] = millis();
  return enqueueJson(MqttConfig::TOPIC_STATUS, document, 1, true);
}

bool mqttPublishTelemetry(
  float voltage,
  float current,
  float power,
  float energy,
  float frequency,
  float powerFactor
) {
  const MqttTelemetryMessage message{
    voltage,
    current,
    power,
    energy,
    frequency,
    powerFactor,
    voltage * current,
    0.0f,
    0,
    true,
    false,
    false
  };
  return mqttPublishTelemetry(message);
}

bool mqttPublishTelemetry(const MqttTelemetryMessage& message) {
  StaticJsonDocument<384> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["voltage"] = message.voltage;
  document["current"] = message.current;
  document["power"] = message.power;
  document["energy"] = message.energy;
  document["frequency"] = message.frequency;
  document["powerFactor"] = message.powerFactor;
  document["apparentPower"] = message.apparentPower;
  document["cost"] = message.cost;
  document["duration"] = message.durationSeconds;
  document["valid"] = message.valid;
  document["loadDetected"] = message.loadDetected;
  document["overload"] = message.overload;
  document["uptimeMs"] = millis();
  return enqueueJson(MqttConfig::TOPIC_TELEMETRY, document, 0, false);
}

bool mqttPublishSession(
  bool active,
  const char* sessionId,
  const char* mode,
  unsigned long durationSeconds,
  float energyKwh
) {
  const MqttSessionMessage message{
    active,
    sessionId,
    nullptr,
    nullptr,
    mode,
    nullptr,
    nullptr,
    durationSeconds,
    energyKwh * 1000.0f,
    energyKwh,
    0.0f
  };
  return mqttPublishSession(message);
}

bool mqttPublishSession(const MqttSessionMessage& message) {
  StaticJsonDocument<512> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["active"] = message.active;
  if (hasText(message.sessionId)) {
    document["sessionId"] = message.sessionId;
  }
  if (hasText(message.uid)) {
    document["uid"] = message.uid;
  }
  if (hasText(message.deviceName)) {
    document["deviceName"] = message.deviceName;
  }
  if (hasText(message.mode)) {
    document["mode"] = message.mode;
  }
  if (hasText(message.state)) {
    document["sessionState"] = message.state;
  }
  if (hasText(message.endReason)) {
    document["endReason"] = message.endReason;
  }
  document["duration"] = message.durationSeconds;
  document["energyWh"] = message.energyWh;
  document["energy"] = message.energyKwh;
  document["cost"] = message.cost;
  document["uptimeMs"] = millis();
  return enqueueJson(MqttConfig::TOPIC_SESSION, document, 1, false);
}

bool mqttPublishEvent(
  const char* type,
  const char* sessionId,
  bool includePower,
  float power
) {
  if (!hasText(type)) {
    return false;
  }

  StaticJsonDocument<192> document;
  document["type"] = type;
  if (hasText(sessionId)) {
    document["sessionId"] = sessionId;
  }
  if (includePower) {
    document["power"] = power;
  }
  return enqueueJson(MqttConfig::TOPIC_EVENT, document, 1, false);
}

bool mqttPublishCommandAck(
  const char* id,
  const char* command,
  const char* status,
  const char* message,
  const char* reason
) {
  if (!hasText(id) || !hasText(command) || !hasText(status)) return false;
  StaticJsonDocument<384> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["id"] = id;
  document["command"] = command;
  document["status"] = status;
  document["message"] = hasText(message) ? message : "Command processed";
  if (hasText(reason)) document["reason"] = reason;
  document["processedAtUptimeMs"] = millis();
  return enqueueJson(MqttConfig::TOPIC_COMMAND_ACK, document, 1, false);
}

bool mqttPublishHistoryJson(const char* json, size_t length) {
  if (length > 16384) {
    Serial.println("[mqtt] History payload too large");
    return false;
  }
  return enqueuePayload(MqttConfig::TOPIC_HISTORY, json, length, 1, false);
}

bool mqttPublishHistoryCleanupAck(
  const char* requestId,
  const char* status,
  int deleted
) {
  if (!hasText(requestId) || !hasText(status)) return false;
  StaticJsonDocument<256> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["requestId"] = requestId;
  document["status"] = status;
  document["deleted"] = deleted;
  return enqueueJson(MqttConfig::TOPIC_HISTORY_CLEANUP_ACK, document, 1, false);
}

bool mqttPublishConfigStateJson(const char* json, size_t length) {
  if (length > MqttConfig::MAX_INBOUND_PAYLOAD_BYTES) {
    Serial.println("[mqtt] Config state payload too large");
    return false;
  }
  return enqueuePayload(MqttConfig::TOPIC_CONFIG_STATE, json, length, 1, true);
}
