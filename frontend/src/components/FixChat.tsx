import { useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import "./FixChat.css";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const SUGGESTED = [
  "Why did you change this specific line?",
  "Are there other places in the codebase with the same bug?",
  "What would happen if we used a different approach?",
  "Is this fix safe to auto-merge?",
];

function getToken(): string | null {
  return localStorage.getItem("neurodeploy_token");
}

function parseSseChunk(buffer: string): { tokens: string[]; rest: string } {
  const lines = buffer.split("\n");
  const tokens: string[] = [];
  let rest = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("data: ")) {
      if (i === lines.length - 1) {
        rest = line;
      }
      continue;
    }

    try {
      const payload = JSON.parse(line.slice(6));
      if (payload?.token) {
        tokens.push(payload.token);
      }
    } catch {
      continue;
    }
  }

  return { tokens, rest };
}

export function FixChat({ jobId }: { jobId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about this fix — why changes were made, alternative approaches, or patterns in the codebase.",
    },
  ]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedPrompts = useMemo(() => SUGGESTED, []);

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    const userMsg = input.trim();
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: userMsg }, { role: "assistant", content: "" }]);
    setStreaming(true);

    const res = await fetch(`/api/jobs/${jobId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: JSON.stringify({ message: userMsg }),
    });

    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to start chat");
      setStreaming(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantMsg = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      if (parsed.tokens.length > 0) {
        assistantMsg += parsed.tokens.join("");
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: assistantMsg };
          return updated;
        });
      }
    }

    setStreaming(false);
  };

  return (
    <div className="fix-chat">
      <div className="fix-chat-header">
        <div>
          <h2>Fix Debugger</h2>
          <p>Ask questions about the fix, alternatives, or related patterns in the codebase.</p>
        </div>
        {streaming && <Badge variant="pending">Thinking…</Badge>}
      </div>

      <div className="fix-chat-messages">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`fix-chat-message ${message.role}`}>
            <div className="fix-chat-avatar">{message.role === "assistant" ? "ND" : "You"}</div>
            <div className="fix-chat-bubble">{message.content}</div>
          </div>
        ))}
      </div>

      {messages.length === 1 && (
        <div className="fix-chat-suggestions">
          {suggestedPrompts.map((prompt) => (
            <button key={prompt} onClick={() => setInput(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      )}

      {error && <div className="fix-chat-error">{error}</div>}

      <div className="fix-chat-input">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && sendMessage()}
          placeholder="Ask about this fix..."
        />
        <Button size="sm" onClick={sendMessage} disabled={streaming}>
          Send
        </Button>
      </div>
    </div>
  );
}

export default FixChat;
