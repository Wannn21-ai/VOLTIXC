#pragma once

// Bridges validated MQTT messages into the existing VOLTIX state machine.
// MQTT callbacks only enqueue data; all state changes happen from update().
void mqttCloudSyncBegin();
void mqttCloudSyncUpdate();
bool mqttCloudCommandTransitionPending();
bool mqttCloudTransitionAckRequested();
void mqttCloudFlushTransitionAck();
bool mqttCloudPublishLocalConfig();
