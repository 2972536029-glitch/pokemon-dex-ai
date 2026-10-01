const LoadingState = () => {
  return (
    <div className="pkmn-state pkmn-loading">
      <div className="pokeball spinning" />
      <p>
        野生的宝可梦正在赶来
        <span className="loading-dots" aria-hidden="true">
          <i>·</i>
          <i>·</i>
          <i>·</i>
        </span>
      </p>
    </div>
  );
};

export default LoadingState;
