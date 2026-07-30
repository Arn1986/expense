(() => {
  "use strict";

  const updateBanner = document.getElementById("pwaUpdateBanner");
  const updateButton = document.getElementById("pwaUpdateButton");
  const laterButton = document.getElementById("pwaUpdateLaterButton");
  const networkBanner = document.getElementById("networkStatusBanner");

  let waitingWorker = null;
  let reloadingForUpdate = false;

  function updateNetworkStatus() {
    if (!networkBanner) return;
    networkBanner.hidden = navigator.onLine;
  }

  function showUpdate(worker) {
    waitingWorker = worker;
    if (updateBanner) updateBanner.hidden = false;
  }

  function hideUpdate() {
    if (updateBanner) updateBanner.hidden = true;
  }

  updateButton?.addEventListener("click", () => {
    if (!waitingWorker) return;
    updateButton.disabled = true;
    updateButton.textContent = "Updating…";
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  });

  laterButton?.addEventListener("click", hideUpdate);
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();

  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", {
        scope: "./",
        updateViaCache: "none",
      });

      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdate(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installingWorker = registration.installing;
        if (!installingWorker) return;

        installingWorker.addEventListener("statechange", () => {
          if (
            installingWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            showUpdate(installingWorker);
          }
        });
      });

      // iOS may keep a Home Screen web app open for a long time. Check for a
      // newer GitHub Pages deployment when the app returns to the foreground.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          registration.update().catch(() => {});
        }
      });

      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);
    } catch (error) {
      console.warn("Ledgerly service worker registration failed:", error);
    }
  });
})();
