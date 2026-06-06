# Device Token Broker Pseudocode

> **REVIEW-ONLY PSEUDOCODE:** This file is not a deployed backend, contains no
> real endpoint or secret, and is intentionally incomplete around framework and
> storage-provider details.

The broker owns all Firebase Admin SDK access. The ESP32 never receives a
service-account credential and never chooses its custom claims.

## Suggested Request

```json
{
  "deviceId": "esp32-voltix-001",
  "credentialVersion": 3,
  "timestamp": 1780000000000,
  "nonce": "single-use-random-value",
  "proof": "HMAC-over-canonical-request"
}
```

The exact proof format must be versioned and reviewed before implementation.
Reject stale timestamps, reused nonces, unknown fields, oversized bodies, and
malformed device IDs before any credential lookup.

This pseudocode assumes `proofVerificationKey` is held in protected backend
secret storage. It is equivalent to a device secret and must not be stored in a
client-readable RTDB path. A simpler baseline may send a high-entropy device
credential over certificate-validated HTTPS and compare a server-peppered
derived value instead.

## Custom Token Endpoint

```js
async function issueDeviceCustomToken(request) {
  requireCertificateValidatedHttps(request);
  enforceBodySizeAndSchema(request.body);
  enforceRateLimit(request.networkContext, request.body.deviceId);

  const device = await privateDeviceStore.get(request.body.deviceId);
  denyUnless(device && device.authEnabled);
  denyUnless(device.credentialVersion === request.body.credentialVersion);
  denyUnless(timestampWithinWindow(request.body.timestamp));
  denyUnless(await nonceStore.consumeOnce(device.id, request.body.nonce));

  const expectedProof = deriveRequestProof(
    device.proofVerificationKey,
    canonicalizeRequest(request.body)
  );
  denyUnless(constantTimeEqual(expectedProof, request.body.proof));

  const claims = {
    deviceId: device.id,
    deviceRole: "hardware",
    credentialVersion: device.credentialVersion
  };

  const customToken = await firebaseAdmin.auth().createCustomToken(
    `device:${device.id}`,
    claims
  );

  await auditLog.writeRedacted({
    event: "device_custom_token_issued",
    deviceId: device.id,
    credentialVersion: device.credentialVersion,
    issuedAt: serverTimestamp()
  });

  return {
    customToken,
    firebaseWebApiKeyId: "configured-client-key-alias"
  };
}
```

Do not log the request proof, raw credential, custom token, ID token, or refresh
token. The response should not return service-account material or let the caller
override claims.

## Pairing Endpoint

```js
async function claimPairingCode(request) {
  const user = await verifyFirebaseUserIdToken(request.authorization);
  enforceRateLimit(request.networkContext, user.uid);

  await database.transaction(async (tx) => {
    const pairing = await tx.getPairingCode(request.body.code);
    denyUnless(pairing && !pairing.used && pairing.expiresAt > serverTimestamp());

    const device = await tx.getDevice(pairing.deviceId);
    denyUnless(device && device.authEnabled && !device.paired);

    tx.setDeviceOwner(device.id, user.uid);
    tx.setDeviceMember(device.id, user.uid, "owner");
    tx.setUserDevice(user.uid, device.id, "owner");
    tx.markPairingCodeUsed(request.body.code, user.uid);
  });
}
```

The real implementation must define atomic database behavior, idempotency,
ownership-transfer policy, abuse controls, error redaction, and tests.

## Rotation And Revocation

```js
async function rotateDeviceCredential(authenticatedDeviceRequest) {
  verifyCurrentDeviceProof(authenticatedDeviceRequest);
  const nextCredential = randomBytes(32);

  await privateDeviceStore.stageNextCredential({
    deviceId: authenticatedDeviceRequest.deviceId,
    nextVersion: authenticatedDeviceRequest.credentialVersion + 1,
    protectedVerifier: protectCredential(nextCredential),
    expiresOldAfter: shortConfirmationWindow()
  });

  return deliverThroughReviewedProvisioningChannel(nextCredential);
}

async function revokeDevice(deviceId, authorizedOperator) {
  requireAuthorizedBackendOperator(authorizedOperator);
  await privateDeviceStore.disable(deviceId);
  await firebaseAdmin.auth().revokeRefreshTokens(`device:${deviceId}`);
  await auditLog.writeRedacted({ event: "device_revoked", deviceId });
}
```

Revoking refresh tokens does not necessarily invalidate every already-issued ID
token immediately at RTDB rules. Define the maximum accepted exposure window
and emergency response before production rollout.
