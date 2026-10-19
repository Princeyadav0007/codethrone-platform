import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import toast from 'react-hot-toast';
import {
  Bot,
  Check,
  Copy,
  Loader2,
  Menu,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { API_URL } from '../config/api';

interface ChatMessage {
  _id?: string;
  role: 'user' | 'model';
  content: string;
  createdAt?: string;
}

interface ConversationSummary {
  _id: string;
  title: string;
  updatedAt: string;
}

const SUGGESTIONS = [
  'Explain Binary Search with an example',
  'Two Sum problem ka approach samjhao',
  'Difference between BFS and DFS?',
  'How do I prepare for a coding interview in 30 days?',
];

const MAX_CHARS = 4000;

// ---------- Code block with copy button ----------
const CodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({ children, ...props }) => {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = preRef.current?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <div className="relative group my-3">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-gray-700/80 px-2 py-1 text-xs text-gray-100 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-600"
        aria-label="Copy code"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={preRef} {...props} className="overflow-x-auto rounded-lg bg-[#0d1117] p-4 text-sm">
        {children}
      </pre>
    </div>
  );
};

// ---------- Markdown renderer ----------
const Markdown: React.FC<{ text: string; isDark: boolean }> = ({ text, isDark }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    components={{
      pre: CodeBlock,
      code: ({ className, children, ...props }) => {
        const isBlock = /language-|hljs/.test(className || '');
        return isBlock ? (
          <code className={className} {...props}>{children}</code>
        ) : (
          <code
            className={`rounded px-1.5 py-0.5 text-[0.85em] ${isDark ? 'bg-gray-700 text-orange-300' : 'bg-gray-100 text-orange-700'}`}
            {...props}
          >
            {children}
          </code>
        );
      },
      p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
      ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-6">{children}</ul>,
      ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-6">{children}</ol>,
      h1: ({ children }) => <h1 className="mb-2 mt-4 text-xl font-bold">{children}</h1>,
      h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-bold">{children}</h2>,
      h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold">{children}</h3>,
      a: ({ children, href }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-orange-500 underline">
          {children}
        </a>
      ),
      blockquote: ({ children }) => (
        <blockquote className="mb-3 border-l-4 border-orange-500 pl-4 italic opacity-90">{children}</blockquote>
      ),
      table: ({ children }) => (
        <div className="mb-3 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className={`border px-3 py-1.5 text-left font-semibold ${isDark ? 'border-gray-600 bg-gray-700' : 'border-gray-300 bg-gray-100'}`}>{children}</th>
      ),
      td: ({ children }) => (
        <td className={`border px-3 py-1.5 ${isDark ? 'border-gray-600' : 'border-gray-300'}`}>{children}</td>
      ),
    }}
  >
    {text}
  </ReactMarkdown>
);

// ---------- Page ----------
const AIMentor: React.FC = () => {
  const { token, user } = useAuth();
  const { isDark } = useTheme();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const authHeaders = useCallback(
    () => ({ Authorization: `Bearer ${token || localStorage.getItem('token')}` }),
    [token],
  );

  const errorMessage = (err: any) =>
    err?.response?.data?.message || 'Something went wrong. Please try again.';

  const loadConversations = useCallback(async () => {
    try {
      const { data } = await axios.get<ConversationSummary[]>(`${API_URL}/mentor/conversations`, {
        headers: authHeaders(),
      });
      setConversations(data);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [authHeaders]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const openConversation = async (id: string) => {
    setSidebarOpen(false);
    if (id === activeId) return;
    setLoadingChat(true);
    try {
      const { data } = await axios.get(`${API_URL}/mentor/conversations/${id}`, { headers: authHeaders() });
      setActiveId(id);
      setMessages(data.messages || []);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingChat(false);
    }
  };

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setInput('');
    setSidebarOpen(false);
    textareaRef.current?.focus();
  };

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat?')) return;
    try {
      await axios.delete(`${API_URL}/mentor/conversations/${id}`, { headers: authHeaders() });
      setConversations((prev) => prev.filter((c) => c._id !== id));
      if (id === activeId) newChat();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const sendMessage = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    if (content.length > MAX_CHARS) {
      toast.error(`Message is too long (max ${MAX_CHARS} characters)`);
      return;
    }

    const optimistic: ChatMessage = { role: 'user', content };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    setSending(true);

    try {
      const { data } = await axios.post(
        `${API_URL}/mentor/chat`,
        { message: content, conversationId: activeId },
        { headers: authHeaders() },
      );
      setMessages((prev) => [...prev, { role: 'model', content: data.reply.content, _id: data.reply._id }]);

      if (!activeId) {
        setActiveId(data.conversationId);
        setConversations((prev) => [
          { _id: data.conversationId, title: data.title, updatedAt: data.updatedAt },
          ...prev,
        ]);
      } else {
        setConversations((prev) => {
          const current = prev.find((c) => c._id === activeId);
          const rest = prev.filter((c) => c._id !== activeId);
          return current ? [{ ...current, updatedAt: data.updatedAt }, ...rest] : prev;
        });
      }
    } catch (err) {
      // roll back the optimistic message and give the text back to the user
      setMessages((prev) => prev.slice(0, -1));
      setInput(content);
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ---- theme classes ----
  const bg = isDark ? 'bg-gray-900 text-gray-100' : 'bg-gray-50 text-gray-900';
  const panel = isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
  const muted = isDark ? 'text-gray-400' : 'text-gray-500';

  const Sidebar = (
    <div className={`flex h-full w-72 flex-col border-r ${panel}`}>
      <div className="p-3">
        <button
          onClick={newChat}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-700"
        >
          <Plus size={16} /> New chat
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 && (
          <p className={`px-3 py-6 text-center text-sm ${muted}`}>No chats yet. Ask your first question!</p>
        )}
        {conversations.map((c) => (
          <div
            key={c._id}
            onClick={() => openConversation(c._id)}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
              c._id === activeId
                ? isDark ? 'bg-gray-700' : 'bg-orange-50 text-orange-700'
                : isDark ? 'hover:bg-gray-700/60' : 'hover:bg-gray-100'
            }`}
          >
            <MessageSquare size={14} className="shrink-0 opacity-70" />
            <span className="flex-1 truncate">{c.title}</span>
            <button
              onClick={(e) => deleteConversation(c._id, e)}
              className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
              aria-label="Delete chat"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`flex h-[calc(100vh-64px)] ${bg}`}>
      {/* Desktop sidebar */}
      <div className="hidden md:block">{Sidebar}</div>

      {/* Mobile sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="relative">
            {Sidebar}
            <button
              onClick={() => setSidebarOpen(false)}
              className="absolute right-2 top-2 rounded p-1"
              aria-label="Close sidebar"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 bg-black/50" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* Chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={`flex items-center gap-3 border-b px-4 py-3 ${panel}`}>
          <button className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Menu size={20} />
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-600 text-white">
            <Bot size={20} />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">AI Mentor</h1>
            <p className={`text-xs ${muted}`}>Ask me anything — coding, DSA, career, studies</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {loadingChat && (
              <div className="flex justify-center py-10"><Loader2 className="animate-spin text-orange-500" /></div>
            )}

            {!loadingChat && messages.length === 0 && (
              <div className="flex flex-col items-center pt-10 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-600 text-white">
                  <Sparkles size={30} />
                </div>
                <h2 className="text-2xl font-bold">Hi {user?.username || 'there'}, I'm your AI Mentor</h2>
                <p className={`mt-2 max-w-md ${muted}`}>
                  Ask me about any problem, concept, or topic. I reply in English, Hindi or Hinglish — your choice.
                </p>
                <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => sendMessage(s)}
                      className={`rounded-xl border p-4 text-left text-sm transition-colors hover:border-orange-500 ${panel}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={m._id || i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
                {m.role === 'model' && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-600 text-white">
                    <Bot size={16} />
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                    m.role === 'user'
                      ? 'bg-orange-600 text-white whitespace-pre-wrap'
                      : `border ${panel}`
                  }`}
                >
                  {m.role === 'user' ? m.content : <Markdown text={m.content} isDark={isDark} />}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex gap-3">
                <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-600 text-white">
                  <Bot size={16} />
                </div>
                <div className={`flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm ${panel} ${muted}`}>
                  <Loader2 size={14} className="animate-spin" /> Thinking…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input */}
        <div className={`border-t p-4 ${panel}`}>
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              maxLength={MAX_CHARS}
              placeholder="Ask anything… (Enter to send, Shift+Enter for new line)"
              className={`max-h-40 flex-1 resize-none rounded-xl border px-4 py-3 text-sm outline-none focus:border-orange-500 ${
                isDark ? 'border-gray-600 bg-gray-900 placeholder-gray-500' : 'border-gray-300 bg-white placeholder-gray-400'
              }`}
            />
            <button
              onClick={() => sendMessage()}
              disabled={sending || !input.trim()}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Send message"
            >
              {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
          <p className={`mx-auto mt-2 max-w-3xl text-center text-xs ${muted}`}>
            AI can make mistakes. Double-check important answers.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AIMentor;
