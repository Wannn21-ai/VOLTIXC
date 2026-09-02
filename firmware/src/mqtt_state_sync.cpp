#include "mqtt_state_sync.h"

#include <Arduino.h>
#include <string.h>

#include "mqtt_manager.h"
#include "relay.h"
#include "session.h"
#include "state.h"

namespace {

static constexpr unsigned long TELEMETRY_INTERVAL_MS = 1000UL;
static constexpr unsigned long SESSION_INTERVAL_MS = 1000UL;
static constexpr unsigned long STATUS_INTERVAL_MS = 5000UL;

unsigned long lastTelemetryMs = 0;
unsigned long lastSessionMs = 0;
unsigned long lastStatusMs = 0;
bool wasConnected = false;
SystemMode previousMode = SystemMode::BOOT;
SessionState previousSessionState = SessionState::IDLE;
bool previousRelayOn = false;
char previousSessionId[sizeof(sessionData.sessionId)] = "";

bool sessionActiveForLive(SessionState state) {
  return state != SessionState::IDLE && state != SessionState::FINISHED;
}

bool electricalReadingsActive() {
  return relayIsOn() &&
    sessionData.state != SessionState::IDLE &&
    sessionData.state != SessionState::FINISHED;
}

void publishStatusSnapshot() {
  const MqttStatusMessage message{
    true,
    systemModeToString(systemMode),
    relayIsOn(),
    sessionStateToString(sessionData.state),
    sessionActiveForLive(sessionData.state),
    sensorData.valid,
    sensorData.loadDetected
  };
  mqttPublishStatus(message);
}

void publishTelemetrySnapshot() {
  const bool electricalActive = electricalReadingsActive();
  const MqttTelemetryMessage message{
    sensorData.voltage,
    electricalActive ? sensorData.current : 0.0f,
    electricalActive ? sensorData.power : 0.0f,
    sensorData.energy,
    sensorData.frequency,
    sensorData.powerFactor,
    electricalActive ? sensorData.voltage * sensorData.current : 0.0f,
    sessionData.cost,
    sessionData.durationMs / 1000UL,
    sensorData.valid,
    electricalActive && sensorData.loadDetected,
    sessionData.state == SessionState::OVERLOAD
  };
  mqttPublishTelemetry(message);
}

void publishSessionSnapshot() {
  const MqttSessionMessage message{
    sessionActiveForLive(sessionData.state),
    sessionData.sessionId,
    sessionData.uid,
    sessionData.deviceName,
    systemModeToString(systemMode),
    sessionStateToString(sessionData.state),
    endReasonToString(sessionData.endReason),
    sessionData.durationMs / 1000UL,
    sessionData.energyWh,
    sessionData.energyKwh,
    sessionData.cost
  };
  mqttPublishSession(message);
}

const char* eventTypeForFinishedSession() {
  switch (sessionData.endReason) {
    case EndReason::USER_STOP: return "user_stop";
    case EndReason::LOAD_REMOVED: return "load_removed";
    case EndReason::LOAD_REMOVED_AFTER_POWER_LOSS:
    case EndReason::POWER_LOSS_RECOVERY:
      return "power_loss";
    case EndReason::OVERLOAD: return "overload";
    case EndReason::NO_LOAD_DETECTED: return "no_load_detected";
    case EndReason::NONE: return "session_ended";
  }
  return "session_ended";
}

void publishTransitionEvent(SessionState from, SessionState to) {
  if (to == SessionState::MONITORING && from != SessionState::MONITORING) {
    mqttPublishEvent("session_started", sessionData.sessionId);
    return;
  }
  if (to == SessionState::OVERLOAD && from != SessionState::OVERLOAD) {
    mqttPublishEvent("overload", sessionData.sessionId, true, sensorData.power);
    return;
  }
  if (to == SessionState::FINISHED && from != SessionState::FINISHED) {
    mqttPublishEvent(
      eventTypeForFinishedSession(),
      sessionData.sessionId,
      sessionData.endReason == EndReason::OVERLOAD,
      sensorData.power
    );
  }
}

void rememberObservedState() {
  previousMode = systemMode;
  previousSessionState = sessionData.state;
  previousRelayOn = relayIsOn();
  strlcpy(previousSessionId, sessionData.sessionId, sizeof(previousSessionId));
}

}  // namespace

void mqttStateSyncBegin() {
  rememberObservedState();
}

void mqttStateSyncUpdate() {
  const bool connected = mqttConnected();
  const bool connectionRestored = connected && !wasConnected;
  const bool stateChanged =
    previousMode != systemMode ||
    previousSessionState != sessionData.state ||
    previousRelayOn != relayIsOn() ||
    strcmp(previousSessionId, sessionData.sessionId) != 0;

  if (!connected) {
    wasConnected = false;
    rememberObservedState();
    return;
  }

  if (previousSessionState != sessionData.state && !connectionRestored) {
    publishTransitionEvent(previousSessionState, sessionData.state);
  }

  const unsigned long now = millis();
  if (connectionRestored || stateChanged || now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    publishStatusSnapshot();
  }
  if (connectionRestored || now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    publishTelemetrySnapshot();
  }
  if (connectionRestored || stateChanged || now - lastSessionMs >= SESSION_INTERVAL_MS) {
    lastSessionMs = now;
    publishSessionSnapshot();
  }

  wasConnected = true;
  rememberObservedState();
}
