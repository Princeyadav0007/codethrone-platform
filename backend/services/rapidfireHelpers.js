// Shared helpers for the Rapid Fire REST routes and socket handlers.
import RapidFireGame from '../models/RapidFireGame.js';

export const GAME_DURATION_S = 120;
const WAITING_GRACE_MS = 30 * 1000;        // a brand-new game: its creator's socket may still be connecting
const FINISHED_GRACE_S = 60;               // an "ongoing" game this much past its time limit is dead

export const roomName = (gameId) => `rapidfire-${gameId}`;

/**
 * Remove everything that gives away the answer before a question is sent to a browser:
 * the isCorrect flag of every option and the explanation (it usually says which option is right).
 * The server keeps the full question and tells each player the result AFTER they answered
 * (see the 'answer-result' socket event).
 */
export const stripAnswers = (question) => {
  if (!question) return question;
  const q = typeof question.toObject === 'function' ? question.toObject() : question;
  // eslint-disable-next-line no-unused-vars
  const { explanation, ...rest } = q;
  return { ...rest, options: (q.options || []).map(({ isCorrect, ...option }) => option) };
};

export const sanitizeQuestions = (questions) => (questions || []).map(stripAnswers);

/** A game document (or plain object) that is safe to send to players. */
export const sanitizeGame = (game) => {
  const g = typeof game.toObject === 'function' ? game.toObject() : { ...game };
  if (Array.isArray(g.questionSet)) {
    g.questionSet = g.questionSet.map((q) => (q && typeof q === 'object' && Array.isArray(q.options) ? stripAnswers(q) : q));
  }
  return g;
};

/**
 * A waiting game is only worth joining if its creator is really there: it was created a moment ago,
 * or at least one socket is currently inside the game room. Otherwise it is a "ghost"
 * (creator closed the tab / server restarted) and joining it would start a game with nobody in it.
 */
export async function isWaitingGameAlive(io, game) {
  if (Date.now() - new Date(game.createdAt).getTime() < WAITING_GRACE_MS) return true;
  if (!io) return true;
  try {
    const sockets = await io.in(roomName(game._id)).fetchSockets();
    return sockets.length > 0;
  } catch {
    return true; // cannot tell: do not throw a player's game away
  }
}

/**
 * Clean up games this user is "in" that can never finish, and return the one that is still alive (or null).
 * Without this, Find Match kept returning an old dead game and two players never met.
 */
export async function releaseUserStaleGames(io, userId) {
  const games = await RapidFireGame.find({
    'players.user': userId,
    status: { $in: ['waiting', 'ongoing'] },
  });

  let alive = null;
  for (const game of games) {
    if (game.status === 'ongoing') {
      const startedAt = new Date(game.startTime || game.createdAt).getTime();
      if (Date.now() > startedAt + (GAME_DURATION_S + FINISHED_GRACE_S) * 1000) {
        game.status = 'abandoned';
        game.endTime = new Date();
        await game.save();
        continue;
      }
      alive = alive || game;
    } else if (await isWaitingGameAlive(io, game)) {
      alive = alive || game;
    } else {
      await RapidFireGame.deleteOne({ _id: game._id, status: 'waiting' });
    }
  }
  return alive;
}
