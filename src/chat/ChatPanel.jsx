// ChatPanel — floating AI Q&A over the dex.
//
// UI states map 1:1 to the message state machine in useChat:
//   streaming → live text + tool chips + stop button
//   done      → verify badge (✓ 已核对 / ↻ 已自动校正 / ⚠ 数据存疑)
//   error     → readable message + 重试
// The panel mounts collapsed: the dex card stays the hero, the assistant
// is one click away (same "keep the card in focus" logic as the search box).

import { useEffect, useRef, useState } from "react";
import { useChat, TOOL_LABELS } from "./useChat.js";
import "./chat.css";

const SUGGESTIONS = [
  "帮我看看皮卡丘的种族值",
  "妙蛙种子的进化链是什么样的?",
  "水系怕什么属性?推荐几只克制它的",
];

const VERIFY_BADGES = {
  pass: { label: "已核对图鉴数据", icon: "✓", cls: "ok" },
  corrected: { label: "发现偏差,已自动校正", icon: "↻", cls: "fix" },
  warn: { label: "部分数据存疑,以图鉴为准", icon: "⚠", cls: "warn" },
};

function ToolChip({ tool }) {
  const label = TOOL_LABELS[tool.name] ?? tool.name;
  const target = tool.argsSummary ? `:${tool.argsSummary}` : "";
  const icon = tool.status === "done" ? (tool.summary?.includes("✗") ? "✗" : "✓") : "…";
  return (
    <span className={`ai-tool ${tool.status === "done" ? "is-done" : "is-running"}`}>
      <span className="ai-tool-icon" aria-hidden="true">{icon}</span>
      {label}
      {target}
    </span>
  );
}

const Message = ({ msg, onRetry }) => (
  <div className={`ai-msg ai-msg-${msg.role}`}>
    <div className="ai-bubble">
      {msg.role === "ai" && (msg.tools?.length ?? 0) > 0 && (
        <div className="ai-tools">
          {msg.tools.map((t) => (
            <ToolChip key={t.id} tool={t} />
          ))}
        </div>
      )}
      {msg.text ? <div className="ai-text">{msg.text}</div> : null}
      {msg.state === "streaming" && <span className="ai-cursor" aria-hidden="true" />}
      {msg.state === "error" && (
        <div className="ai-err">
          <span role="alert">{msg.text}</span>
          <button type="button" className="ai-retry" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {msg.state === "interrupted" && <div className="ai-note">已停止回答</div>}
      {msg.role === "ai" && msg.verify && msg.state === "done" && VERIFY_BADGES[msg.verify] && (
        <div className={`ai-verify ai-verify-${VERIFY_BADGES[msg.verify].cls}`}>
          <span aria-hidden="true">{VERIFY_BADGES[msg.verify].icon}</span>
          {msg.checked > 0 ? `${VERIFY_BADGES[msg.verify].label}(${msg.checked} 项)` : VERIFY_BADGES[msg.verify].label}
        </div>
      )}
    </div>
  </div>
);

const ChatPanel = ({ context }) => {
  const [open, setOpen] = useState(false);
  const { messages, busy, mockMode, send, stop, clear } = useChat(context);
  const [input, setInput] = useState("");
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // Keep the newest message in view while streaming. Only auto-scroll when
  // the user hasn't scrolled up to read — respecting manual scroll wins.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  function submit(e) {
    e.preventDefault();
    const text = input;
    if (!text.trim() || busy) return;
    setInput("");
    send(text);
  }

  if (!open) {
    return (
      <button type="button" className="ai-fab" onClick={() => setOpen(true)} aria-label="打开 AI 问答">
        🤖 <span>问图鉴</span>
      </button>
    );
  }

  return (
    <section className="ai-panel" aria-label="AI 图鉴问答">
      <header className="ai-head">
        <div className="ai-title">
          图鉴助手
          {mockMode && <span className="ai-mock-badge">演示模式</span>}
        </div>
        <div className="ai-head-actions">
          {messages.length > 0 && (
            <button type="button" className="ai-icon-btn" onClick={clear} disabled={busy} title="清空对话">
              🗑
            </button>
          )}
          <button type="button" className="ai-icon-btn" onClick={() => setOpen(false)} title="收起" aria-label="收起">
            ✕
          </button>
        </div>
      </header>

      <div className="ai-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p>问我任何宝可梦问题,我会实时查 PokeAPI 再回答:</p>
            <div className="ai-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} msg={m} onRetry={() => send(m.role === "user" ? m.text : messages[messages.length - 2]?.text ?? "")} />
        ))}
      </div>

      <form className="ai-inputrow" onSubmit={submit}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "回答中…" : "例如:伊布有几种进化?"}
          disabled={busy}
          maxLength={500}
          aria-label="输入问题"
        />
        {busy ? (
          <button type="button" className="ai-send is-stop" onClick={stop}>
            ■ 停止
          </button>
        ) : (
          <button type="submit" className="ai-send" disabled={!input.trim()}>
            发送
          </button>
        )}
      </form>
    </section>
  );
};

export default ChatPanel;
