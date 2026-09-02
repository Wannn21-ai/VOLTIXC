#pragma once

// Observes existing VOLTIX state and mirrors snapshots to MQTT. This module
// never changes relay, session, recovery, storage, or operating mode state.
void mqttStateSyncBegin();
void mqttStateSyncUpdate();
