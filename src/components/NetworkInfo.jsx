const NetworkInfo = ({ url, method, status, loading, error, responseKeys }) => {
  return (
    <section className="netinfo">
      <h3 className="netinfo-title">What just happened?</h3>
      <div className="netinfo-row">
        <span className="netinfo-key">Request URL</span>
        <code className="netinfo-value">{url || "—"}</code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">Method</span>
        <code className="netinfo-value netinfo-method">{method}</code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">Status</span>
        <code
          className={`netinfo-value netinfo-status netinfo-status-${statusKind(status, loading, error)}`}
        >
          {loading ? "pending…" : (status ?? "—")}
        </code>
      </div>
      <div className="netinfo-row">
        <span className="netinfo-key">Response fields</span>
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
