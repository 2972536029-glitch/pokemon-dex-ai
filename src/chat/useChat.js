// useChat — owns one conversation: message list, SSE streaming, abort.
//
// State model: each AI message is a state machine
//   idle → streaming (deltas arriving) → done | error | interrupted
// Covering every state explicitly is the same 三态互斥 discipline the dex
// card uses — a half-specified state is what produces "ghost" UI.
//
// SSE transport: EventSource only supports GET, but chat needs POST with a
// JSON body, so we use fetch + ReadableStream and parse the SSE framing by
// hand. Chunks can split an event in half, so a buffer + split-on-\n\n is
// mandatory (the same parser discipline the server-side LLM client uses).

import { useCallback, useEffect, useRef, useState } from "react";

export const TOOL_LABELS = {
  get_pokemon: "查询图鉴",
  get_evolution_chain: "查进化链",
  get_type_matchup: "查克制关系",
  list_pokemon_of_type: "找候选",
  get_my_cards: "查我的收藏",
  get_my_wallet: "查我的钱包",
  list_packs: "查卡包列表",
};

function toolArgsSummary(name, args) {
  return String(args?.name || args?.type || "");
}

let nextId = 1;

export function useChat(context) {
  const [messages, setMessages] = useState([]); // {id, role, text, tools[], state, verify?, checked?}
  const [busy, setBusy] = useState(false);
  const [mockMode, setMockMode] = useState(false);

  const abortRef = useRef(null);
  // Unmount guard: React StrictMode dev double-mount would otherwise let an
  // in-flight stream setState on a dead component. Same pattern as the
  // EvolutionChain `cancelled` flag elsewhere in this app.
  const disposedRef = useRef(false);

  useEffect(() => {
    // Ask the server once whether it runs with a real model or the mock,
    // so the UI can badge demo mode honestly instead of pretending.
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setMockMode(Boolean(h?.mock)))
      .catch(() => {});
    return () => {
      disposedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // context (the pokemon currently on screen) is a render-time value; keep a
  // ref so send() reads the latest without being re-created every render.
  const contextRef = useRef(context);
  contextRef.current = context;

  const patchLast = useCallback((patch) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  const patchTool = useCallback((id, patch) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      const tools = (last.tools ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t));
      // "start" for an id we haven't seen yet (defensive; server sends start first)
      if (!tools.some((t) => t.id === id)) tools.push({ id, ...patch });
      next[next.length - 1] = { ...last, tools };
      return next;
    });
  }, []);

  const send = useCallback(
    async (question) => {
      const text = question.trim();
      if (!text || abortRef.current) return; // one stream at a time

      // Server speaks OpenAI roles ("user"/"assistant"); the client model
      // calls the assistant "ai" — translate here, at the only boundary.
      const history = messages.map((m) => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.fullText ?? m.text,
      }));
      setMessages((prev) => [
        ...prev,
        { id: nextId++, role: "user", text, state: "done" },
        { id: nextId++, role: "ai", text: "", tools: [], state: "streaming" },
      ]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [...history, { role: "user", content: text }],
            context: contextRef.current,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          // Non-SSE failure (400/500/proxy page): surface a readable error.
          let message = `请求失败 (HTTP ${res.status})`;
          try {
            const j = await res.json();
            if (j?.message) message = j.message;
          } catch {}
          patchLast({ state: "error", text: message });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "message";

        const handleEvent = (dataLine) => {
          let payload;
          try {
            payload = JSON.parse(dataLine);
          } catch {
            return;
          }
          switch (eventName) {
            case "delta":
              if (payload.text)
                setMessages((prev) => {
                  if (prev.length === 0) return prev;
                  const next = prev.slice();
                  const last = next[next.length - 1];
                  next[next.length - 1] = { ...last, text: last.text + payload.text };
                  return next;
                });
              break;
            case "tool":
              patchTool(payload.id, {
                name: payload.name,
                argsSummary: toolArgsSummary(payload.name, payload.args),
                status: payload.status,
                summary: payload.summary ?? "",
              });
              break;
            case "replace":
              patchLast({ text: payload.text ?? "" });
              break;
            case "error":
              patchLast({ state: "error", text: payload.message ?? "AI 服务出错了" });
              break;
            case "done":
              patchLast({
                state: "done",
                verify: payload.verify,
                checked: payload.checked,
              });
              break;
            default:
              break;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            eventName = "message";
            const dataLines = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length > 0) handleEvent(dataLines.join("\n"));
          }
        }

        // Stream closed. If no done/error arrived (e.g. server restarted
        // mid-stream), don't leave the bubble stuck in "streaming".
        patchLastIfStreaming();
      } catch (err) {
        if (err?.name === "AbortError") {
          patchLast({ state: "interrupted" });
        } else if (!disposedRef.current) {
          patchLast({ state: "error", text: "网络异常,请检查连接后重试。" });
        }
      } finally {
        abortRef.current = null;
        if (!disposedRef.current) setBusy(false);
      }

      function patchLastIfStreaming() {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== "ai" || last.state !== "streaming") return prev;
          const next = prev.slice();
          next[next.length - 1] = {
            ...last,
            state: last.text ? "done" : "error",
            text: last.text || "回答被中断了,请重试。",
          };
          return next;
        });
      }
    },
    [messages, patchLast, patchTool]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (abortRef.current) return; // don't wipe history under a live stream
    setMessages([]);
  }, []);

  return { messages, busy, mockMode, send, stop, clear };
}
