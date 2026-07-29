import { useEffect, useState } from "react";
import { fetchPokemon, randomId, pokemonUrl } from "./api/pokemon.js";
import LoadingState from "./components/LoadingState.jsx";
import ErrorState from "./components/ErrorState.jsx";
import PokemonCard from "./components/PokemonCard.jsx";
import NetworkInfo from "./components/NetworkInfo.jsx";

const App = () => {
  const [pokemon, setPokemon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [requestUrl, setRequestUrl] = useState("");
  const [statusCode, setStatusCode] = useState(null);

  async function catchOne() {
    const id = randomId();
    setLoading(true);
    setError(null);
    setRequestUrl(pokemonUrl(id));
    setStatusCode(null);

    try {
      const { status, data } = await fetchPokemon(id);
      setStatusCode(status);
      setPokemon(data);
    } catch (e) {
      setStatusCode(e.status ?? null);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    catchOne();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Random Pokémon</h1>
      </header>

      <div className="pkmn">
        <section className="pkmn-stage">
          <div className="pkmn-stage-bg" />
          {loading && <LoadingState />}
          {error && <ErrorState error={error} onRetry={catchOne} />}
          {!loading && !error && pokemon && <PokemonCard pokemon={pokemon} />}

          <button
            className="catch-btn"
            type="button"
            onClick={catchOne}
            disabled={loading}
          >
            {loading ? "Summoning…" : "Catch another!"}
          </button>
        </section>

        <NetworkInfo
          url={requestUrl}
          method="GET"
          status={statusCode}
          loading={loading}
          error={error}
          responseKeys={pokemon ? Object.keys(pokemon).slice(0, 8) : []}
        />
      </div>
    </div>
  );
};

export default App;
