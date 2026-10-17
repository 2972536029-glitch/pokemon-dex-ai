const ErrorState = ({ error, onRetry }) => {
  return (
    <div className="pkmn-state pkmn-error">
      <div className="pkmn-error-emoji">💢</div>
      <p>捕捉失败了:{String(error ?? "网络异常").slice(0, 120)}</p>
      <button className="catch-btn" onClick={onRetry}>
        再试一次
      </button>
    </div>
  );
};

export default ErrorState;
