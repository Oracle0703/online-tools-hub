import { useEffect, useRef, useState } from "react";

import type {
  PrivacySelfTestCheckId,
  PrivacySelfTestCode,
  PrivacySelfTestReport,
  PrivacySelfTestReportCode,
} from "../privacy/self-test";
import "./PrivacyCapabilityCenter.css";

type Props = {
  baseUrl: string;
};

type SelfTestState = "idle" | "running" | "complete" | "failed";

const checkLabels: Record<PrivacySelfTestCheckId, string> = {
  environment: "浏览器能力",
  manifest: "隐私清单",
  csp: "内容安全策略",
  "operation-worker": "Operation Worker",
  "built-in-workflow": "内置工作流",
  "site-resources": "本站资源请求",
  "origin-state": "来源存储边界",
  "resource-cleanup": "临时资源释放",
};

const reportMessages: Record<PrivacySelfTestReportCode, string> = {
  passed: "本次自检的全部本站检查均已通过。",
  "invalid-options": "自检参数未通过校验，本次没有运行。",
  "unsupported-environment":
    "当前浏览器缺少完成自检所需的能力；这不是通过结果。",
  "manifest-invalid": "发布的隐私清单未通过结构或覆盖范围校验。",
  "csp-invalid": "当前页面的内容安全策略未达到清单声明。",
  "operation-failed": "合成 Operation 没有按预期完成。",
  "operation-data-observed": "自检在可观察状态中发现了合成 Operation 数据。",
  "workflow-failed": "合成工作流没有按预期完成。",
  "workflow-data-observed": "自检在可观察状态中发现了合成工作流数据。",
  "site-resource-violation": "自检发现不符合本站声明的资源请求。",
  "origin-state-leak": "自检在浏览器来源状态中发现了合成测试数据。",
  "resources-retained": "自检结束后仍有临时资源没有释放。",
  cancelled: "自检已取消；未完成项目不能视为通过。",
  timeout: "自检超时；未完成项目不能视为通过。",
  "internal-error": "自检遇到内部错误，本次结果不能用于证明隐私边界。",
};

const checkCodeLabels: Record<PrivacySelfTestCode, string> = {
  passed: "通过",
  "not-run": "未运行",
  "invalid-options": "参数无效",
  "unsupported-environment": "不支持",
  "manifest-invalid": "清单无效",
  "csp-invalid": "策略无效",
  "operation-failed": "执行失败",
  "operation-data-observed": "发现合成数据",
  "workflow-failed": "执行失败",
  "workflow-data-observed": "发现合成数据",
  "site-resource-violation": "资源违规",
  "origin-state-leak": "状态泄漏",
  "resources-retained": "资源未释放",
  cancelled: "已取消",
  timeout: "已超时",
  "internal-error": "内部错误",
};

export default function PrivacyCapabilityCenter({ baseUrl }: Props) {
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<SelfTestState>("idle");
  const [report, setReport] = useState<PrivacySelfTestReport | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  const runSelfTest = async () => {
    if (state === "running") return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setReport(null);
    setState("running");

    try {
      const { runPrivacySelfTest } = await import("../privacy/self-test");
      const nextReport = await runPrivacySelfTest({
        signal: controller.signal,
        baseUrl,
      });
      if (!mountedRef.current || abortControllerRef.current !== controller) {
        return;
      }
      setReport(nextReport);
      setState("complete");
    } catch {
      if (!mountedRef.current || abortControllerRef.current !== controller) {
        return;
      }
      setState("failed");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const cancelSelfTest = () => {
    abortControllerRef.current?.abort();
  };

  const tone = report?.passed
    ? "success"
    : state === "idle"
      ? "idle"
      : state === "running"
        ? "running"
        : "failure";
  const summary = report
    ? reportMessages[report.code]
    : state === "running"
      ? "正在使用随机生成的合成数据检查本站运行时与浏览器可观察状态…"
      : state === "failed"
        ? "自检模块无法完成，本次没有产生可采信的通过结果。"
        : "尚未运行。自检只在你点击后加载，并且不会读取工具工作区内容。";

  return (
    <section
      className="privacy-self-test"
      aria-labelledby="privacy-self-test-title"
      data-privacy-self-test
      data-self-test-state={state}
    >
      <header className="privacy-self-test__header">
        <div>
          <p className="eyebrow">主动自检</p>
          <h2 id="privacy-self-test-title">验证本站当前运行边界</h2>
        </div>
        <span
          className={`privacy-self-test__badge privacy-self-test__badge--${tone}`}
        >
          {report?.passed
            ? "已通过"
            : state === "running"
              ? "检查中"
              : state === "idle"
                ? "未运行"
                : "未通过"}
        </span>
      </header>

      <p className="privacy-self-test__intro">
        自检会生成一次性合成数据，运行一个 Operation
        和一个内置工作流，再检查本站资源、来源存储与临时资源释放情况。报告只保留检查代码，刷新后消失。
      </p>

      <p
        className={`privacy-self-test__summary privacy-self-test__summary--${tone}`}
        role={tone === "failure" ? "alert" : "status"}
        aria-live={tone === "failure" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {summary}
      </p>

      {report && (
        <ol className="privacy-self-test__checks" aria-label="自检项目结果">
          {report.checks.map((result) => (
            <li key={result.id} data-check-result={result.code}>
              <span aria-hidden="true">{result.passed ? "✓" : "·"}</span>
              <strong>{checkLabels[result.id]}</strong>
              <small>{checkCodeLabels[result.code]}</small>
            </li>
          ))}
        </ol>
      )}

      <div className="privacy-self-test__actions">
        {state === "running" ? (
          <button
            type="button"
            className="privacy-self-test__button privacy-self-test__button--danger"
            onClick={cancelSelfTest}
          >
            取消自检
          </button>
        ) : (
          <button
            type="button"
            className="privacy-self-test__button privacy-self-test__button--primary"
            onClick={() => void runSelfTest()}
          >
            {state === "idle" ? "运行本地自检" : "重新运行自检"}
          </button>
        )}
      </div>

      <p className="privacy-self-test__scope">
        自检只观察当前版本本站代码在本标签页内执行一组随机合成数据时的行为。它会读取
        IndexedDB
        数据库名称，但不读取其中的记录值；也不检查浏览器扩展、浏览器实现、操作系统、网络设备、托管平台日志、其他标签页或本次未执行的路径。通过不等于第三方安全认证。
      </p>
    </section>
  );
}
