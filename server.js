const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");
const { MongoClient } = require("mongodb");
const OpenAI = require("openai");

const app = express();
const parser = new Parser();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db("pulsedb");
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
  }
}

// ─── RSS FEEDS ────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://www.google.co.in/alerts/feeds/11442487782809509729/4031692458588060899", platform: "linkedin" },
  { url: "https://rss.app/feeds/_h1jCX09XgxA9tZHj.xml", platform: "reddit" },
  { url: "https://rss.app/feeds/_r4Zsi7FGjc0HvDKH.xml", platform: "reddit" },
  { url: "https://rss.app/feeds/_Xjl7hXya6k5mHZSr.xml", platform: "twitter" },
];

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}

async function fetchFeed({ url, platform }) {
  try {
    const feed = await parser.parseURL(url);
    return feed.items.map((item) => ({
      id:         item.guid || item.link || Math.random().toString(36).slice(2),
      postId:     item.guid || item.link,
      platform,
      authorName: item.creator || item.author || feed.title || "Unknown",
      author:     item.creator || item.author || feed.title || "Unknown",
      title:      item.title || "",
      content:    stripHtml(item.contentSnippet || item.content || item.summary || ""),
      url:        item.link || "",
      timestamp:  item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      status:     "pending",
      addedAt:    new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`Failed to fetch feed: ${url}`, err.message);
    return [];
  }
}

// ─── Platform-specific AI prompts (trimmed) ───────────────────────────────────
const platformPrompts = {
  reddit: `Senior AI/HR tech professional commenting on Reddit.
Deep respect for recruiters — never demean them, acknowledge their grind.
Tone: empathetic, witty, slightly sarcastic. Hook hard with line 1.
Speak from experience: "we've seen this", "working closely with recruiters".
Hard truths, tech angle — AI, automation, hiring trends.
2-3 sentences. No company names, no promotion, no hashtags, no emojis.`,

  linkedin: `HR tech thought leader at an AI-powered frontline recruitment company.
Solves: high-volume hiring, attrition, drop-offs, multilingual screening at scale.
Built: Voice AI agents, WhatsApp hiring flows, multilingual outreach.
Tone: professional but warm. Speak from experience, not theory.
Subtly reference "our platform" or "what we've seen work" — never name the company.
End with an insight or question. 3-4 sentences. No hashtags, no corporate fluff.`,

  twitter: `Sharp HR tech voice with strong opinions on AI and future of work.
2-3 lines MAX. Hot take or data point — never promotion.
Confident, slightly witty. No hashtags, no emojis, no fluff.`,
};

// ─── GET /posts ───────────────────────────────────────────────────────────────
app.get("/posts", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not connected" });
  try {
    const results = await Promise.all(RSS_FEEDS.map(fetchFeed));
    const rssPosts = results.flat();

    const existingPosts = await db.collection("posts").find({}).toArray();
    const existingIds = new Set(existingPosts.map(p => p.id));

    const newPosts = rssPosts.filter(p => !existingIds.has(p.id));
    if (newPosts.length > 0) {
      await db.collection("posts").insertMany(newPosts);
      console.log(`Added ${newPosts.length} new posts to DB`);
    }

    const activePosts = await db.collection("posts")
      .find({ status: { $ne: "removed" } })
      .sort({ timestamp: -1 })
      .toArray();

    res.json(activePosts);
  } catch (err) {
    console.error("Error fetching posts:", err);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// ─── POST /remove-post ────────────────────────────────────────────────────────
app.post("/remove-post", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not connected" });
  const { id } = req.body;
  try {
    await db.collection("posts").updateOne({ id }, { $set: { status: "removed" } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /generate ───────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const { platform, authorName, content } = req.body;
  if (!content) return res.status(400).json({ error: "No content provided" });

  const systemPrompt = platformPrompts[platform] || platformPrompts.linkedin;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Generate 3 distinct engaging comments for this ${platform} post by ${authorName}.

Post content: "${content}"

Return ONLY a valid JSON array of 3 strings, nothing else:
["comment1", "comment2", "comment3"]`,
        },
      ],
    });

    const txt = completion.choices[0].message.content.trim();
    const comments = JSON.parse(txt.replace(/```json|```/g, "").trim());
    res.json({ comments });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
});

// ─── POST /save-comment ───────────────────────────────────────────────────────
app.post("/save-comment", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not connected" });
  try {
    const entry = { ...req.body, savedAt: new Date().toISOString() };
    await db.collection("comments").insertOne(entry);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /history ─────────────────────────────────────────────────────────────
app.get("/history", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not connected" });
  try {
    const comments = await db.collection("comments")
      .find({})
      .sort({ savedAt: -1 })
      .limit(200)
      .toArray();
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", feeds: RSS_FEEDS.length, db: !!db });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ PULSE backend running at http://localhost:${PORT}`);
    console.log(`📡 Watching ${RSS_FEEDS.length} RSS feeds\n`);
  });
});