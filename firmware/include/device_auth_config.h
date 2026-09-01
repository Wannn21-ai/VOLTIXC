#pragma once

// Safe defaults. Override these only in ignored include/credentials.h or with
// reviewed private build flags. Device authentication remains disabled unless
// explicitly enabled.
#ifndef VOLTIX_DEVICE_AUTH_ENABLED
#define VOLTIX_DEVICE_AUTH_ENABLED 0
#endif

#ifndef VOLTIX_TOKEN_BROKER_URL
#define VOLTIX_TOKEN_BROKER_URL ""
#endif

#ifndef VOLTIX_DEVICE_PAIRING_CODE_URL
#define VOLTIX_DEVICE_PAIRING_CODE_URL ""
#endif

#ifndef VOLTIX_DEVICE_RELEASE_URL
#define VOLTIX_DEVICE_RELEASE_URL ""
#endif

#ifndef VOLTIX_DEVICE_SECRET
#define VOLTIX_DEVICE_SECRET ""
#endif

#ifndef VOLTIX_DEVICE_CREDENTIAL_VERSION
#define VOLTIX_DEVICE_CREDENTIAL_VERSION 1
#endif

// PEM root CA strings are not secrets, but are required so auth credentials
// are never sent through an insecure TLS connection.
#ifndef VOLTIX_TOKEN_BROKER_ROOT_CA
#define VOLTIX_TOKEN_BROKER_ROOT_CA ""
#endif

#ifndef VOLTIX_IDENTITY_TOOLKIT_ROOT_CA
#define VOLTIX_IDENTITY_TOOLKIT_ROOT_CA ""
#endif

#ifndef VOLTIX_SECURE_TOKEN_ROOT_CA
#define VOLTIX_SECURE_TOKEN_ROOT_CA ""
#endif

#ifndef VOLTIX_FIREBASE_RTDB_ROOT_CA
#define VOLTIX_FIREBASE_RTDB_ROOT_CA ""
#endif
