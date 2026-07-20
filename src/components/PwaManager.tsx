import { useEffect, useRef, useState } from "react";

import {
  canRegisterServiceWorker,
  normalizeBaseUrl,
  pwaAssetUrl,
} from "../lib/pwa";
import "./PwaManager.css";

type InstallChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}

type Props = {
  baseUrl: string;
};

export default function PwaManager({ baseUrl }: Props) {
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [updateRegistration, setUpdateRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [offline, setOffline] = useState(false);
  const [updating, setUpdating] = useState(false);
  const updateRequested = useRef(false);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPrompt(promptEvent);
    };
    const handleAppInstalled = () => setInstallPrompt(null);

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    const canRegister = canRegisterServiceWorker({
      hasServiceWorker: "serviceWorker" in navigator,
      isSecureContext: window.isSecureContext,
      hostname: window.location.hostname,
    });
    if (!canRegister) return;

    const normalizedBase = normalizeBaseUrl(baseUrl);
    const workerUrl = pwaAssetUrl(normalizedBase, "service-worker.js");
    let active = true;
    let registration: ServiceWorkerRegistration | undefined;
    let updateTimer: ReturnType<typeof setInterval> | undefined;
    const workerCleanups: Array<() => void> = [];

    const showWaitingUpdate = (candidate: ServiceWorkerRegistration) => {
      if (active && candidate.waiting && navigator.serviceWorker.controller) {
        setUpdateRegistration(candidate);
      }
    };

    const watchInstallingWorker = (candidate: ServiceWorkerRegistration) => {
      const worker = candidate.installing;
      if (!worker) return;

      const handleStateChange = () => {
        if (worker.state === "installed") showWaitingUpdate(candidate);
      };
      worker.addEventListener("statechange", handleStateChange);
      workerCleanups.push(() =>
        worker.removeEventListener("statechange", handleStateChange),
      );
    };

    const checkForUpdates = () => {
      if (
        registration &&
        document.visibilityState === "visible" &&
        navigator.onLine
      ) {
        void registration.update().catch(() => undefined);
      }
    };

    const handleControllerChange = () => {
      if (!updateRequested.current) return;
      updateRequested.current = false;
      window.location.reload();
    };
    const handleOnline = () => {
      setOffline(false);
      checkForUpdates();
    };
    const handleOffline = () => setOffline(true);
    const handleVisibilityChange = () => checkForUpdates();

    queueMicrotask(() => {
      if (active) setOffline(!navigator.onLine);
    });
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void navigator.serviceWorker
      .register(workerUrl, {
        scope: normalizedBase,
        updateViaCache: "none",
      })
      .then((candidate) => {
        if (!active) return;
        registration = candidate;
        showWaitingUpdate(candidate);
        const handleUpdateFound = () => watchInstallingWorker(candidate);
        candidate.addEventListener("updatefound", handleUpdateFound);
        workerCleanups.push(() =>
          candidate.removeEventListener("updatefound", handleUpdateFound),
        );
        watchInstallingWorker(candidate);
        updateTimer = setInterval(checkForUpdates, 60 * 60 * 1_000);
        checkForUpdates();
      })
      .catch(() => undefined);

    return () => {
      active = false;
      if (updateTimer) clearInterval(updateTimer);
      for (const cleanup of workerCleanups) cleanup();
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [baseUrl]);

  const installApp = async () => {
    const promptEvent = installPrompt;
    if (!promptEvent) return;
    setInstallPrompt(null);
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // A dismissed or unavailable native prompt needs no additional UI.
    }
  };

  const activateUpdate = () => {
    const waitingWorker = updateRegistration?.waiting;
    if (!waitingWorker) return;
    setUpdating(true);
    updateRequested.current = true;
    try {
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      updateRequested.current = false;
      setUpdating(false);
    }
  };

  const mode = offline
    ? "offline"
    : updateRegistration
      ? "update"
      : installPrompt
        ? "install"
        : null;
  if (!mode) return null;

  return (
    <aside
      className={`pwa-notice pwa-notice--${mode}`}
      aria-labelledby="pwa-notice-title"
      aria-describedby="pwa-notice-description"
      data-pwa-notice={mode}
    >
      <span className="pwa-notice__icon" aria-hidden="true">
        {mode === "offline" ? "↯" : mode === "update" ? "↻" : "↓"}
      </span>
      <div className="pwa-notice__copy" aria-live="polite" aria-atomic="true">
        <strong id="pwa-notice-title">
          {mode === "offline"
            ? "当前处于离线状态"
            : mode === "update"
              ? "发现新版本"
              : "安装到设备"}
        </strong>
        <span id="pwa-notice-description">
          {mode === "offline"
            ? "已缓存的页面和工具仍可继续使用。"
            : mode === "update"
              ? updating
                ? "正在切换版本…"
                : "刷新后即可使用最新功能。"
              : "安装后可以从桌面快速打开，并离线使用已缓存工具。"}
        </span>
      </div>
      {mode === "update" && (
        <div className="pwa-notice__actions">
          <button
            type="button"
            className="pwa-notice__button pwa-notice__button--primary"
            onClick={activateUpdate}
            disabled={updating}
          >
            {updating ? "更新中" : "立即更新"}
          </button>
          <button
            type="button"
            className="pwa-notice__button"
            onClick={() => setUpdateRegistration(null)}
            disabled={updating}
          >
            稍后
          </button>
        </div>
      )}
      {mode === "install" && installPrompt && (
        <div className="pwa-notice__actions">
          <button
            type="button"
            className="pwa-notice__button pwa-notice__button--primary"
            onClick={() => void installApp()}
          >
            安装应用
          </button>
          <button
            type="button"
            className="pwa-notice__button"
            onClick={() => setInstallPrompt(null)}
          >
            暂不安装
          </button>
        </div>
      )}
    </aside>
  );
}
