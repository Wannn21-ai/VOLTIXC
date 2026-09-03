// ================================================
// firebase-config.js
// Firebase is retained only for web user authentication during the MQTT
// migration. Realtime data, settings, commands, and history use the VOLTIX API.
// ================================================
import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

function getMeta(name) {
  const el = document.querySelector(`meta[name="firebase-${name}"]`);
  if (!el) { console.warn(`[firebase-config] Meta tag "firebase-${name}" tidak ditemukan.`); return ""; }
  return el.content;
}

const firebaseConfig = {
  apiKey:            getMeta("api-key"),
  authDomain:        getMeta("auth-domain"),
  databaseURL:       getMeta("database-url"),
  projectId:         getMeta("project-id"),
  storageBucket:     getMeta("storage-bucket"),
  messagingSenderId: getMeta("messaging-sender-id"),
  appId:             getMeta("app-id"),
};

function isInjectedValue(value) {
  if (!value) return false;
  return !/^(NETLIFY_ENV_|VERCEL_ENV_|PLACEHOLDER|YOUR_)/i.test(value);
}

const FIREBASE_CONFIGURED = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.appId,
].every(isInjectedValue);
const localUser = {
  uid: "local-visual-user",
  email: "local@voltix.test",
  displayName: "Local Visual",
};

let auth;

if (FIREBASE_CONFIGURED) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
} else {
  auth = { currentUser: localUser };
  console.warn(
    "[firebase-config] Firebase Auth env belum diinjeksi. Menjalankan mode visual lokal."
  );
}

export {
  auth, FIREBASE_CONFIGURED, localUser
};
