// ================================================
// firebase-config.js
// Konfigurasi Firebase — nilai diambil dari meta tag
// yang di-inject oleh Netlify Environment Variables.
// ================================================
import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase,
  ref as firebaseRef,
  onValue as firebaseOnValue,
  set as firebaseSet,
  push as firebasePush,
  remove as firebaseRemove,
  get as firebaseGet,
  update as firebaseUpdate
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

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

const FIREBASE_CONFIGURED = Object.values(firebaseConfig).every(isInjectedValue);
const localUser = {
  uid: "local-visual-user",
  email: "local@voltix.test",
  displayName: "Local Visual",
};

let auth;
let db;

if (FIREBASE_CONFIGURED) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
} else {
  auth = { currentUser: localUser };
  db = null;
  console.warn(
    "[firebase-config] Firebase env belum diinjeksi. Menjalankan mode visual lokal; auth dan operasi database dinonaktifkan."
  );
}

const DEVICE_ID = "esp32-smart-energy-001";

const emptySnapshot = Object.freeze({
  exists: () => false,
  val: () => null,
});

function ref(database, path) {
  return FIREBASE_CONFIGURED
    ? firebaseRef(database, path)
    : { path, localVisualMode: true };
}

function onValue(reference, callback, ...rest) {
  if (FIREBASE_CONFIGURED) return firebaseOnValue(reference, callback, ...rest);
  queueMicrotask(() => callback(emptySnapshot));
  return () => {};
}

function get(reference) {
  return FIREBASE_CONFIGURED ? firebaseGet(reference) : Promise.resolve(emptySnapshot);
}

function set(reference, value) {
  return FIREBASE_CONFIGURED ? firebaseSet(reference, value) : Promise.resolve();
}

function update(reference, value) {
  return FIREBASE_CONFIGURED ? firebaseUpdate(reference, value) : Promise.resolve();
}

function remove(reference) {
  return FIREBASE_CONFIGURED ? firebaseRemove(reference) : Promise.resolve();
}

function push(reference, value) {
  if (FIREBASE_CONFIGURED) return firebasePush(reference, value);
  return Promise.resolve({ path: `${reference?.path || "local"}/visual-entry`, localVisualMode: true });
}

export {
  auth, db, ref, onValue, set, push, remove, get, update,
  DEVICE_ID, FIREBASE_CONFIGURED, localUser
};
