import {
  auth, FIREBASE_CONFIGURED
} from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ensureInitialUserState, readableFirebaseError } from "./user-state.js";

const loginError = document.getElementById("login-error");
const formLogin = document.getElementById("form-login");
const formRegister = document.getElementById("form-register");
const loginTitle = document.getElementById("login-title");
const loginSub = document.getElementById("login-sub");
let registrationInProgress = false;
let redirectStarted = false;

function showError(message) {
  loginError.textContent = message;
  loginError.style.display = "block";
}

function hideError() {
  loginError.style.display = "none";
}

function redirectToDashboard() {
  if (redirectStarted) return;
  redirectStarted = true;
  window.location.replace("index.html");
}

async function prepareUserAndRedirect(user) {
  try {
    await ensureInitialUserState(user);
    redirectToDashboard();
  } catch (error) {
    console.error("[Auth] Initial user state failed:", error?.code || error?.message || error);
    showError(readableFirebaseError(error, "Signed in, but account setup could not be completed."));
  }
}

if (!FIREBASE_CONFIGURED) {
  redirectToDashboard();
} else {
  onAuthStateChanged(auth, user => {
    if (user && !registrationInProgress) prepareUserAndRedirect(user);
  });
}

document.getElementById("btn-google").addEventListener("click", async () => {
  if (!FIREBASE_CONFIGURED) return redirectToDashboard();
  hideError();
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    if (error.code !== "auth/popup-closed-by-user") showError(friendlyError(error));
  }
});

document.getElementById("go-register").addEventListener("click", () => {
  formLogin.style.display = "none";
  formRegister.style.display = "block";
  loginTitle.textContent = "Create account";
  loginSub.textContent = "Start monitoring your energy";
  hideError();
});

document.getElementById("go-login").addEventListener("click", () => {
  formRegister.style.display = "none";
  formLogin.style.display = "block";
  loginTitle.textContent = "Welcome back";
  loginSub.textContent = "Sign in to your account";
  hideError();
});

document.getElementById("btn-login").addEventListener("click", async () => {
  if (!FIREBASE_CONFIGURED) return redirectToDashboard();
  hideError();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) return showError("Please fill in all fields.");

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    showError(friendlyError(error));
  }
});

document.getElementById("btn-register").addEventListener("click", async () => {
  if (!FIREBASE_CONFIGURED) return redirectToDashboard();
  hideError();
  const name = document.getElementById("reg-name").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  if (!name || !email || !password) return showError("Please fill in all fields.");
  if (password.length < 6) return showError("Password must be at least 6 characters.");

  registrationInProgress = true;
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });
    await prepareUserAndRedirect(credential.user);
  } catch (error) {
    registrationInProgress = false;
    showError(friendlyError(error));
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  document.getElementById(
    formRegister.style.display !== "none" ? "btn-register" : "btn-login"
  ).click();
});

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/user-not-found": "Account not found. Please register first.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/email-already-in-use": "Email already registered. Please sign in.",
    "auth/invalid-email": "Invalid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/popup-blocked": "Popup blocked. Allow popups for this site.",
    "auth/account-exists-with-different-credential": "An account already exists with this email.",
    "auth/network-request-failed": "Network error. Check your connection."
  };
  return messages[error?.code] || readableFirebaseError(error, "Something went wrong. Please try again.");
}
