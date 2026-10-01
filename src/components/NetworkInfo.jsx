const NetworkInfo = ({ url, method, status, loading, error, responseKeys, debug }) => {
  // 成品观感:请求透明化面板只在 ?debug=1 时渲染(默认不占版面)。
  if (!debug) return null;
  return (
    <section className="netinfo">
      <h3 className="netinfo-title">数据来源 · 透明可验证</h3>
      <div className="netinfo-row">
        <span className="netinfo-key">请求地址</span>
        <code className="netinfo-value">{url || "—"}</code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">方法</span>
        <code className="netinfo-value netinfo-method">{method}</code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">状态码</span>
        <code
          className={`netinfo-value netinfo-status netinfo-status-${statusKind(status, loading, error)}`}
        >
          {loading ? "请求中…" : (status ?? "—")}
        </code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">响应字段</span>
        <code className="netinfo-value">
          {responseKeys.length ? responseKeys.join(", ") : "—"}
        </code>
      </div>
    </section>
  );
};

function statusKind(status, loading, error) {
  if (loading) return "pending";
  if (error || (status && status >= 400)) return "bad";
  if (status && status >= 200 && status < 300) return "good";
  return "unknown";
}

export default NetworkInfo;
