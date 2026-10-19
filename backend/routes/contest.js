import express from "express"
import Contest from "../models/Contest.js"
import { authenticateToken, requireAdmin } from "../middleware/auth.js"
import User from "../models/User.js"
import Problem from "../models/Problem.js"
import mongoose from "mongoose"
const router = express.Router()

// Function to determine contest status based on current time
const getContestStatus = (startTime, endTime) => {
  const now = new Date()
  const start = new Date(startTime)
  const end = new Date(endTime)

  if (now < start) {
    return "upcoming"
  } else if (now >= start && now <= end) {
    return "ongoing"
  } else {
    return "ended"
  }
}

// Function to calculate dynamic score based on time
const calculateDynamicScore = (problemScore, timeSubmitted, contestStart, contestEnd) => {
  const totalTime = new Date(contestEnd).getTime() - new Date(contestStart).getTime()
  const timeElapsed = new Date(timeSubmitted).getTime() - new Date(contestStart).getTime()
  const timeLeft = totalTime - timeElapsed

  const minScore = Math.ceil(problemScore * 0.1) // 10% minimum
  const timeBasedScore = Math.ceil(problemScore * (timeLeft / totalTime))

  return Math.max(minScore, timeBasedScore)
}

// Function to update participant rankings
const updateRankings = async (contestId) => {
  try {
    const contest = await Contest.findById(contestId)
    if (!contest) return

    // Sort participants by score (descending)
    contest.participants.sort((a, b) => b.score - a.score)

    // Update ranks
    contest.participants.forEach((participant, index) => {
      participant.rank = index + 1
    })

    await contest.save()
    console.log("✅ Rankings updated for contest:", contest.name)
  } catch (error) {
    console.error("❌ Error updating rankings:", error)
  }
}

// Get all contests with updated statuses
router.get("/", async (req, res) => {
  console.log("🏆 Get contests request")

  try {
    console.log("🔍 Querying all contests...")
    const contests = await Contest.find()
      .populate("createdBy", "username")
      .populate("participants.user", "username")
      .populate("problems.problem", "title difficulty")
      .sort({ startTime: -1 })

    // Update contest statuses based on current time
    const updatedContests = contests.map((contest) => {
      const actualStatus = getContestStatus(contest.startTime, contest.endTime)

      // Update in database if status has changed
      if (contest.status !== actualStatus) {
        Contest.findByIdAndUpdate(contest._id, { status: actualStatus }).exec()
      }

      return {
        ...contest.toObject(),
        status: actualStatus,
      }
    })

    console.log("✅ Found contests:", updatedContests.length)
    res.json(updatedContests)
  } catch (error) {
    console.error("❌ Get contests error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Get contest by ID with updated status
router.get("/:id", async (req, res) => {
  console.log("🔍 Get contest by ID request:", req.params.id)

  try {
    console.log("🔍 Finding contest...")
    const contest = await Contest.findById(req.params.id)
      .populate("createdBy", "username")
      .populate("problems")
      .populate("participants.user", "username")

    if (!contest) {
      console.log("❌ Contest not found:", req.params.id)
      return res.status(404).json({ message: "Contest not found" })
    }

    // Update status based on current time
    const actualStatus = getContestStatus(contest.startTime, contest.endTime)
    let ratingsUpdated = false
    if (contest.status !== actualStatus) {
      contest.status = actualStatus
      await contest.save()
      
      // If contest just ended and ratings not finalized yet, trigger immediate finalization
      if (actualStatus === "ended" && !contest.ratingsFinalized) {
        console.log(`🔔 Contest ${contest.name} just ended! Triggering immediate ratings finalization...`)
        ratingsUpdated = true
        // Import the finalization function
        try {
          const response = await import("axios").then(axios => 
            axios.default.post(`http://localhost:3000/api/contest-status/${req.params.id}/finalize-ratings`, {})
          ).catch(err => {
            console.error("⚠️ Could not trigger immediate finalization via HTTP (running locally), will use 60s poll instead:", err.message)
            return null
          })
          if (response) {
            console.log(`✅ Ratings finalized immediately: ${response.data.updatedUsers} users updated`)
          }
        } catch (error) {
          console.error("⚠️ Error triggering immediate finalization:", error.message)
          // Ratings will be updated in the next 60s poll cycle
        }
      }
    }

    console.log("✅ Contest found:", contest.name, "Status:", actualStatus)
    res.json({ ...contest.toObject(), ratingsUpdated })
  } catch (error) {
    console.error("❌ Get contest error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Get contest problems - NEW ROUTE
router.get("/:id/problems", async (req, res) => {
  console.log("📋 Get contest problems request for contest:", req.params.id)

  try {
    console.log("🔍 Finding contest with problems...")
    const contest = await Contest.findById(req.params.id)
      .populate("createdBy", "username")
      .populate({
        path: "problems.problem",
        select: "title description difficulty constraints examples testCases codeTemplates",
      })
      .populate("participants.user", "username")

    if (!contest) {
      console.log("❌ Contest not found:", req.params.id)
      return res.status(404).json({ message: "Contest not found" })
    }

    // Update status based on current time
    const actualStatus = getContestStatus(contest.startTime, contest.endTime)
    if (contest.status !== actualStatus) {
      contest.status = actualStatus
      await contest.save()
    }

    // Transform the response to flatten the problem structure.
    // A problem (or user) that was deleted after the contest was created comes back from populate()
    // as null. Skip those entries instead of crashing the whole contest page with a 500 error.
    const missingProblems = contest.problems.filter((p) => !p.problem).length
    if (missingProblems > 0) {
      console.warn(`⚠️ Contest ${contest._id} references ${missingProblems} deleted problem(s); they are hidden`)
    }
    const transformedContest = {
      ...contest.toObject(),
      problems: contest.problems
        .filter((p) => p.problem)
        .map((p) => ({
          _id: p.problem._id,
          title: p.problem.title,
          difficulty: p.problem.difficulty,
          score: p.score,
          order: p.order,
        })),
      participants: contest.participants.filter((p) => p.user).map((p) => ({
        user: {
          _id: p.user._id,
          username: p.user.username
        },
        score: p.score,
        rank: p.rank,
        submissions: (p.submissions || []).map((sub) => ({
          problem: sub.problem,
          score: sub.score,
          timeSubmitted: sub.timeSubmitted,
          penalty: sub.penalty,
          attempts: sub.attempts
        }))
      }))
    }

    console.log(
      "✅ Contest problems found:",
      transformedContest.name,
      "Problems count:",
      transformedContest.problems.length,
    )
    res.json(transformedContest)
  } catch (error) {
    console.error("❌ Get contest problems error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Update participant score when problem is solved
router.post("/:contestId/submit/:problemId", authenticateToken, async (req, res) => {
  console.log("🎯 Contest submission request:", { 
    contestId: req.params.contestId, 
    problemId: req.params.problemId,
    userId: req.user._id,
    username: req.user.username
  })

  try {
    const { contestId, problemId } = req.params
    const { score: submissionScore, timeSubmitted, passedTests, totalTests } = req.body
    
    console.log("📊 Submission details:", { submissionScore, timeSubmitted, passedTests, totalTests })

    const contest = await Contest.findById(contestId)
    if (!contest) {
      console.log("❌ Contest not found:", contestId)
      return res.status(404).json({ message: "Contest not found" })
    }

    // Check if contest is ongoing
    const actualStatus = getContestStatus(contest.startTime, contest.endTime)
    console.log("📅 Contest status check:", { actualStatus, contestStatus: contest.status })
    if (actualStatus !== "ongoing") {
      console.log("❌ Contest not active, status:", actualStatus)
      return res.status(400).json({ message: "Contest is not active" })
    }

    // Find participant
    const participant = contest.participants.find((p) => p.user.toString() === req.user._id.toString())
    if (!participant) {
      console.log("❌ User not registered for contest:", req.user.username)
      return res.status(400).json({ message: "User not registered for this contest" })
    }
    console.log("✅ Participant found:", participant.user)

    // Find problem in contest
    const contestProblem = contest.problems.find((p) => p.problem.toString() === problemId)
    if (!contestProblem) {
      console.log("❌ Problem not found in contest:", problemId)
      return res.status(404).json({ message: "Problem not found in contest" })
    }
    console.log("✅ Contest problem found, base score:", contestProblem.score)

    // Check if problem was already solved
    const existingSubmission = participant.submissions.find((sub) => sub.problem.toString() === problemId)
    console.log("🔍 Existing submission check:", existingSubmission ? "Found" : "None")

    // SECURITY: never trust passedTests/totalTests/timeSubmitted sent by the browser.
    // Points are awarded only if the server itself recorded an ACCEPTED submission for this
    // problem by this user inside the contest window (that record is created by /problems/:id/submit
    // after the code was really executed on the server).
    const submitter = await User.findById(req.user._id).select("submissions")
    const contestStart = new Date(contest.startTime)
    const contestEnd = new Date(contest.endTime)
    const verifiedSubmission = (submitter?.submissions || [])
      .filter(
        (sub) =>
          sub.problem &&
          sub.problem.toString() === problemId &&
          sub.status === "accepted" &&
          new Date(sub.date) >= contestStart &&
          new Date(sub.date) <= contestEnd,
      )
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] // earliest accepted one inside the window
    const verified = !!verifiedSubmission
    console.log("🔒 Server-side verification of accepted submission:", verified)

    // Only award points if the server verified an accepted submission
    if (verified) {
      console.log("🎉 All test cases passed, calculating score...")
      // Only update if submission passed
      const trustedTime = verifiedSubmission.date
      const dynamicScore = calculateDynamicScore(
        contestProblem.score,
        trustedTime,
        contest.startTime,
        contest.endTime,
      )
      console.log("📈 Dynamic score calculated:", dynamicScore)

      if (existingSubmission) {
        // Update existing submission if new score is better
        if (dynamicScore > existingSubmission.score) {
          console.log("🔄 Updating existing submission with better score")
          participant.score = participant.score - existingSubmission.score + dynamicScore
          existingSubmission.score = dynamicScore
          existingSubmission.timeSubmitted = trustedTime
        } else {
          console.log("⚠️ New score not better than existing, keeping old score")
        }
        existingSubmission.attempts += 1
      } else {
        // New successful submission
        console.log("🆕 New successful submission")
        participant.score += dynamicScore
        participant.submissions.push({
          problem: problemId,
          score: dynamicScore,
          timeSubmitted: trustedTime,
          penalty: 0,
          attempts: 1,
        })
      }

      await contest.save()
      console.log("💾 Contest saved with updated scores")

      // Update rankings
      await updateRankings(contestId)
      console.log("🏆 Rankings updated")

      console.log(`✅ Score updated for user ${req.user.username}: +${dynamicScore} points`)
      res.json({
        message: "Score updated successfully",
        scoreAwarded: dynamicScore,
        totalScore: participant.score,
        problemSolved: true
      })
    } else {
      // Failed submission - just increment attempts
      console.log("❌ Submission failed, incrementing attempts only")
      if (existingSubmission) {
        existingSubmission.attempts += 1
      } else {
        participant.submissions.push({
          problem: problemId,
          score: 0,
          timeSubmitted: timeSubmitted,
          penalty: 0,
          attempts: 1,
        })
      }

      await contest.save()
      console.log("💾 Failed submission recorded")
      res.json({ 
        message: "Submission recorded", 
        scoreAwarded: 0,
        problemSolved: false
      })
    }
  } catch (error) {
    console.error("❌ Contest submission error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Register for contest
router.post("/:id/register", authenticateToken, async (req, res) => {
  console.log("📝 Contest registration request")
  console.log("📊 Contest ID:", req.params.id)
  console.log("📊 User ID:", req.user._id)

  try {
    console.log("🔍 Finding contest...")
    const contest = await Contest.findById(req.params.id)

    if (!contest) {
      console.log("❌ Contest not found:", req.params.id)
      return res.status(404).json({ message: "Contest not found" })
    }

    // Check actual contest status
    const actualStatus = getContestStatus(contest.startTime, contest.endTime)

    // Allow registration if contest is not ended
    if (actualStatus === "ended") {
      console.log("❌ Contest registration closed, status:", actualStatus)
      return res.status(400).json({ message: "Contest registration is closed" })
    }

    console.log("🔍 Checking if user already registered...")
    const isRegistered = contest.participants.some((p) => p.user.toString() === req.user._id.toString())

    if (isRegistered) {
      console.log("❌ User already registered:", req.user.username)
      return res.status(400).json({ message: "Already registered for this contest" })
    }

    console.log("✅ Registering user for contest...")
    contest.participants.push({ user: req.user._id })
    await contest.save()

    console.log("🎉 User registered successfully for contest:", contest.name)
    res.json({ message: "Successfully registered for contest" })
  } catch (error) {
    console.error("❌ Contest registration error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Admin: Create contest
// The admin form sends the contest problems as [{ problemId, score }], but the Contest model stores
// [{ problem, score, order }]. Mongoose silently drops fields it does not know ("problemId"), so every
// contest created from the admin panel ended up with scores but NO problems (empty contest page).
// This accepts both shapes and always stores the real one.
//   strict  (create): any bad/missing problem is rejected with a clear message
//   lenient (update): entries without a usable problem (e.g. from an already broken contest, or a problem
//                     that was deleted) are dropped so the admin can still save and repair the contest
async function normalizeContestProblems(input, { lenient = false } = {}) {
  if (!Array.isArray(input)) return { error: "problems must be a list" }

  const seen = new Set()
  const items = []
  for (const entry of input) {
    const raw = entry && (entry.problem?._id ?? entry.problem ?? entry.problemId)
    if (!raw) {
      if (lenient) continue
      return { error: "Every contest problem needs a problem id" }
    }
    const id = String(raw)
    if (!mongoose.isValidObjectId(id)) return { error: `Invalid problem id: ${id}` }
    if (seen.has(id)) continue
    seen.add(id)
    const score = Number(entry.score)
    items.push({
      problem: id,
      score: Number.isInteger(score) && score >= 1 && score <= 10000 ? score : 100,
      sortKey: Number.isFinite(Number(entry.order)) ? Number(entry.order) : items.length + 1,
    })
  }

  const existing = new Set(
    (await Problem.find({ _id: { $in: items.map((i) => i.problem) } }).select("_id")).map((d) => String(d._id)),
  )
  const missing = items.filter((i) => !existing.has(i.problem))
  if (missing.length > 0 && !lenient) return { error: "Some selected problems no longer exist" }

  const problems = items
    .filter((i) => existing.has(i.problem))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((i, index) => ({ problem: i.problem, score: i.score, order: index + 1 }))
  return { problems }
}

router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  console.log("📝 Create contest request")

  try {
    const body = { ...req.body }
    if (body.problems !== undefined) {
      const result = await normalizeContestProblems(body.problems)
      if (result.error) return res.status(400).json({ message: result.error })
      body.problems = result.problems
    }

    console.log("💾 Creating new contest...")
    const contest = new Contest({
      ...body,
      createdBy: req.user._id,
      status: getContestStatus(req.body.startTime, req.body.endTime),
    })

    await contest.save()
    console.log("✅ Contest created:", contest.name)

    res.status(201).json(contest)
  } catch (error) {
    console.error("❌ Create contest error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Admin: Update contest
router.put("/:id", authenticateToken, requireAdmin, async (req, res) => {
  console.log("✏️ Update contest request for ID:", req.params.id)

  try {
    console.log("🔍 Finding and updating contest...")

    // Update status based on times if provided
    const updateData = { ...req.body }
    if (updateData.problems !== undefined) {
      const result = await normalizeContestProblems(updateData.problems, { lenient: true })
      if (result.error) return res.status(400).json({ message: result.error })
      updateData.problems = result.problems
    }
    if (req.body.startTime && req.body.endTime) {
      updateData.status = getContestStatus(req.body.startTime, req.body.endTime)
    }

    const contest = await Contest.findByIdAndUpdate(req.params.id, updateData, { new: true })

    if (!contest) {
      console.log("❌ Contest not found:", req.params.id)
      return res.status(404).json({ message: "Contest not found" })
    }

    console.log("✅ Contest updated:", contest.name)
    res.json(contest)
  } catch (error) {
    console.error("❌ Update contest error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

function calculateCodeforcesElo(participants) {
  // Sort by rank (ascending)
  participants.sort((a, b) => a.rank - b.rank);

  // Get ratings before contest
  const ratingsBefore = participants.map(p => p.user.ratings.contestRating || 1200);

  // K-factor (Codeforces uses 60 for new, 30 for experienced)
  const K = 40;

  // Calculate expected place for each participant
  const expectedRanks = ratingsBefore.map((rating, i) => {
    let exp = 1;
    for (let j = 0; j < ratingsBefore.length; j++) {
      if (i === j) continue;
      exp += 1 / (1 + Math.pow(10, (ratingsBefore[j] - rating) / 400));
    }
    return exp;
  });

  // Actual ranks are their position (1-based)
  const actualRanks = participants.map(p => p.rank);

  // Calculate rating change for each participant
  const ratingChanges = ratingsBefore.map((rating, i) => {
    // The lower your actual rank compared to expected, the more you gain
    const delta = K * (expectedRanks[i] - actualRanks[i]);
    return Math.round(delta);
  });

  return ratingChanges;
}

// Admin: Backfill ratings/history for all ended contests
router.post("/admin/backfill-ended-contests", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const contests = await Contest.find({ status: "ended" }).populate("participants.user").populate("problems")
    let updatedUsers = 0
    for (const contest of contests) {
      const validParticipants = contest.participants.filter(p => p.rank > 0 && p.user)
      const ratingChanges = calculateCodeforcesElo(validParticipants)

      for (let i = 0; i < validParticipants.length; i++) {
        const participant = validParticipants[i]
        const user = await User.findById(participant.user._id)
        if (user) {
          user.ratings.contestRating = (user.ratings.contestRating || 1200) + ratingChanges[i];
          
          // Improved duplicate check - ensure no duplicate contest history entries
          const existingEntry = user.contestHistory.find(h => 
            h.contest && h.contest.toString() === contest._id.toString()
          );
          
          if (!existingEntry) {
            user.contestHistory.push({
              contest: contest._id,
              rank: participant.rank,
              score: participant.score,
              ratingChange: ratingChanges[i],
              problemsSolved: participant.submissions.filter(s => s.score > 0).length,
              totalProblems: contest.problems.length,
              date: contest.endTime,
            })
            console.log(`✅ Backfilled contest history for user ${user.username}`)
          } else {
            console.log(`⚠️ Contest history already exists for user ${user.username}, skipping duplicate`)
          }
          await user.save()
          updatedUsers++
        }
      }
    }
    res.json({ message: `Backfill complete. Updated ${updatedUsers} users.` })
  } catch (error) {
    console.error("❌ Backfill error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

router.delete("/:id", authenticateToken, requireAdmin, async (req, res) => {
  console.log("🗑️ Delete contest request for ID:", req.params.id)

  try {
    console.log("🔍 Finding and deleting contest...")
    const contest = await Contest.findByIdAndDelete(req.params.id)

    if (!contest) {
      console.log("❌ Contest not found:", req.params.id)
      return res.status(404).json({ message: "Contest not found" })
    }

    console.log("✅ Contest deleted:", contest.name)
    res.json({ message: "Contest deleted successfully" })
  } catch (error) {
    console.error("❌ Delete contest error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

router.get("/:contestId/problem/:problemId", async (req, res) => {
  try {
    const { contestId, problemId } = req.params
    console.log("🎯 Get contest problem request:", { contestId, problemId })

    // Load contest and populate the referenced problem
    const contest = await Contest.findById(contestId)
      .populate("createdBy", "username")
      .populate("participants.user", "username")
      .populate({
        path: "problems.problem",
        select: "title description difficulty constraints examples testCases codeTemplates",
      })

    if (!contest) {
      console.log("❌ Contest not found:", contestId)
      return res.status(404).json({ message: "Contest not found" })
    }

    // Find the right problem in the contest
    const contestProblemEntry = contest.problems.find((p) => {
      if (!p.problem) return false // problem was deleted after the contest was created
      const problemIdStr = p.problem._id.toString()
      return problemIdStr === problemId
    })

    if (!contestProblemEntry) {
      console.log("❌ Problem not found in contest:", problemId)
      return res.status(404).json({ message: "Problem not found in this contest" })
    }

    const problem = contestProblemEntry.problem
    console.log("✅ Contest problem found:", problem.title)

    // Update contest status
    const actualStatus = getContestStatus(contest.startTime, contest.endTime)
    if (contest.status !== actualStatus) {
      contest.status = actualStatus
      await contest.save()
    }

    res.json({
      contest: {
        _id: contest._id,
        name: contest.name,
        endTime: contest.endTime,
        startTime: contest.startTime,
        status: actualStatus,
      },
      problem: problem,
    })
  } catch (error) {
    console.error("❌ Get contest problem error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
})

// Admin: Clean up duplicate contest history entries
router.post("/admin/cleanup-duplicate-history", authenticateToken, requireAdmin, async (req, res) => {
  try {
    let cleanedUsers = 0;
    let duplicatesRemoved = 0;
    
    // Get all users with contest history
    const users = await User.find({ 
      contestHistory: { $exists: true, $not: { $size: 0 } } 
    });
    
    for (const user of users) {
      const originalLength = user.contestHistory.length;
      
      // Remove duplicates by contest ID, keeping the first occurrence
      const uniqueContestHistory = [];
      const seenContests = new Set();
      
      for (const historyEntry of user.contestHistory) {
        const contestId = historyEntry.contest.toString();
        
        if (!seenContests.has(contestId)) {
          seenContests.add(contestId);
          uniqueContestHistory.push(historyEntry);
        }
      }
      
      if (uniqueContestHistory.length !== originalLength) {
        user.contestHistory = uniqueContestHistory;
        await user.save();
        cleanedUsers++;
        duplicatesRemoved += (originalLength - uniqueContestHistory.length);
        console.log(`✅ Cleaned ${originalLength - uniqueContestHistory.length} duplicates for user ${user.username}`);
      }
    }
    
    res.json({ 
      message: `Cleanup completed. ${duplicatesRemoved} duplicate entries removed from ${cleanedUsers} users.`,
      cleanedUsers,
      duplicatesRemoved
    });
    
  } catch (error) {
    console.error("❌ Error cleaning up duplicate contest history:", error);
    res.status(500).json({ message: "Error cleaning up duplicates", error: error.message });
  }
});

// Scheduled job: Update all users' contest history for ended contests (call every 10 minutes)
router.post("/admin/sync-contest-history", async (req, res) => {
  try {
    const contests = await Contest.find({ status: "ended" }).populate("participants.user").populate("problems");
    let updatedUsers = 0;
    for (const contest of contests) {
      const validParticipants = contest.participants.filter(p => p.rank > 0 && p.user);
      const ratingChanges = calculateCodeforcesElo(validParticipants);
      for (let i = 0; i < validParticipants.length; i++) {
        const participant = validParticipants[i];
        const user = await User.findById(participant.user._id);
        if (user) {
          // Ensure contestHistory array exists
          if (!Array.isArray(user.contestHistory)) {
            user.contestHistory = [];
          }
          // Always update contest rating
          user.ratings.contestRating = (user.ratings.contestRating || 1200) + ratingChanges[i];
          // Check for duplicate contest history entry
          const alreadyExists = user.contestHistory.some(h =>
            h.contest && h.contest.toString() === contest._id.toString()
          );
          if (!alreadyExists) {
            user.contestHistory.push({
              contest: contest._id,
              rank: participant.rank,
              score: participant.score,
              ratingChange: ratingChanges[i],
              problemsSolved: participant.submissions.filter(s => s.score > 0).length,
              totalProblems: contest.problems.length,
              date: contest.endTime,
            });
          }
          await user.save();
          updatedUsers++;
        }
      }
    }
    res.json({ message: `Contest history sync complete. Updated ${updatedUsers} users.` });
  } catch (error) {
    console.error("❌ Contest history sync error:", error)
    res.status(500).json({ message: "Server error", error: error.message })
  }
});

export default router; 

//last night changes here
