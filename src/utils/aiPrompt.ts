/**
 * Chat answers saved by older versions use a plain-text format:
 *   PYTHON CODE
 *   // START OF CODE
 *   ...
 *   // END OF CODE
 * Convert them to normal Markdown code fences so old chat history still displays properly.
 * (The AI prompt itself is now built on the server: backend/services/problemAssistant.js)
 */
export function normalizeLegacyAiText(text: string): string {
  return text.replace(
    /(?:^|\n)[ \t]*([A-Za-z+#]+)[ \t]+CODE[ \t]*\n+[ \t]*\/\/ START OF CODE[ \t]*\n([\s\S]*?)\n[ \t]*\/\/ END OF CODE[ \t]*/gi,
    (_m, lang: string, body: string) => {
      const l = lang.toLowerCase().replace('c++', 'cpp');
      return `\n\`\`\`${l}\n${body}\n\`\`\`\n`;
    }
  );
}
