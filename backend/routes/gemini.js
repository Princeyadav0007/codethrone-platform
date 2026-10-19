import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { generateReply, GeminiError } from '../services/geminiService.js';

const router = express.Router();

// Logged-in users only (this used to be public, which let anyone burn the API quota).
router.post('/', authenticateToken, async (req, res) => {
  const { prompt, context, problemData } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ reply: 'Prompt is required.' });
  }

  let fullContext = prompt;

  if (problemData) {
    fullContext = `
PROBLEM CONTEXT:
Title: ${problemData.title}
Difficulty: ${problemData.difficulty}
Description: ${problemData.description}

Tags: ${problemData.tags ? problemData.tags.join(', ') : 'N/A'}
Companies: ${problemData.companies ? problemData.companies.join(', ') : 'N/A'}

${problemData.constraints ? `Constraints: ${problemData.constraints}` : ''}

${problemData.examples && problemData.examples.length > 0
  ? `Examples:\n${problemData.examples.map((ex, i) =>
      `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}\n${ex.explanation ? `Explanation: ${ex.explanation}` : ''}`
    ).join('\n\n')}`
  : ''}

You are an AI coding assistant helping with this specific problem. Provide helpful guidance about algorithms, data structures, approach, and optimization techniques relevant to this problem. Do not provide the complete solution code unless explicitly asked. Focus on explaining concepts, giving hints, and helping the user understand the problem better.

USER QUESTION: ${prompt}
`;
  } else if (context) {
    fullContext = `${context}\n\nUSER QUESTION: ${prompt}`;
  }

  try {
    const reply = await generateReply({ contents: [{ role: 'user', parts: [{ text: fullContext }] }] });
    res.json({ reply });
  } catch (err) {
    const status = err instanceof GeminiError ? err.status : 500;
    const reply = err instanceof GeminiError ? err.message : 'Something went wrong while generating AI response.';
    res.status(status).json({ reply });
  }
});

export default router;
