const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");
const { MongoClient, ObjectId } = require("mongodb");
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

// GET /posts — fetch from RSS, store new ones in MongoDB, return all active posts
app.get("/posts", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database not connected" });

  try {
    // 1. Fetch fresh RSS posts
    const results = await Promise.all(RSS_FEEDS.map(fetchFeed));
    const rssPosts = results.flat();

    // 2. Get all existing post IDs from DB
    const existingPosts = await db.collection("posts").find({}).toArray();
    const existingIds = new Set(existingPosts.map(p => p.id));

    // 3. Insert only NEW posts that aren't in DB yet
    const newPosts = rssPosts.filter(p => !existingIds.has(p.id));
    if (newPosts.length > 0) {
      await db.collection("posts").insertMany(newPosts);
      console.log(`Added ${newPosts.length} new posts to DB`);
    }

    // 4. Return all posts that are not removed (status != "removed")
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

// POST /remove-post — remove post for everyone
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

// POST /generate — AI comment generation
app.post("/generate", async (req, res) => {
  const { platform, authorName, content } = req.body;
  if (!content) return res.status(400).json({ error: "No content provided" });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: [
        { role: "system", content: "You are a social media engagement expert. Always respond with valid JSON only — no markdown, no extra text." },
        { role: "user", content: `Generate 3 distinct engaging comments for this ${platform} post. Return ONLY a JSON array of 3 strings.\n\nPost by ${authorName}: "${content}"\n\nRules:\n- Comment 1: Insightful/analytical\n- Comment 2: Personal/relatable\n- Comment 3: Question/curious\n- 1-3 sentences each, genuine tone, no hashtags\nReturn only: ["c1","c2","c3"]` },
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

// POST /save-comment — save comment to MongoDB with commenter name
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

// GET /history — get all comments from MongoDB
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

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", feeds: RSS_FEEDS.length, db: !!db });
});

const PORT = process.env.PORT || 3001;
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ PULSE backend running at http://localhost:${PORT}`);
    console.log(`📡 Watching ${RSS_FEEDS.length} RSS feeds\n`);
  });
});
