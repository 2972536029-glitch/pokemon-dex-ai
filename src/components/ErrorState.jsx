const ErrorState = ({ error, onRetry }) => {
  return (
    <div className="pkmn-state pkmn-error">
      <div className="pkmn-error-emoji">💢</div>
      <p>Oops, capture failed: {error}</p>
      <button className="catch-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
};

export default ErrorState;
