import RapidFireGame from '../models/RapidFireGame.js';
import MCQQuestion from '../models/MCQQuestion.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { sanitizeQuestions, stripAnswers, roomName } from '../services/rapidfireHelpers.js';

console.log('🔥 BULLETPROOF Rapid Fire socket handlers loading...');

// Store active rapid fire games and their timers
const activeRapidFireGames = new Map();
const GAME_DURATION = 120; // 120 seconds
const TOTAL_QUESTIONS = 10;

// BULLETPROOF helper function to fetch questions independently
const fetchQuestionsForGame = async (questionIds) => {
  try {
    console.log('🔥 BULLETPROOF: Fetching questions for IDs:', questionIds.map(id => id.toString()));
    
    const found = await MCQQuestion.find({ 
      _id: { $in: questionIds }
    }).lean();

    // MongoDB returns documents in its own order, not in the order stored in the game. Put them back in the
    // game's order so the socket events, the REST response and the server's grading all agree on "question 1".
    const byId = new Map(found.map(q => [String(q._id), q]));
    const questions = questionIds.map(id => byId.get(String(id))).filter(Boolean);
    
    console.log('✅ BULLETPROOF: Questions fetched:', questions.length);
    
    // Validate each question
    const validQuestions = questions.filter(q => 
      q && q.question && q.options && Array.isArray(q.options) && q.options.length >= 4
    );
    
    console.log('✅ BULLETPROOF: Valid questions:', validQuestions.length);
    
    return validQuestions;
  } catch (error) {
    console.error('❌ BULLETPROOF: Error fetching questions:', error);
    return [];
  }
};

// BULLETPROOF: Smart random question generator with unique selection
const generateRandomQuestions = async (count = TOTAL_QUESTIONS) => {
  try {
    console.log('🎲 BULLETPROOF: Generating random questions, count:', count);
    
    // Get all available MCQ questions
    const allQuestions = await MCQQuestion.find({ domain: 'dsa' }).lean();
    console.log('📚 Available questions in database:', allQuestions.length);
    
    if (allQuestions.length < count) {
      console.warn('⚠️ Not enough questions in database, using all available');
      return allQuestions.slice(0, count);
    }
    
    // Shuffle and select unique questions
    const shuffled = allQuestions.sort(() => Math.random() - 0.5);
    const selectedQuestions = shuffled.slice(0, count);
    
    console.log('✅ BULLETPROOF: Selected random questions:', selectedQuestions.length);
    return selectedQuestions;
  } catch (error) {
    console.error('❌ BULLETPROOF: Error generating random questions:', error);
    return [];
  }
};

// BULLETPROOF: Calculate Elo rating changes (like Chess.com)
const calculateEloRatingChange = (playerRating, opponentRating, result, kFactor = 32) => {
  // result: 1 for win, 0 for loss, 0.5 for draw
  const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  const ratingChange = Math.round(kFactor * (result - expectedScore));
  return ratingChange;
};

// BULLETPROOF: End game function
// The end of a game can be requested by several things at once (the end timer, the two sync loops, a client
// event). Only the first request may run; the others used to repeat it and counted every game twice.
const endingGames = new Set();
const endRapidFireGame = async (gameId, io) => {
  const id = String(gameId);
  if (endingGames.has(id)) return;
  endingGames.add(id);
  try {
    await finishRapidFireGame(gameId, io);
  } finally {
    endingGames.delete(id);
  }
};

const finishRapidFireGame = async (gameId, io) => {
  try {
    console.log('🏁 BULLETPROOF: Ending rapid fire game:', gameId);

    const game = await RapidFireGame.findById(gameId)
      .populate('players.user', 'username profile.avatar ratings.rapidFireRating');

    if (!game || game.status === 'finished') {
      // The game was deleted or already ended: stop its timers, otherwise they fire (and log) forever.
      if (!game) console.error('❌ Game not found for ending:', gameId);
      const leftover = activeRapidFireGames.get(String(gameId));
      if (leftover) {
        clearTimeout(leftover.timer);
        clearInterval(leftover.updateTimer);
        clearInterval(leftover.timerSyncInterval);
        activeRapidFireGames.delete(String(gameId));
      }
      return;
    }

    // Mark game as finished
    game.status = 'finished';
    game.endTime = new Date();

    // Sort players by score
    const sortedPlayers = [...game.players].sort((a, b) => b.score - a.score);
    
    // Determine winner
    if (sortedPlayers.length >= 2) {
      const topScore = sortedPlayers[0].score;
      const winners = sortedPlayers.filter(p => p.score === topScore);
      
      if (winners.length === 1) {
        game.winner = winners[0].user._id;
        game.result = 'win'; // the schema enum is win / draw / timeout / cancelled / opponent_left ('winner' made game.save() fail)
      } else {
        game.result = 'draw';
      }
    }

    // Calculate rating changes
    const ratingUpdates = [];
    
    if (sortedPlayers.length === 2) {
      const [player1, player2] = sortedPlayers;
      
      // Handle tie case
      const isDraw = player1.score === player2.score;
      
      // Assign ranks
      player1.rank = 1;
      player2.rank = isDraw ? 1 : 2;
      
      const player1OldRating = player1.user.ratings?.rapidFireRating || 1200;
      const player2OldRating = player2.user.ratings?.rapidFireRating || 1200;
      
      // Store old ratings in game
      player1.ratingBefore = player1OldRating;
      player2.ratingBefore = player2OldRating;
      
      // Calculate rating changes
      const player1Change = calculateEloRatingChange(
        player1OldRating, 
        player2OldRating, 
        isDraw ? 0.5 : 1,
        32 // K-factor for rapid fire
      );
      const player2Change = calculateEloRatingChange(
        player2OldRating, 
        player1OldRating, 
        isDraw ? 0.5 : 0,
        32
      );
      
      // Update ratings in database
      const player1User = await User.findById(player1.user._id);
      const player2User = await User.findById(player2.user._id);
      
      if (player1User) {
        const newRating = Math.max(100, player1OldRating + player1Change);
        player1User.ratings.rapidFireRating = newRating;
        player1.ratingAfter = newRating;
        player1.ratingChange = player1Change;
        
        // Update comprehensive rapidfire stats (matching leaderboard field structure)
        if (!player1User.stats) player1User.stats = {};
        
        // Update the fields expected by the leaderboard
        player1User.stats.rapidFireGamesPlayed = (player1User.stats.rapidFireGamesPlayed || 0) + 1;
        
        if (isDraw) {
          player1User.stats.rapidFireGamesTied = (player1User.stats.rapidFireGamesTied || 0) + 1;
        } else if (player1.score > player2.score) {
          player1User.stats.rapidFireGamesWon = (player1User.stats.rapidFireGamesWon || 0) + 1;
        } else {
          player1User.stats.rapidFireGamesLost = (player1User.stats.rapidFireGamesLost || 0) + 1;
        }
        
        // Update recentGameForm for form tracking
        if (!player1User.recentGameForm) player1User.recentGameForm = [];
        // The User schema only accepts 'W' / 'L' / 'D'. Writing 'win' / 'loss' / 'draw' made user.save() fail,
        // so no Rapid Fire game could ever be finished (no ratings, no result screen).
        const gameResult = isDraw ? 'D' : (player1.score > player2.score ? 'W' : 'L');
        player1User.recentGameForm.unshift({
          gameType: 'rapidfire',
          result: gameResult,
          date: new Date(),
          ratingChange: player1Change
        });
        // Keep only last 10 games
        if (player1User.recentGameForm.length > 10) {
          player1User.recentGameForm = player1User.recentGameForm.slice(0, 10);
        }
        
        await player1User.save();
        
        ratingUpdates.push({
          userId: player1.user._id,
          oldRating: player1OldRating,
          newRating: newRating,
          change: player1Change
        });
      }
      
      if (player2User) {
        const newRating = Math.max(100, player2OldRating + player2Change);
        player2User.ratings.rapidFireRating = newRating;
        player2.ratingAfter = newRating;
        player2.ratingChange = player2Change;
        
        // Update comprehensive rapidfire stats (matching leaderboard field structure)
        if (!player2User.stats) player2User.stats = {};
        
        // Update the fields expected by the leaderboard
        player2User.stats.rapidFireGamesPlayed = (player2User.stats.rapidFireGamesPlayed || 0) + 1;
        
        if (isDraw) {
          player2User.stats.rapidFireGamesTied = (player2User.stats.rapidFireGamesTied || 0) + 1;
        } else if (player2.score > player1.score) {
          player2User.stats.rapidFireGamesWon = (player2User.stats.rapidFireGamesWon || 0) + 1;
        } else {
          player2User.stats.rapidFireGamesLost = (player2User.stats.rapidFireGamesLost || 0) + 1;
        }
        
        // Update recentGameForm for form tracking
        if (!player2User.recentGameForm) player2User.recentGameForm = [];
        const gameResult = isDraw ? 'D' : (player2.score > player1.score ? 'W' : 'L');
        player2User.recentGameForm.unshift({
          gameType: 'rapidfire',
          result: gameResult,
          date: new Date(),
          ratingChange: player2Change
        });
        // Keep only last 10 games
        if (player2User.recentGameForm.length > 10) {
          player2User.recentGameForm = player2User.recentGameForm.slice(0, 10);
        }
        
        await player2User.save();
        
        ratingUpdates.push({
          userId: player2.user._id,
          oldRating: player2OldRating,
          newRating: newRating,
          change: player2Change
        });
      }

      console.log('🏆 BULLETPROOF: Rating changes and stats applied:', ratingUpdates);
    }

    await game.save();

    // Format results for the frontend GameEndModal
    const gameResults = sortedPlayers.map(p => {
      const isDraw = sortedPlayers[0].score === sortedPlayers[1]?.score;
      return {
        userId: p.user._id,
        username: p.user.username,
        score: p.score,
        correctAnswers: p.correctAnswers || 0,
        wrongAnswers: p.wrongAnswers || 0,
        questionsAnswered: p.questionsAnswered || 0,
        rank: p.rank,
        result: p.rank === 1 ? (isDraw ? 'draw' : 'win') : 'loss',
        oldRating: p.ratingBefore || 1200,
        newRating: p.ratingAfter || p.ratingBefore || 1200,
        ratingChange: p.ratingChange || 0
      };
    });

    // Emit both events for compatibility
    io.to(`rapidfire-${gameId}`).emit('rapidfire-game-finished', {
      gameId,
      result: game.result,
      winner: game.winner,
      finalState: game,
      finalScores: gameResults,
      ratingUpdates,
      gameDetails: {
        totalQuestions: game.totalQuestions,
        duration: game.timeLimit,
        gameResult: game.result,
        winner: game.winner
      }
    });

    // BULLETPROOF: Also emit the newer format expected by frontend
    io.to(`rapidfire-${gameId}`).emit('rapidfire-game-ended', {
      results: gameResults,
      ratingUpdates: ratingUpdates.map(update => ({
        ...update,
        userId: update.userId.toString()
      })),
      gameId,
      finalState: game
    });

    console.log('🏁 BULLETPROOF: Game end events emitted with results:', gameResults);

    // Clean up active game and all timers
    const activeGame = activeRapidFireGames.get(gameId);
    if (activeGame?.timer) {
      clearTimeout(activeGame.timer);
    }
    if (activeGame?.updateTimer) {
      clearInterval(activeGame.updateTimer);
    }
    if (activeGame?.timerSyncInterval) {
      clearInterval(activeGame.timerSyncInterval);
    }
    activeRapidFireGames.delete(gameId);

    console.log('🧹 BULLETPROOF: All timers cleaned up for game:', gameId);

    console.log('✅ BULLETPROOF: Rapid fire game ended successfully with Elo ratings');

  } catch (error) {
    console.error('❌ BULLETPROOF: Error ending rapid fire game:', error);
  }
};

// ---------------------------------------------------------------------------
// Joins for the SAME game are processed one after another. Two players connecting at the same moment used to
// both see "waiting + 2 players" and both start the game (double start, two clocks), or one of them missed
// the start event completely and stayed on the waiting screen.
// ---------------------------------------------------------------------------
const gameLocks = new Map();
const withGameLock = (gameId, task) => {
  const previous = gameLocks.get(gameId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  gameLocks.set(gameId, next);
  next.finally(() => { if (gameLocks.get(gameId) === next) gameLocks.delete(gameId); });
  return next;
};

// Starts (or restarts after a server restart) the end-of-game timer and the 1 s / 2 s sync loops.
// The remaining time is always calculated from the real start time, so it never resets.
const startGameTimers = (io, gameId, startTime, questions) => {
  const previous = activeRapidFireGames.get(gameId);
  if (previous) {
    clearTimeout(previous.timer);
    clearInterval(previous.updateTimer);
    clearInterval(previous.timerSyncInterval);
  }

  const remainingMs = Math.max(0, GAME_DURATION * 1000 - (Date.now() - startTime.getTime()));
  const timer = setTimeout(async () => {
    console.log('⏰ 120-second timer expired, ending game');
    await endRapidFireGame(gameId, io);
  }, remainingMs);

  const state = { timer, startTime, questions, duration: GAME_DURATION, totalQuestions: TOTAL_QUESTIONS };
  activeRapidFireGames.set(gameId, state);

  // timer sync (every second)
  state.timerSyncInterval = setInterval(async () => {
    const gameState = activeRapidFireGames.get(gameId);
    if (!gameState) { clearInterval(state.timerSyncInterval); return; }
    const elapsed = Math.floor((Date.now() - gameState.startTime.getTime()) / 1000);
    const remaining = Math.max(0, GAME_DURATION - elapsed);
    if (remaining > 0) {
      io.to(roomName(gameId)).emit('rapidfire-timer-sync', { gameId, timeRemaining: remaining, serverTime: Date.now() });
    } else {
      clearInterval(gameState.timerSyncInterval);
      clearInterval(gameState.updateTimer);
      clearTimeout(gameState.timer);
      await endRapidFireGame(gameId, io);
    }
  }, 1000);

  // live player stats (every 2 seconds)
  state.updateTimer = setInterval(async () => {
    const gameState = activeRapidFireGames.get(gameId);
    if (!gameState) { clearInterval(state.updateTimer); return; }
    const elapsed = Math.floor((Date.now() - gameState.startTime.getTime()) / 1000);
    const remaining = Math.max(0, GAME_DURATION - elapsed);
    if (remaining > 0) {
      try {
        const freshGame = await RapidFireGame.findById(gameId).populate('players.user', 'username profile.avatar ratings.rapidFireRating');
        if (freshGame) {
          io.to(roomName(gameId)).emit('rapidfire-live-update', {
            gameId,
            timeRemaining: remaining,
            players: freshGame.players.map(p => ({
              userId: p.user._id.toString(),
              username: p.user.username,
              score: p.score || 0,
              correctAnswers: p.correctAnswers || 0,
              wrongAnswers: p.wrongAnswers || 0,
              questionsAnswered: p.questionsAnswered || 0
            }))
          });
        }
      } catch (dbError) {
        console.error('❌ Error fetching fresh game data:', dbError.message);
      }
    } else {
      clearInterval(gameState.updateTimer);
      clearInterval(gameState.timerSyncInterval);
      clearTimeout(gameState.timer);
      await endRapidFireGame(gameId, io);
    }
  }, 2000);
};

// A waiting game whose creator closed the tab must disappear, otherwise Find Match / the room code
// would later put another player into a game with nobody in it.
const WAITING_ROOM_GRACE_MS = Number(process.env.RAPIDFIRE_WAITING_GRACE_MS) || 10000;
const scheduleEmptyWaitingRoomCleanup = (io, gameId) => {
  setTimeout(async () => {
    try {
      const sockets = await io.in(roomName(gameId)).fetchSockets();
      if (sockets.length > 0) return; // someone is still there
      const result = await RapidFireGame.deleteOne({ _id: gameId, status: 'waiting' });
      if (result.deletedCount) {
        activeRapidFireGames.delete(String(gameId));
        console.log('🧹 Removed empty waiting rapid fire game:', String(gameId));
      }
    } catch (error) {
      console.error('❌ Waiting room cleanup failed (ignored):', error.message);
    }
  }, WAITING_ROOM_GRACE_MS);
};

const setupRapidFireSocket = (io) => {
  console.log('🔥 BULLETPROOF: Setting up rapid fire socket handlers...');
  
  // CRITICAL FIX: Add authentication middleware for RapidFire sockets
  const authenticateSocket = (socket, next) => {
    try {
      const { token, userId } = socket.handshake.auth;
      console.log("🔐 RapidFire Socket auth attempt:", { userId, hasToken: !!token });

      if (!token || !userId) {
        console.log("❌ Missing auth credentials for RapidFire socket");
        return next(new Error("Authentication required"));
      }

      // ✅ CRITICAL FIX: Verify the JWT token and get user data
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log("✅ RapidFire JWT verified for user:", decoded.userId);
        
        // Validate that the userId matches the token
        if (decoded.userId !== userId) {
          console.error("❌ RapidFire User ID mismatch in token");
          return next(new Error("Invalid authentication"));
        }

        // Store user info in socket for easy access
        socket.userId = userId;
        socket.userInfo = decoded;

      } catch (jwtError) {
        console.error("❌ RapidFire JWT verification failed:", jwtError);
        return next(new Error("Invalid token"));
      }
      
      console.log("✅ RapidFire Socket authenticated for user:", userId, "Socket ID:", socket.id);
      next();
    } catch (error) {
      console.error("❌ RapidFire Socket auth error:", error);
      next(new Error("Authentication failed"));
    }
  };

  // Apply authentication middleware
  io.use(authenticateSocket);
  
  io.on('connection', (socket) => {
    console.log("🔌 User connected to RapidFire socket:", socket.id, "User:", socket.userId);

    // Join the game room. Starts the game when the second player is in; tells late joiners (page refresh,
    // slow connection, opponent connected first) that the game is already running and how much time is left.
    socket.on('join-rapidfire-game', (rawGameId) => {
      const gameId = String(rawGameId);
      withGameLock(gameId, async () => {
        try {
          const room = roomName(gameId);
          const gameData = await RapidFireGame.findById(gameId)
            .populate('players.user', 'username profile.avatar ratings.rapidFireRating')
            .lean();

          if (!gameData) {
            socket.emit('error', { message: 'Rapid fire game not found' });
            return;
          }

          // only the two players may enter the room (it carries the questions and live scores)
          const me = gameData.players.find(p => String(p.user?._id ?? p.user) === String(socket.userId));
          if (!me) {
            socket.emit('error', { message: 'You are not a player in this game' });
            return;
          }

          const questions = await fetchQuestionsForGame(gameData.questionSet);
          if (questions.length === 0) {
            console.error('❌ No valid questions found for game:', gameId);
            socket.emit('error', { message: 'No questions available for this game' });
            return;
          }

          const alreadyInRoom = socket.rooms.has(room);
          socket.join(room);
          socket.rapidFireGameId = gameId;

          // keep the running game's timers/start time; only (re)load the questions the server grades with
          const existing = activeRapidFireGames.get(gameId);
          if (existing) {
            existing.questions = questions;
          } else {
            activeRapidFireGames.set(gameId, {
              questions,
              startTime: gameData.startTime ? new Date(gameData.startTime) : null,
              timer: null
            });
          }

          // browsers never receive the correct answers (they get the result after answering)
          const clientQuestions = sanitizeQuestions(questions);

          socket.emit('rapidfire-game-state', { ...gameData, questionSet: clientQuestions });

          if (!alreadyInRoom) {
            socket.to(room).emit('rapidfire-player-joined', {
              game: { ...gameData, questionSet: clientQuestions },
              newPlayer: { user: { _id: socket.userId, username: me.user?.username || me.usernameSnapshot || 'Player' } }
            });
          }

          if (gameData.status === 'waiting' && gameData.players.length === 2) {
            // claim the start atomically: only one caller can flip waiting -> ongoing
            const startedGame = await RapidFireGame.findOneAndUpdate(
              { _id: gameId, status: 'waiting' },
              { status: 'ongoing', startTime: new Date() },
              { new: true }
            );

            if (startedGame) {
              const startTime = new Date(startedGame.startTime);
              console.log('🚀 Starting rapid fire game with 2 players:', gameId);
              startGameTimers(io, gameId, startTime, questions);

              io.to(room).emit('rapidfire-game-started', {
                ...gameData,
                questionSet: clientQuestions,
                status: 'ongoing',
                startTime,
                duration: GAME_DURATION,
                totalQuestions: TOTAL_QUESTIONS,
                timeRemaining: GAME_DURATION,
                currentQuestionIndex: 0
              });
            }
          } else if (gameData.status === 'ongoing' && !alreadyInRoom) {
            // Late joiner / refresh / reconnect. Make sure the timers exist (they are gone after a server restart)...
            const startTime = new Date(gameData.startTime || Date.now());
            const state = activeRapidFireGames.get(gameId);
            if (!state || !state.timer) {
              if (Date.now() - startTime.getTime() >= GAME_DURATION * 1000) {
                await endRapidFireGame(gameId, io);
                return;
              }
              startGameTimers(io, gameId, startTime, questions);
            }

            // ...then tell THIS player the game is running, with the real remaining time and their own progress
            const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
            socket.emit('rapidfire-game-started', {
              ...gameData,
              questionSet: clientQuestions,
              status: 'ongoing',
              startTime,
              duration: GAME_DURATION,
              totalQuestions: TOTAL_QUESTIONS,
              timeRemaining: Math.max(0, GAME_DURATION - elapsed),
              currentQuestionIndex: Math.min(me.answers?.length ?? me.questionsAnswered ?? 0, TOTAL_QUESTIONS - 1)
            });
          }
        } catch (error) {
          console.error('❌ Error in join-rapidfire-game:', error);
          socket.emit('error', { message: 'Failed to join rapid fire game' });
        }
      });
    });

    // Player leaves the screen: drop an empty waiting room right away (after the short grace period)
    socket.on('leave-rapidfire-game', (rawGameId) => {
      const gameId = String(rawGameId);
      socket.leave(roomName(gameId));
      scheduleEmptyWaitingRoomCleanup(io, gameId);
    });

    // BULLETPROOF: Submit answer - Independent user states
    socket.on('submit-rapidfire-answer', async (data) => {
      try {
        const { gameId, questionIndex, selectedOption } = data;
        console.log('📝 BULLETPROOF: Answer submitted:', { gameId, questionIndex, selectedOption, userId: socket.userId });

        const game = await RapidFireGame.findById(gameId);
        if (!game || game.status !== 'ongoing') {
          socket.emit('error', { message: 'Game not found or not ongoing' });
          return;
        }

        // Check if game timer has expired
        const gameState = activeRapidFireGames.get(gameId);
        if (!gameState) {
          socket.emit('error', { message: 'Game session not active' });
          return;
        }

        const elapsed = Math.floor((Date.now() - gameState.startTime.getTime()) / 1000);
        if (elapsed >= GAME_DURATION) {
          socket.emit('error', { message: 'Game time has expired' });
          return;
        }

        // Find player
        const playerIndex = game.players.findIndex(p => p.user.toString() === socket.userId);
        if (playerIndex === -1) {
          socket.emit('error', { message: 'Player not found in game' });
          return;
        }

        // Check if player has already answered this question
        const player = game.players[playerIndex];
        const alreadyAnswered = player.answers.some(answer => answer.questionIndex === questionIndex);
        
        if (alreadyAnswered) {
          console.log('⚠️ BULLETPROOF: Player already answered this question');
          socket.emit('error', { message: 'Already answered this question' });
          return;
        }

        // Get questions from memory
        let questions = gameState.questions;
        if (!questions || !questions[questionIndex]) {
          socket.emit('error', { message: 'Question not found' });
          return;
        }

        const question = questions[questionIndex];
        const isCorrect = question.options[selectedOption]?.isCorrect || false;

        // Update player score with proper negative marking
        if (isCorrect) {
          player.score += 1;
          player.correctAnswers = (player.correctAnswers || 0) + 1;
        } else {
          player.score -= 0.25; // NEGATIVE MARKING (-0.25 for wrong answer)
          player.wrongAnswers = (player.wrongAnswers || 0) + 1;
        }
        
        player.questionsAnswered = (player.questionsAnswered || 0) + 1;
        
        // Store answer with question index for independent tracking
        player.answers.push({
          questionId: question._id,
          questionIndex: questionIndex,
          selectedOption,
          isCorrect,
          answeredAt: new Date()
        });

        console.log('🔍 BULLETPROOF: Updated player stats:', {
          playerId: socket.userId,
          score: player.score,
          correctAnswers: player.correctAnswers,
          wrongAnswers: player.wrongAnswers,
          questionsAnswered: player.questionsAnswered
        });

        await game.save();

        // Emit live game state update to ALL players
        const gameStateUpdate = {
          gameId: gameId,
          players: game.players.map(p => ({
            userId: p.user.toString(),
            score: p.score,
            correctAnswers: p.correctAnswers || 0,
            wrongAnswers: p.wrongAnswers || 0,
            questionsAnswered: p.questionsAnswered || 0
          })),
          currentQuestion: questionIndex,
          timeRemaining: Math.max(0, GAME_DURATION - elapsed)
        };

        // Send to ALL players in the game room
        io.to(`rapidfire-${gameId}`).emit('rapidfire-live-update', gameStateUpdate);

        // Send answer result to the specific player
        socket.emit('answer-result', {
          questionIndex,
          isCorrect,
          correctAnswer: question.options.findIndex(opt => opt.isCorrect),
          explanation: question.explanation,
          newScore: player.score
        });

        // Auto-advance to next question after a short delay (2.5 seconds)
        // But only if the player hasn't reached the total questions limit
        if (player.questionsAnswered < TOTAL_QUESTIONS) {
          setTimeout(() => {
            const nextQuestionIndex = questionIndex + 1;
            if (nextQuestionIndex < TOTAL_QUESTIONS && gameState && gameState.questions[nextQuestionIndex]) {
              // Emit next question to the specific player who answered
              socket.emit('rapidfire-next-question', {
                questionIndex: nextQuestionIndex,
                question: stripAnswers(gameState.questions[nextQuestionIndex]),
                timeRemaining: Math.max(0, GAME_DURATION - Math.floor((Date.now() - gameState.startTime.getTime()) / 1000))
              });
              console.log(`🚀 BULLETPROOF: Sending next question ${nextQuestionIndex} to player ${socket.userId}`);
            }
          }, 2500); // 2.5 second delay to show result
        }

        // Check if this player has completed all questions
        if (player.questionsAnswered >= TOTAL_QUESTIONS) {
          console.log(`🏁 BULLETPROOF: Player ${socket.userId} completed all questions`);
          
          // Notify the player they've finished
          socket.emit('rapidfire-player-completed', {
            message: 'You have completed all questions! Waiting for opponent...',
            questionsAnswered: player.questionsAnswered,
            finalScore: player.score
          });
          
          // Check if opponent is still playing
          const opponent = game.players.find(p => p.user.toString() !== socket.userId);
          if (opponent && opponent.questionsAnswered < TOTAL_QUESTIONS) {
            // Notify opponent that this player finished
            io.to(`rapidfire-${gameId}`).emit('rapidfire-opponent-status', {
              message: `${game.players.find(p => p.user.toString() === socket.userId)?.user?.username || 'Opponent'} has completed all questions!`,
              completedPlayer: {
                username: game.players.find(p => p.user.toString() === socket.userId)?.user?.username,
                score: player.score,
                questionsAnswered: player.questionsAnswered
              }
            });
          }
        }

        // Check if both players have completed all questions
        const allPlayersFinished = game.players.every(p => p.questionsAnswered >= TOTAL_QUESTIONS);
        
        if (allPlayersFinished) {
          console.log('🏁 BULLETPROOF: All players finished, ending game immediately');
          // Clear timer
          if (gameState.timer) {
            clearTimeout(gameState.timer);
          }
          if (gameState.updateTimer) {
            clearInterval(gameState.updateTimer);
          }
          await endRapidFireGame(gameId, io);
        }

      } catch (error) {
        console.error('❌ BULLETPROOF: Error in submit-rapidfire-answer:', error);
        socket.emit('error', { message: 'Failed to submit answer' });
      }
    });

    // BULLETPROOF: Skip question handler
    socket.on('skip-rapidfire-question', async (data) => {
      try {
        const { gameId, questionIndex } = data;
        console.log('⏭️ BULLETPROOF: Question skipped:', { gameId, questionIndex, userId: socket.userId });

        const game = await RapidFireGame.findById(gameId);
        if (!game || game.status !== 'ongoing') {
          socket.emit('error', { message: 'Game not found or not ongoing' });
          return;
        }

        // Check if game timer has expired
        const gameState = activeRapidFireGames.get(gameId);
        if (!gameState) {
          socket.emit('error', { message: 'Game session not active' });
          return;
        }

        const elapsed = Math.floor((Date.now() - gameState.startTime.getTime()) / 1000);
        if (elapsed >= GAME_DURATION) {
          socket.emit('error', { message: 'Game time has expired' });
          return;
        }

        // Find player
        const playerIndex = game.players.findIndex(p => p.user.toString() === socket.userId);
        if (playerIndex === -1) {
          socket.emit('error', { message: 'Player not found in game' });
          return;
        }

        const player = game.players[playerIndex];
        
        // Check if player has already answered/skipped this question
        const alreadyProcessed = player.answers.some(answer => answer.questionIndex === questionIndex);
        
        if (alreadyProcessed) {
          console.log('⚠️ BULLETPROOF: Player already processed this question');
          socket.emit('error', { message: 'Question already answered or skipped' });
          return;
        }

        // Record the skip (no score change, but question counts as processed)
        player.answers.push({
          questionId: gameState.questions[questionIndex]._id,
          questionIndex: questionIndex,
          selectedOption: -1, // Special value for skip
          isCorrect: false,
          isSkipped: true,
          answeredAt: new Date()
        });

        // Increment questions answered count but no score change
        player.questionsAnswered = (player.questionsAnswered || 0) + 1;

        console.log('⏭️ BULLETPROOF: Question skipped, no score change:', {
          playerId: socket.userId,
          questionIndex,
          questionsAnswered: player.questionsAnswered
        });

        await game.save();

        // Emit live game state update to ALL players
        const gameStateUpdate = {
          gameId: gameId,
          players: game.players.map(p => ({
            userId: p.user.toString(),
            score: p.score,
            correctAnswers: p.correctAnswers || 0,
            wrongAnswers: p.wrongAnswers || 0,
            questionsAnswered: p.questionsAnswered || 0
          })),
          currentQuestion: questionIndex,
          timeRemaining: Math.max(0, GAME_DURATION - elapsed)
        };

        // Send to ALL players in the game room
        io.to(`rapidfire-${gameId}`).emit('rapidfire-live-update', gameStateUpdate);

        // Send skip confirmation to the specific player
        socket.emit('question-skipped', {
          questionIndex,
          newScore: player.score
        });

        // Auto-advance to next question after a short delay (1.5 seconds)
        // But only if the player hasn't reached the total questions limit
        if (player.questionsAnswered < TOTAL_QUESTIONS) {
          setTimeout(() => {
            const nextQuestionIndex = questionIndex + 1;
            if (nextQuestionIndex < TOTAL_QUESTIONS && gameState && gameState.questions[nextQuestionIndex]) {
              // Emit next question to the specific player who skipped
              socket.emit('rapidfire-next-question', {
                questionIndex: nextQuestionIndex,
                question: stripAnswers(gameState.questions[nextQuestionIndex]),
                timeRemaining: Math.max(0, GAME_DURATION - Math.floor((Date.now() - gameState.startTime.getTime()) / 1000))
              });
              console.log(`🚀 BULLETPROOF: Sending next question ${nextQuestionIndex} to player ${socket.userId} after skip`);
            }
          }, 1500); // 1.5 second delay for skip
        }

        // Check if this player has completed all questions after skip
        if (player.questionsAnswered >= TOTAL_QUESTIONS) {
          console.log(`🏁 BULLETPROOF: Player ${socket.userId} completed all questions via skip`);
          
          // Notify the player they've finished
          socket.emit('rapidfire-player-completed', {
            message: 'You have completed all questions! Waiting for opponent...',
            questionsAnswered: player.questionsAnswered,
            finalScore: player.score
          });
          
          // Check if opponent is still playing
          const opponent = game.players.find(p => p.user.toString() !== socket.userId);
          if (opponent && opponent.questionsAnswered < TOTAL_QUESTIONS) {
            // Notify opponent that this player finished
            io.to(`rapidfire-${gameId}`).emit('rapidfire-opponent-status', {
              message: `${game.players.find(p => p.user.toString() === socket.userId)?.user?.username || 'Opponent'} has completed all questions!`,
              completedPlayer: {
                username: game.players.find(p => p.user.toString() === socket.userId)?.user?.username,
                score: player.score,
                questionsAnswered: player.questionsAnswered
              }
            });
          }
        }

        // Check if both players have completed all questions
        const allPlayersFinished = game.players.every(p => p.questionsAnswered >= TOTAL_QUESTIONS);
        
        if (allPlayersFinished) {
          console.log('🏁 BULLETPROOF: All players finished, ending game immediately');
          // Clear timer
          if (gameState.timer) {
            clearTimeout(gameState.timer);
          }
          if (gameState.updateTimer) {
            clearInterval(gameState.updateTimer);
          }
          await endRapidFireGame(gameId, io);
        }

      } catch (error) {
        console.error('❌ BULLETPROOF: Error in skip-rapidfire-question:', error);
        socket.emit('error', { message: 'Failed to skip question' });
      }
    });

    // CRITICAL FIX: Handle frontend timeout event
    // A player's browser reports that the 120 s clock reached zero. The server only believes it when the
    // sender is a player of THIS game and the game really has run (almost) 120 s. Before, anyone could end
    // any game at any moment by sending this event.
    socket.on('rapidfire-game-timeout', async (rawGameId) => {
      try {
        const gameId = String(rawGameId || '');
        if (!gameId) return;

        const game = await RapidFireGame.findById(gameId).select('status startTime players.user').lean();
        if (!game || game.status !== 'ongoing') return;
        if (!game.players.some(p => String(p.user) === String(socket.userId))) return;

        const startedAt = new Date(game.startTime).getTime();
        if (!startedAt || Date.now() - startedAt < (GAME_DURATION - 3) * 1000) {
          console.log('⚠️ Ignoring early rapidfire-game-timeout for game:', gameId);
          return;
        }

        console.log('⏰ Game timeout confirmed for game:', gameId);
        const gameState = activeRapidFireGames.get(gameId);
        if (gameState) {
          if (gameState.timer) clearTimeout(gameState.timer);
          if (gameState.updateTimer) clearInterval(gameState.updateTimer);
          if (gameState.timerSyncInterval) clearInterval(gameState.timerSyncInterval);
        }
        await endRapidFireGame(gameId, io);
      } catch (error) {
        console.error('❌ BULLETPROOF: Error in rapidfire-game-timeout:', error);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log("🔌 RapidFire User disconnected:", socket.id, "Reason:", reason, "User:", socket.userId);
      if (socket.rapidFireGameId) {
        scheduleEmptyWaitingRoomCleanup(io, socket.rapidFireGameId);
      }
    });
  });
};

export { setupRapidFireSocket };
