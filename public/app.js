// app.js: the small amount of browser behaviour this app needs. No framework, no build step.
// Pages work without it; this adds push notifications, the install hint, copy buttons and polish.
//
//   - registers the service worker (offline page, push notifications)
//   - push: the Notifications card on /settings, and re-syncing the subscription on every app open
//   - iOS: a dismissible "Add to Home Screen" hint (push only works in the installed app there)
//   - [data-copy] buttons, [data-autosubmit] selects, [data-standalone] form fields
//   - fires "app:visible" on <body> when the app comes back into view (htmx refreshes listen to it)

document.documentElement.classList.add("js");

const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const signedIn = Boolean(document.querySelector(".tabs"));
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// --- Service worker ----------------------------------------------------------------------------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed", error));
}

// --- Small helpers -----------------------------------------------------------------------------

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const input = document.getElementById(button.dataset.copy);
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select(); // clipboard not available: select it so the user can copy by hand
      return;
    }
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1500);
  });
}

for (const select of document.querySelectorAll("select[data-autosubmit]")) {
  select.addEventListener("change", () => select.form?.requestSubmit());
}

for (const field of document.querySelectorAll("input[data-standalone]")) {
  field.value = isStandalone ? "1" : "0";
}

// "app:visible": refresh content when the user returns to the app (at most every 30 s).
let lastVisible = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || Date.now() - lastVisible < 30_000) return;
  lastVisible = Date.now();
  document.body.dispatchEvent(new CustomEvent("app:visible"));
});

// --- Push notifications ------------------------------------------------------------------------

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function keyToBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// iOS can drop push subscriptions silently, and the server may have forgotten one. So on every app
// open, tell the server about this device's current subscription (an idempotent upsert).
async function resyncSubscription() {
  if (!pushSupported || !signedIn || Notification.permission !== "granted") return;
  if (sessionStorage.getItem("push-synced")) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await postJson("/push/subscribe", subscription.toJSON());
    sessionStorage.setItem("push-synced", "1");
  }
}
resyncSubscription().catch((error) => console.warn("Push re-sync failed", error));

const pushBlock = document.querySelector("[data-push]");
if (pushBlock) setUpPushControls(pushBlock);

async function setUpPushControls(block) {
  const status = block.querySelector("[data-push-status]");
  const enable = block.querySelector("[data-push-enable]");
  const disable = block.querySelector("[data-push-disable]");
  const test = block.querySelector("[data-push-test]");
  const iosHint = block.querySelector("[data-push-ios-hint]");
  const say = (text) => (status.textContent = text);

  if (!pushSupported) {
    if (isIOS && !isStandalone) {
      say("Add this app to your Home Screen to turn on notifications.");
      iosHint.hidden = false;
    } else {
      say("This browser doesn't support notifications.");
    }
    return;
  }

  const registration = await navigator.serviceWorker.ready;

  const render = async () => {
    const subscription = await registration.pushManager.getSubscription();
    const blocked = Notification.permission === "denied";
    enable.hidden = Boolean(subscription) || blocked;
    disable.hidden = !subscription;
    test.hidden = !subscription;
    if (blocked) say("Notifications are blocked for this site. Allow them in your browser or system settings, then reload.");
    else say(subscription ? "Notifications are on for this device." : "Notifications are off for this device.");
  };

  enable.addEventListener("click", async () => {
    enable.disabled = true;
    try {
      // Must run in a click handler: iOS only shows the permission prompt after a user gesture.
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(block.dataset.vapidKey),
        });
        await postJson("/push/subscribe", subscription.toJSON());
        sessionStorage.setItem("push-synced", "1");
      }
    } catch (error) {
      console.warn(error);
      say("Couldn't turn on notifications. Please try again.");
      enable.disabled = false;
      return;
    }
    enable.disabled = false;
    await render();
  });

  disable.addEventListener("click", async () => {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postJson("/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe();
    }
    await render();
  });

  test.addEventListener("click", async () => {
    test.disabled = true;
    try {
      const result = await postJson("/push/test");
      say(result.sent > 0 ? `Sent to ${result.sent} device${result.sent === 1 ? "" : "s"}. It should arrive in a few seconds.` : "Nothing was sent: no device accepted the notification. Try turning notifications off and on again.");
    } catch {
      say("Couldn't send a test notification.");
    } finally {
      test.disabled = false;
    }
  });

  await render();
}

// --- iOS install hint --------------------------------------------------------------------------

if (isIOS && !isStandalone && signedIn && localStorage.getItem("install-hint-dismissed") !== "1") {
  const hint = document.createElement("div");
  hint.className = "install-hint";
  hint.setAttribute("role", "status");
  const text = document.createElement("p");
  text.textContent = "Install this app: tap Share, then “Add to Home Screen”. Notifications on iPhone need it.";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  close.addEventListener("click", () => {
    localStorage.setItem("install-hint-dismissed", "1");
    hint.remove();
  });
  hint.append(text, close);
  document.body.append(hint);
}

// --- /design toolbar ---------------------------------------------------------------------------

if (document.querySelector("[data-design-toolbar]")) {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  const accent = params.get("accent");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) document.documentElement.style.setProperty("--accent", accent);
  for (const swatch of document.querySelectorAll("[data-swatch]")) swatch.style.background = swatch.dataset.swatch;
}
