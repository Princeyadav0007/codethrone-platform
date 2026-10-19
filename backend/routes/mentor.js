import express from "express"
import mongoose from "mongoose"
import MentorChat from "../models/MentorChat.js"
import { authenticateToken } from "../middleware/auth.js"
import { generateReply, GeminiError, MENTOR_SYSTEM_PROMPT } from "../services/geminiService.js"

const router = express.Router()

const MAX_MESSAGE_CHARS = 4000 // chat messages
const MAX_ASK_CHARS = 20000 // stateless /ask (problem text + code)
const HISTORY_WINDOW = 20 // last N messages sent to Gemini
const MAX_MESSAGES_PER_CHAT = 300

// ---- tiny in-memory rate limiter (per user) to protect the Gemini quota ----
const hits = new Map()
const rateLimit = (limit = 15, windowMs = 60_000) => (req, res, next) => {
  const key = String(req.user._id)
  const now = Date.now()
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) {
    return res.status(429).json({ message: "You're sending messages too fast. Please wait a few seconds." })
  }
  recent.push(now)
  hits.set(key, recent)
  next()
}
setInterval(() => hits.clear(), 10 * 60_000).unref()

const sendError = (res, err) => {
  if (err instanceof GeminiError) return res.status(err.status).json({ message: err.message, code: err.code })
  console.error("❌ Mentor route error:", err.message)
  return res.status(500).json({ message: "Server error" })
}

const validId = (id) => mongoose.isValidObjectId(id)

router.use(authenticateToken)

// List my conversations (no messages, newest first)
router.get("/conversations", async (req, res) => {
  try {
    const chats = await MentorChat.find({ user: req.user._id })
      .select("title updatedAt createdAt")
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean()
    res.json(chats)
  } catch (err) {
    sendError(res, err)
  }
})

// Get one conversation with all messages (oldest -> newest)
router.get("/conversations/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid conversation id" })
    const chat = await MentorChat.findOne({ _id: req.params.id, user: req.user._id }).lean()
    if (!chat) return res.status(404).json({ message: "Conversation not found" })
    res.json(chat)
  } catch (err) {
    sendError(res, err)
  }
})

// Rename
router.patch("/conversations/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid conversation id" })
    const title = String(req.body?.title || "").trim().slice(0, 80)
    if (!title) return res.status(400).json({ message: "Title is required" })
    const chat = await MentorChat.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { title },
      { new: true },
    ).select("title updatedAt")
    if (!chat) return res.status(404).json({ message: "Conversation not found" })
    res.json(chat)
  } catch (err) {
    sendError(res, err)
  }
})

// Delete
router.delete("/conversations/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid conversation id" })
    const result = await MentorChat.deleteOne({ _id: req.params.id, user: req.user._id })
    if (!result.deletedCount) return res.status(404).json({ message: "Conversation not found" })
    res.json({ success: true })
  } catch (err) {
    sendError(res, err)
  }
})

// Send a message. Creates a conversation if conversationId is not given.
router.post("/chat", rateLimit(15), async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim()
    const { conversationId } = req.body || {}

    if (!message) return res.status(400).json({ message: "Message cannot be empty" })
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ message: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` })
    }

    let chat
    if (conversationId) {
      if (!validId(conversationId)) return res.status(400).json({ message: "Invalid conversation id" })
      chat = await MentorChat.findOne({ _id: conversationId, user: req.user._id })
      if (!chat) return res.status(404).json({ message: "Conversation not found" })
      if (chat.messages.length >= MAX_MESSAGES_PER_CHAT) {
        return res.status(400).json({ message: "This chat is full. Please start a new chat." })
      }
    } else {
      chat = new MentorChat({
        user: req.user._id,
        title: message.length > 50 ? `${message.slice(0, 50)}…` : message,
        messages: [],
      })
    }

    const history = chat.messages.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, parts: [{ text: m.content }] }))
    const contents = [...history, { role: "user", parts: [{ text: message }] }]

    const reply = await generateReply({ contents, systemInstruction: MENTOR_SYSTEM_PROMPT })

    // Save only after a successful reply, so the history never has a dangling user message.
    chat.messages.push({ role: "user", content: message }, { role: "model", content: reply })
    await chat.save()

    const saved = chat.messages.slice(-2)
    res.json({
      conversationId: chat._id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      userMessage: saved[0],
      reply: saved[1],
    })
  } catch (err) {
    sendError(res, err)
  }
})

// Stateless one-shot call (used by Problem page: "Ask AI" and "Complexity analysis").
router.post("/ask", rateLimit(20), async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim()
    if (!prompt) return res.status(400).json({ message: "Prompt cannot be empty" })
    if (prompt.length > MAX_ASK_CHARS) return res.status(400).json({ message: "Prompt is too long" })

    const reply = await generateReply({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    res.json({ reply })
  } catch (err) {
    sendError(res, err)
  }
})

export default router
