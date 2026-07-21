import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isOfflinePackageClientError,
  OfflinePackageClient,
  type OfflinePackageDownload,
  type OfflinePackageProgress,
  type OfflinePackageStatus,
} from "../lib/pwa-offline-package";
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

type PackageActivity =
  "idle" | "checking" | "downloading" | "cancelling" | "removing";

type PackageFeedback = {
  tone: "info" | "success" | "error";
  message: string;
  retryable?: boolean;
};

type CapacityEstimate = {
  supported: boolean;
  usage?: number;
  quota?: number;
};

const mebibyte = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes >= mebibyte) return `${(bytes / mebibyte).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function packageErrorMessage(code: string): string {
  switch (code) {
    case "busy":
      return "另一个页面正在管理离线包，请稍后重试。";
    case "cancelled":
      return "离线包下载已经取消。";
    case "network":
      return "网络中断，未完成的资源没有启用。恢复网络后可以重试。";
    case "integrity":
      return "离线包校验失败，未完成的版本没有启用。请重新下载。";
    case "quota":
      return "浏览器没有足够的站点存储空间。释放空间后可以重试。";
    case "cache":
      return "浏览器无法写入离线缓存。可以检查站点数据权限后重试。";
    case "unsupported-protocol":
      return "当前页面与 Service Worker 版本不兼容，请重新载入后再试。";
    case "invalid-request":
    case "invalid-response":
      return "离线包控制消息未通过校验，请重新载入页面后再试。";
    case "timeout":
      return "等待 Service Worker 响应超时，请稍后重试。";
    default:
      return "暂时无法完成离线包操作，请稍后重试。";
  }
}

async function estimateStorage(): Promise<CapacityEstimate> {
  if (typeof navigator.storage?.estimate !== "function") {
    return { supported: false };
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      supported: true,
      usage: typeof estimate.usage === "number" ? estimate.usage : undefined,
      quota: typeof estimate.quota === "number" ? estimate.quota : undefined,
    };
  } catch {
    return { supported: false };
  }
}

function stateHeading(
  status: OfflinePackageStatus | null,
  activity: PackageActivity,
): string {
  if (activity === "checking") return "正在检查离线能力";
  if (activity === "downloading") return "正在下载完整离线包";
  if (activity === "cancelling") return "正在取消下载";
  if (activity === "removing") return "正在移除完整离线包";
  if (status?.state === "complete") return "完整离线包已就绪";
  if (status?.state === "partial") return "离线包尚未完成";
  return "基础离线页面已就绪";
}

export default function PwaManager({ baseUrl }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const activeDownloadRef = useRef<OfflinePackageDownload | null>(null);
  const mountedRef = useRef(true);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [updateRegistration, setUpdateRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [offline, setOffline] = useState(false);
  const [offlineNoticeDismissed, setOfflineNoticeDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [packageClient, setPackageClient] =
    useState<OfflinePackageClient | null>(null);
  const [packageStatus, setPackageStatus] =
    useState<OfflinePackageStatus | null>(null);
  const [packageProgress, setPackageProgress] =
    useState<OfflinePackageProgress | null>(null);
  const [packageActivity, setPackageActivity] =
    useState<PackageActivity>("idle");
  const [packageFeedback, setPackageFeedback] =
    useState<PackageFeedback | null>(null);
  const [capacity, setCapacity] = useState<CapacityEstimate>({
    supported: false,
  });
  const updateRequested = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeDownloadRef.current?.disconnect();
      activeDownloadRef.current = null;
    };
  }, []);

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

    const connectPackageClient = (worker?: ServiceWorker | null) => {
      if (active && worker) setPackageClient(new OfflinePackageClient(worker));
    };

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
        if (worker.state === "activated") connectPackageClient(worker);
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
      if (updateRequested.current) {
        updateRequested.current = false;
        window.location.reload();
        return;
      }
      connectPackageClient(
        registration?.active ?? navigator.serviceWorker.controller,
      );
    };
    const handleOnline = () => {
      setOffline(false);
      setOfflineNoticeDismissed(false);
      checkForUpdates();
    };
    const handleOffline = () => {
      setOffline(true);
      setOfflineNoticeDismissed(false);
    };
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
        connectPackageClient(
          candidate.active ?? navigator.serviceWorker.controller,
        );
        showWaitingUpdate(candidate);
        const handleUpdateFound = () => watchInstallingWorker(candidate);
        candidate.addEventListener("updatefound", handleUpdateFound);
        workerCleanups.push(() =>
          candidate.removeEventListener("updatefound", handleUpdateFound),
        );
        watchInstallingWorker(candidate);
        updateTimer = setInterval(checkForUpdates, 60 * 60 * 1_000);
        checkForUpdates();
        return navigator.serviceWorker.ready;
      })
      .then((readyRegistration) => {
        if (active && readyRegistration) {
          connectPackageClient(
            readyRegistration.active ?? navigator.serviceWorker.controller,
          );
        }
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

  const refreshPackageStatus = useCallback(
    async (announce = false) => {
      if (!packageClient) return;
      if (announce) {
        setPackageActivity("checking");
        setPackageFeedback(null);
      }

      const capacityPromise = estimateStorage();
      try {
        const status = await packageClient.status();
        if (!mountedRef.current) return;
        setPackageStatus(status);
        setCapacity(await capacityPromise);
        if (announce) setPackageActivity("idle");
      } catch (error) {
        if (!mountedRef.current) return;
        setCapacity(await capacityPromise);
        if (announce) setPackageActivity("idle");
        const code = isOfflinePackageClientError(error)
          ? error.code
          : "unavailable";
        setPackageFeedback({
          tone: "error",
          message: packageErrorMessage(code),
          retryable: true,
        });
      }
    },
    [packageClient],
  );

  useEffect(() => {
    if (!packageClient || !offline) return;
    queueMicrotask(() => void refreshPackageStatus(false));
  }, [offline, packageClient, refreshPackageStatus]);

  const openOfflineCenter = useCallback(
    (trigger?: HTMLElement | null) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.open || !packageClient) return;
      lastTriggerRef.current = trigger ?? null;
      dialog.showModal();
      requestAnimationFrame(() => closeButtonRef.current?.focus());
      if (!activeDownloadRef.current) {
        void refreshPackageStatus(true);
      }
    },
    [packageClient, refreshPackageStatus],
  );

  const closeOfflineCenter = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => {
    const handleOfflineTrigger = (event: MouseEvent) => {
      const element =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-pwa-offline-trigger]")
          : null;
      if (!element || !packageClient) return;
      event.preventDefault();
      openOfflineCenter(element);
    };

    document.addEventListener("click", handleOfflineTrigger);
    return () => document.removeEventListener("click", handleOfflineTrigger);
  }, [openOfflineCenter, packageClient]);

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

  const startPackageDownload = useCallback(async () => {
    if (!packageClient || offline || activeDownloadRef.current) return;
    setPackageActivity("downloading");
    setPackageProgress(null);
    setPackageFeedback({
      tone: "info",
      message: "关闭此面板不会取消下载；稍后重新打开可继续查看状态。",
    });

    const download = packageClient.start((progress) => {
      if (!mountedRef.current) return;
      setPackageProgress(progress);
      setPackageStatus((current) =>
        current
          ? {
              ...current,
              buildVersion: progress.buildVersion,
              state:
                progress.completedEntries >= progress.totalEntries
                  ? "complete"
                  : "partial",
              cachedEntries: progress.completedEntries,
              cachedBytes: progress.completedBytes,
              missingEntries: Math.max(
                0,
                progress.totalEntries - progress.completedEntries,
              ),
              missingBytes: Math.max(
                0,
                progress.totalBytes - progress.completedBytes,
              ),
              totalEntries: progress.totalEntries,
              totalBytes: progress.totalBytes,
            }
          : current,
      );
    });
    activeDownloadRef.current = download;

    try {
      const result = await download.result;
      if (!mountedRef.current) return;
      setPackageStatus(result);
      setPackageProgress(null);
      setPackageFeedback(
        result.state === "complete"
          ? {
              tone: "success",
              message: "完整离线包已经校验并启用。",
            }
          : {
              tone: "info",
              message: "下载已取消；未完成的资源没有作为完整离线包启用。",
            },
      );
    } catch (error) {
      if (
        !mountedRef.current ||
        (isOfflinePackageClientError(error) && error.code === "disconnected")
      ) {
        return;
      }
      const code = isOfflinePackageClientError(error)
        ? error.code
        : "unavailable";
      setPackageProgress(null);
      setPackageFeedback({
        tone: "error",
        message: packageErrorMessage(code),
        retryable: isOfflinePackageClientError(error) ? error.retryable : true,
      });
      void refreshPackageStatus(false);
    } finally {
      if (activeDownloadRef.current === download) {
        activeDownloadRef.current = null;
      }
      if (mountedRef.current) setPackageActivity("idle");
    }
  }, [offline, packageClient, refreshPackageStatus]);

  const cancelPackageDownload = useCallback(async () => {
    const download = activeDownloadRef.current;
    if (!download) return;
    setPackageActivity("cancelling");
    try {
      const acknowledgement = await download.cancel();
      if (!acknowledgement.accepted && mountedRef.current) {
        download.disconnect();
        setPackageFeedback({
          tone: "info",
          message: "下载已经结束，正在重新检查离线包状态。",
        });
        void refreshPackageStatus(false);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      const code = isOfflinePackageClientError(error)
        ? error.code
        : "unavailable";
      setPackageActivity("downloading");
      setPackageFeedback({
        tone: "error",
        message: packageErrorMessage(code),
        retryable: true,
      });
    }
  }, [refreshPackageStatus]);

  const removePackage = useCallback(async () => {
    if (!packageClient || activeDownloadRef.current) return;
    setPackageActivity("removing");
    setPackageFeedback(null);
    try {
      const status = await packageClient.remove();
      if (!mountedRef.current) return;
      setPackageStatus(status);
      setPackageProgress(null);
      setPackageFeedback({
        tone: "success",
        message: "完整离线包已移除，基础离线页面仍然保留。",
      });
      setCapacity(await estimateStorage());
    } catch (error) {
      if (!mountedRef.current) return;
      const code = isOfflinePackageClientError(error)
        ? error.code
        : "unavailable";
      setPackageFeedback({
        tone: "error",
        message: packageErrorMessage(code),
        retryable: true,
      });
    } finally {
      if (mountedRef.current) setPackageActivity("idle");
    }
  }, [packageClient]);

  const completedEntries =
    packageProgress?.completedEntries ?? packageStatus?.cachedEntries ?? 0;
  const completedBytes =
    packageProgress?.completedBytes ?? packageStatus?.cachedBytes ?? 0;
  const totalEntries =
    packageProgress?.totalEntries ?? packageStatus?.totalEntries ?? 0;
  const totalBytes =
    packageProgress?.totalBytes ?? packageStatus?.totalBytes ?? 0;
  const progressMaximum = totalBytes || totalEntries || 1;
  const progressValue = totalBytes ? completedBytes : completedEntries;
  const progressPercent = Math.min(
    100,
    Math.max(0, Math.round((progressValue / progressMaximum) * 100)),
  );
  const announcedProgress = Math.floor(progressPercent / 10) * 10;
  const availableBytes =
    typeof capacity.quota === "number" && typeof capacity.usage === "number"
      ? Math.max(0, capacity.quota - capacity.usage)
      : undefined;
  const remainingBytes = packageStatus?.missingBytes ?? totalBytes;
  const estimatedCapacityWarning =
    typeof availableBytes === "number" && remainingBytes > availableBytes;
  const statusTitle = stateHeading(packageStatus, packageActivity);
  const canStart =
    Boolean(packageClient && packageStatus) &&
    !offline &&
    packageActivity === "idle" &&
    packageStatus?.state !== "complete";
  const showProgress =
    packageActivity === "downloading" ||
    packageActivity === "cancelling" ||
    packageStatus?.state === "partial" ||
    packageStatus?.state === "complete";

  const noticeMode = useMemo(() => {
    if (offline && !offlineNoticeDismissed) return "offline" as const;
    if (updateRegistration) return "update" as const;
    if (installPrompt) return "install" as const;
    return null;
  }, [installPrompt, offline, offlineNoticeDismissed, updateRegistration]);

  return (
    <>
      <dialog
        ref={dialogRef}
        className="pwa-center"
        aria-labelledby="pwa-center-title"
        aria-describedby="pwa-center-description"
        data-pwa-offline-center
        data-pwa-client-ready={packageClient ? "true" : "false"}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeOfflineCenter();
        }}
        onClose={() => {
          const trigger = lastTriggerRef.current;
          lastTriggerRef.current = null;
          requestAnimationFrame(() => trigger?.focus());
        }}
      >
        <section className="pwa-center__panel">
          <header className="pwa-center__header">
            <div>
              <p className="eyebrow">离线使用</p>
              <h2 id="pwa-center-title">管理完整离线包</h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="pwa-center__close"
              onClick={closeOfflineCenter}
              aria-label="关闭离线使用面板"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <p id="pwa-center-description" className="pwa-center__lead">
            基础应用壳会自动保留；完整工具、工作流和静态说明只在你主动下载后离线可用。
          </p>

          <section
            className="pwa-center__status-card"
            aria-labelledby="pwa-package-status-title"
          >
            <div className="pwa-center__status-heading">
              <span
                className={`pwa-center__status-dot pwa-center__status-dot--${packageStatus?.state ?? "unknown"}`}
                aria-hidden="true"
              />
              <div>
                <p className="pwa-center__kicker">当前状态</p>
                <h3 id="pwa-package-status-title">{statusTitle}</h3>
              </div>
            </div>

            {packageStatus ? (
              <dl className="pwa-center__metrics">
                <div>
                  <dt>完整包</dt>
                  <dd>{formatBytes(packageStatus.totalBytes)}</dd>
                </div>
                <div>
                  <dt>资源项</dt>
                  <dd>{packageStatus.totalEntries} 项</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{packageStatus.buildVersion}</dd>
                </div>
              </dl>
            ) : (
              <p className="pwa-center__pending" role="status">
                正在等待 Service Worker 提供可验证的离线包清单…
              </p>
            )}

            {showProgress && (
              <div className="pwa-center__progress-wrap">
                <div className="pwa-center__progress-label">
                  <span>
                    {packageProgress?.phase === "checking"
                      ? "正在校验已有资源"
                      : packageActivity === "cancelling"
                        ? "正在安全停止"
                        : "离线包进度"}
                  </span>
                  <strong>{progressPercent}%</strong>
                </div>
                <progress
                  className="pwa-center__progress"
                  max={progressMaximum}
                  value={progressValue}
                  aria-label="完整离线包下载进度"
                  aria-valuetext={`${completedEntries} / ${totalEntries} 项，${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`}
                />
                <p className="pwa-center__progress-meta">
                  <span>
                    {completedEntries} / {totalEntries} 项
                  </span>
                  <span>
                    {formatBytes(completedBytes)} / {formatBytes(totalBytes)}
                  </span>
                </p>
                <p className="sr-only" aria-live="polite" aria-atomic="true">
                  {packageActivity === "downloading"
                    ? `完整离线包下载进度 ${announcedProgress}%`
                    : statusTitle}
                </p>
              </div>
            )}
          </section>

          <section
            className="pwa-center__capacity"
            aria-labelledby="pwa-capacity-title"
          >
            <div>
              <p className="pwa-center__kicker">容量提示</p>
              <h3 id="pwa-capacity-title">浏览器站点存储估算</h3>
            </div>
            {capacity.supported && typeof capacity.quota === "number" ? (
              <p>
                此站点已使用约 {formatBytes(capacity.usage ?? 0)}
                ，浏览器估算还可用约 {formatBytes(availableBytes ?? 0)}。
                {remainingBytes > 0 &&
                  ` 本次还需下载约 ${formatBytes(remainingBytes)}。`}
              </p>
            ) : (
              <p>
                浏览器未提供剩余容量估算。完整包预计为 {formatBytes(totalBytes)}
                ，下载时仍会执行配额检查。
              </p>
            )}
            <p className="pwa-center__capacity-note">
              这是整个站点来源的近似值；实际占用和浏览器自动清理策略可能不同。
            </p>
            {estimatedCapacityWarning && (
              <p className="pwa-center__capacity-warning" role="alert">
                估算剩余空间小于待下载大小。你仍可尝试，但浏览器可能因配额不足而停止。
              </p>
            )}
          </section>

          {packageFeedback && (
            <p
              className={`pwa-center__feedback pwa-center__feedback--${packageFeedback.tone}`}
              role={packageFeedback.tone === "error" ? "alert" : "status"}
            >
              {packageFeedback.message}
            </p>
          )}

          {offline && packageStatus?.state !== "complete" && (
            <p className="pwa-center__feedback pwa-center__feedback--info">
              当前离线，只有已完成缓存的内容可用。连接网络后才能继续下载完整包。
            </p>
          )}

          <div className="pwa-center__actions">
            {packageActivity === "downloading" ||
            packageActivity === "cancelling" ? (
              <button
                type="button"
                className="pwa-center__button pwa-center__button--danger"
                onClick={() => void cancelPackageDownload()}
                disabled={packageActivity === "cancelling"}
              >
                {packageActivity === "cancelling" ? "正在取消" : "取消下载"}
              </button>
            ) : !packageStatus ? (
              <button
                type="button"
                className="pwa-center__button pwa-center__button--primary"
                onClick={() => void refreshPackageStatus(true)}
                disabled={!packageClient || packageActivity !== "idle"}
              >
                {packageActivity === "checking"
                  ? "正在检查"
                  : "重新检查离线包状态"}
              </button>
            ) : packageStatus?.state === "complete" ? (
              <button
                type="button"
                className="pwa-center__button pwa-center__button--danger"
                onClick={() => void removePackage()}
                disabled={packageActivity !== "idle"}
              >
                {packageActivity === "removing" ? "正在移除" : "移除完整离线包"}
              </button>
            ) : (
              <button
                type="button"
                className="pwa-center__button pwa-center__button--primary"
                onClick={() => void startPackageDownload()}
                disabled={!canStart}
              >
                {packageActivity === "checking"
                  ? "正在检查"
                  : packageFeedback?.tone === "error"
                    ? "重新下载"
                    : packageStatus?.state === "partial"
                      ? "继续下载完整离线包"
                      : "下载完整离线包"}
              </button>
            )}
            <button
              type="button"
              className="pwa-center__button"
              onClick={closeOfflineCenter}
            >
              关闭面板
            </button>
          </div>

          <p className="pwa-center__privacy-note">
            离线缓存只包含构建清单中的同源、无查询静态资源，不包含输入、结果、文件、Blob、POST
            请求或运行期查询地址。
          </p>
        </section>
      </dialog>

      {noticeMode && (
        <aside
          className={`pwa-notice pwa-notice--${noticeMode}`}
          aria-labelledby="pwa-notice-title"
          aria-describedby="pwa-notice-description"
          data-pwa-notice={noticeMode}
        >
          <span className="pwa-notice__icon" aria-hidden="true">
            {noticeMode === "offline"
              ? "↯"
              : noticeMode === "update"
                ? "↻"
                : "↓"}
          </span>
          <div
            className="pwa-notice__copy"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong id="pwa-notice-title">
              {noticeMode === "offline"
                ? "当前处于离线状态"
                : noticeMode === "update"
                  ? "新版本已准备好"
                  : "安装到设备"}
            </strong>
            <span id="pwa-notice-description">
              {noticeMode === "offline"
                ? packageStatus?.state === "complete"
                  ? "完整离线包已就绪，工具与工作流可以继续使用。"
                  : packageStatus?.state === "partial"
                    ? "已缓存内容可以继续使用；其他页面会显示离线说明，完整包尚未完成。"
                    : "当前只有基础离线页面可用；联网后可主动下载完整离线包。"
                : noticeMode === "update"
                  ? updating
                    ? "正在切换版本并重新载入…"
                    : "更新会重新载入页面。未清空的输入、结果、文件、批处理队列和运行进度都会消失，请先保存需要保留的内容。更新后完整离线包可能需要重新下载。"
                  : "安装只会添加应用入口；完整离线包需要由你另行主动下载。"}
            </span>
          </div>
          {noticeMode === "update" && (
            <div className="pwa-notice__actions">
              <button
                type="button"
                className="pwa-notice__button pwa-notice__button--danger"
                onClick={activateUpdate}
                disabled={updating}
              >
                {updating ? "更新中" : "仍要更新并重新载入"}
              </button>
              <button
                type="button"
                className="pwa-notice__button"
                onClick={() => setUpdateRegistration(null)}
                disabled={updating}
              >
                稍后更新
              </button>
            </div>
          )}
          {noticeMode === "install" && installPrompt && (
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
          {noticeMode === "offline" && (
            <div className="pwa-notice__actions">
              {packageClient && (
                <button
                  type="button"
                  className="pwa-notice__button pwa-notice__button--primary"
                  onClick={(event) => openOfflineCenter(event.currentTarget)}
                >
                  查看离线状态
                </button>
              )}
              <button
                type="button"
                className="pwa-notice__button"
                onClick={() => setOfflineNoticeDismissed(true)}
              >
                关闭提示
              </button>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
