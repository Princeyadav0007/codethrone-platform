import React, { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import { normalizeLegacyAiText } from '../utils/aiPrompt';

// Code block with a copy button
const CodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({ children, ...props }) => {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(preRef.current?.innerText || '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; nothing else to do */
    }
  };

  return (
    <div className="relative group my-3">
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-gray-700/80 px-2 py-1 text-xs text-gray-100 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-600"
        aria-label="Copy code"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={preRef} {...props} className="overflow-x-auto rounded-lg bg-[#0d1117] p-4 text-sm text-gray-100">
        {children}
      </pre>
    </div>
  );
};

/**
 * Renders AI answers safely as Markdown.
 * Raw HTML in the text is NOT interpreted (react-markdown escapes it), so code such as
 * "vector<int>" or "#include <bits/stdc++.h>" is shown exactly as written and nothing can inject scripts.
 */
const AiMarkdown: React.FC<{ text: string }> = ({ text }) => (
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
          <code className="rounded px-1.5 py-0.5 text-[0.85em] bg-blue-100 dark:bg-gray-700 text-blue-900 dark:text-orange-300" {...props}>
            {children}
          </code>
        );
      },
      // whitespace-pre-wrap keeps line breaks of older plain-text answers
      p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed whitespace-pre-wrap">{children}</p>,
      ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-6">{children}</ul>,
      ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-6">{children}</ol>,
      h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-bold">{children}</h1>,
      h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-bold">{children}</h2>,
      h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold">{children}</h3>,
      a: ({ children, href }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 underline">{children}</a>
      ),
      table: ({ children }) => (
        <div className="mb-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{children}</table></div>
      ),
      th: ({ children }) => <th className="border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 px-3 py-1.5 text-left font-semibold">{children}</th>,
      td: ({ children }) => <td className="border border-gray-300 dark:border-gray-600 px-3 py-1.5">{children}</td>,
    }}
  >
    {normalizeLegacyAiText(text)}
  </ReactMarkdown>
);

export default AiMarkdown;
