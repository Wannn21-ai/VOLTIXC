import { createHash } from "node:crypto";

const [deviceId, rawCredentialVersion] = process.argv.slice(2);
const credentialVersion = Number(rawCredentialVersion);
const pepper = process.env.DEVICE_AUTH_PEPPER;
const deviceSecret = process.env.DEVICE_SECRET;

if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(deviceId || "") ||
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
  const hash = createHash("sha256")
    .update(`${pepper}:${deviceId}:${credentialVersion}:${deviceSecret}`, "utf8")
    .digest("hex");
  console.log(hash);
}
