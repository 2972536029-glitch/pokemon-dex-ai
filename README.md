# Xsolla School - Homework

A starter project for the course homework. It is a small **Vite + React** app that
calls the public **PokeAPI**, fetches a random Pokémon, and shows the data using the
`useState` + `useEffect` three-state pattern (loading / error / data). A side panel
displays the request's URL, method, and status so you can compare it with DevTools.

## Requirements

- Node.js 18+

## Running

```bash
cd homework
npm install
npm run dev        # opens http://localhost:5177
```

Open DevTools -> Network to watch the real requests while you work.

## Homework 1 - Build your own Pokémon page

Build on the page in `src/App.jsx`.

**Required**

- Call PokeAPI (`https://pokeapi.co/api/v2/pokemon/:id-or-name`) to get the data.
- Use the `useState` + `useEffect` three-state pattern.
- Render the data, plus a loading state and an error state.
- Add a **search input**: type a Pokémon id or name (e.g. `25` or `pikachu`) and fetch it.
  Do a basic frontend check that the response looks valid before rendering.

## Homework 2 - Describe a real HTTP request

Analyze one real API request from `api.xsolla.com` using DevTools.

Write your answer in **`HOMEWORK2.md`** (a template is already there).

- Register and open `publisher.xsolla.com`, then go to any page in the app.
- In the Network panel, filter by **fetch/xhr** and pick one `api.xsolla.com/...` request.
- Explain which page and which action triggered it.
- Write down the request fields: Request URL, Method, Status Code, and whether it has
  Query Params / Request Payload (you decide which fields and how many to record).
  It does not have to be a 2xx response - a 4xx / 5xx request is fine too.

> Security: always mask sensitive data. Authorization, Cookie, Token, and any account /
> password fields in the payload must be redacted. Never submit real credentials.
