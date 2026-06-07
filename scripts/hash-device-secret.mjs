import {
  computeDeviceSecretHash,
  requireLabDeviceId,
} from "./lib/device-auth-lab.mjs";

const [rawDeviceId, rawCredentialVersion] = process.argv.slice(2);
let deviceId;
const credentialVersion = Number(rawCredentialVersion);
const pepper = process.env.DEVICE_AUTH_PEPPER;
const deviceSecret = process.env.DEVICE_SECRET;

try {
  deviceId = requireLabDeviceId(rawDeviceId);
} catch {
  deviceId = null;
}

if (!deviceId ||
    !Number.isSafeInteger(credentialVersion) ||
    credentialVersion < 1 ||
    !pepper ||
    !deviceSecret ||
    deviceSecret.length < 16) {
  console.error(
    "Usage: set DEVICE_AUTH_PEPPER and DEVICE_SECRET, then pass <deviceId> <credentialVersion>."
  );
  process.exitCode = 1;
} else {
  const hash = computeDeviceSecretHash(
    pepper,
    deviceId,
    credentialVersion,
    deviceSecret
  );
  console.log(hash);
}
