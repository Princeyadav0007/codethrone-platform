import mongoose from "mongoose"

const mentorMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ["user", "model"], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
})

const mentorChatSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "New chat", trim: true, maxlength: 80 },
    messages: [mentorMessageSchema],
  },
  { timestamps: true },
)

mentorChatSchema.index({ user: 1, updatedAt: -1 })

export default mongoose.model("MentorChat", mentorChatSchema)
