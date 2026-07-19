type Props = {
  title: string;
  maxTextSize?: string;
};

export default function ComingSoonTool({ title, maxTextSize }: Props) {
  return (
    <section className="tool-workspace" aria-labelledby="workspace-title">
      <div className="tool-workspace__head">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id="workspace-title">{title}</h2>
        </div>
        {maxTextSize ? (
          <span className="limit-label">输入上限 {maxTextSize}</span>
        ) : null}
      </div>

      <div className="workspace-placeholder">
        <div className="workspace-placeholder__preview" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <span className="status-pill">功能开发中</span>
          <h3>工具外壳已准备就绪</h3>
          <p>
            输入、输出、错误提示和操作按钮会在对应工具任务中接入。当前页面不会接收或保存你的内容。
          </p>
        </div>
      </div>

      <div className="workspace-actions" aria-label="即将提供的操作">
        <button className="button button--primary" type="button" disabled>
          执行
        </button>
        <button className="button button--secondary" type="button" disabled>
          复制结果
        </button>
        <button className="button button--secondary" type="button" disabled>
          清空
        </button>
      </div>
    </section>
  );
}
