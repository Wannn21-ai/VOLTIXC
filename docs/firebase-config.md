# Safe Firebase Web Config Workflow

VOLTIX keeps Firebase Web App config out of committed HTML. Source pages under
`web/` contain placeholder meta values, and `web/js/firebase-config.js` enters
local visual mode while those placeholders remain.

Although Firebase Web App config is not a service-account secret, keeping
environment-specific values out of source prevents accidental project coupling
and avoids committing configuration copied from a real project.

## Files and Safety

Safe to commit:

- `web/` source files with `NETLIFY_ENV_FIREBASE_*` placeholders
- `.env.example` with variable names and empty values
- `scripts/build-web.mjs`
- hosting build configuration

Never commit:

- `.env`, `.env.local`, or other populated `.env.*` files
- generated `dist/`
- Firebase service-account JSON, private keys, or backend credentials

The repository `.gitignore` protects these local/generated files.

## Required Variables

```text
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_DATABASE_URL
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_MESSAGING_SENDER_ID
FIREBASE_APP_ID
```

## Mode 1: Source / Local Visual Mode

Serve `web/` directly without creating an environment file. Placeholder values
remain, Firebase initialization is skipped, and the existing local visual mode
renders the UI without database or authentication operations.

## Mode 2: Local Firebase Testing

1. Create an ignored local file:

   PowerShell:

   ```powershell
   Copy-Item .env.example .env.local
   ```

   macOS/Linux:

   ```bash
   cp .env.example .env.local
   ```

2. Fill all seven values in `.env.local`. Do not add quotes unless the value
   needs them.
3. Generate the deployable site:

   ```bash
   npm run build:web
   ```

4. Serve `dist/`, for example:

   ```bash
   python -m http.server 8766 --directory dist
   ```

The build script never prints values. It removes and recreates `dist/`, copies
all `web/` assets, and replaces placeholders in every HTML page.

If one or more required variables are missing, the build prints only the
missing variable names and preserves every placeholder. The generated site then
runs safely in local visual mode instead of receiving a partial Firebase
configuration.

Environment variables supplied by the shell or hosting provider take precedence
over `.env.local`.

## Auth and First-Login Verification

After generating `dist/` with all seven Firebase variables:

1. Enable Email/Password in Firebase Authentication.
2. Serve `dist/` from a local HTTP server or hosting preview.
3. Register a new user or sign in from `login.html`.
4. Confirm the authenticated user is redirected to `index.html`.
5. Confirm `/users/{uid}/profile` and missing `/users/{uid}/settings` defaults
   are initialized without replacing existing values.
6. Confirm Dashboard and Settings use the shared device
   `esp32-voltix-001`.

The web uses the shared device ID exported by `web/js/user-state.js`. It does
not create per-user device-index records.

## Mode 3: Vercel or Netlify

In the hosting dashboard, add all seven required environment variables for the
desired deployment environment. Do not paste values into repository files.

Both included hosting configurations use:

```text
Build command: npm run build:web
Publish/output directory: dist
```

- Vercel reads `vercel.json`.
- Netlify reads `netlify.toml`.

Preview and production environments should use their own Firebase projects or
explicitly reviewed configuration. After deployment, verify Firebase Auth
authorized domains and RTDB rules separately.

## Build Guarantees

- No real Firebase values are stored in `web/`.
- No values are printed by the build helper.
- Injection is all-or-nothing.
- Missing values preserve local visual mode.
- Every file and asset under `web/` is copied to `dist/`.
- This workflow does not deploy Firebase rules or modify
  firmware/backend behavior.
