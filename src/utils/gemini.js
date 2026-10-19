import axios from 'axios';
import { API_URL } from '../config/api';

// Gemini is now called through OUR backend (/api/mentor/ask) so the API key
// never reaches the browser. User must be logged in.
export const askGemini = async (message) => {
  try {
    const token = localStorage.getItem('token');
    const { data } = await axios.post(
      `${API_URL}/mentor/ask`,
      { prompt: message },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data?.reply || '🤖 No response from AI.';
  } catch (error) {
    console.error('AI request failed:', error?.response?.data?.message || error.message);
    return error?.response?.data?.message || '❌ Failed to get a response from AI.';
  }
};
