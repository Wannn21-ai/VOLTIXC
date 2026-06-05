#include "firebase_integration_scaffold.h"

void buildLiveSystemPayload(JsonDocument& output, const LiveSystemPayloadInput& input) {
  output.clear();
  output["timestamp"] = input.timestamp;
  output["internet"] = input.internet;
  output["mode"] = input.mode;
  output["relay"] = input.relay;
  output["wifiStatus"] = input.wifiStatus;
  output["activeSsid"] = input.activeSsid;
  output["firmwareVersion"] = input.firmwareVersion;
}

void buildLiveDevicePayload(JsonDocument& output, const LiveDevicePayloadInput& input) {
  output.clear();
  output["connected"] = input.connected;
  output["voltage"] = input.voltage;
  output["current"] = input.current;
  output["power"] = input.power;
  output["apparent"] = input.apparent;
  output["pf"] = input.powerFactor;
  output["frequency"] = input.frequency;
  output["energy"] = input.energy;
  output["cost"] = input.cost;
  output["duration"] = input.durationSec;
  output["overload"] = input.overload;
}

void buildHistoryPayload(JsonDocument& output, const HistoryPayloadInput& input) {
  output.clear();
  output["name"] = input.name;
  output["startTime"] = input.startTime;
  output["endTime"] = input.endTime;
  output["durationSec"] = input.durationSec;
  output["energyKwh"] = input.energyKwh;
  output["cost"] = input.cost;
  output["voltageAvg"] = input.voltageAvg;
  output["currentAvg"] = input.currentAvg;
  output["powerAvg"] = input.powerAvg;
  output["powerMax"] = input.powerMax;
  output["pfAvg"] = input.powerFactorAvg;
  output["frequencyAvg"] = input.frequencyAvg;
  output["apparentAvg"] = input.apparentAvg;
  output["modeStart"] = input.modeStart;
  output["modeEnd"] = input.modeEnd;
  output["modePath"] = input.modePath;
  output["endReason"] = input.endReason;
  output["overload"] = input.overload;
  output["syncStatus"] = input.syncStatus;
}
