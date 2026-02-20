const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");

const app = express();
const parser = new Parser();

app.use(cors()); // Allow PULSE frontend to call this API
app.use(express.json());

// ─── YOUR RSS FEEDS ───────────────────────────────────────────────────────────
const RSS_FEEDS = [
  {
    url: "https://www.google.co.in/alerts/feeds/11442487782809509729/4031692458588060899",
    platform: "linkedin",
  },
  {
    url: "https://rss.app/feeds/_h1jCX09XgxA9tZHj.xml",
    platform: "reddit",
  },
  {
    url: "https://rss.app/feeds/_r4Zsi7FGjc0HvDKH.xml",
    platform: "reddit",
  },
  {
    url: "https://rss.app/feeds/_Xjl7hXya6k5mHZSr.xml",
    platform: "twitter",
  },
  // Add more feeds here anytime:
  // { url: "YOUR_RSS_URL", platform: "reddit" | "twitter" | "linkedin" },
];
// ─────────────────────────────────────────────────────────────────────────────

// Fetch & normalize a single feed
async function fetchFeed({ url, platform }) {
  try {
    const feed = await parser.parseURL(url);
    return feed.items.map((item) => ({
      id:         item.guid || item.link || Math.random().toString(36).slice(2),
      postId:     item.guid || item.link,
      platform,
      authorName: item.creator || item.author || feed.title || "Unknown",
      author:     item.creator || item.author || feed.title || "Unknown",
      title:      item.title   || "",
      content:    stripHtml(item.contentSnippet || item.content || item.summary || ""),
      url:        item.link    || "",
      timestamp:  item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      likes:      0,
      reposts:    0,
      status:     "pending",
    }));
  } catch (err) {
    console.error(`Failed to fetch feed: ${url}`, err.message);
    return [];
  }
}

// Strip HTML tags from content
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}

// GET /posts — returns all posts from all RSS feeds
app.get("/posts", async (req, res) => {
  try {
    const results = await Promise.all(RSS_FEEDS.map(fetchFeed));
    const allPosts = results
      .flat()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log(`Fetched ${allPosts.length} posts from ${RSS_FEEDS.length} feeds`);
    res.json(allPosts);
  } catch (err) {
    console.error("Error fetching posts:", err);
    res.status(500).json({ error: "Failed to fetch feeds" });
  }
});

// POST /generate — AI comment generation using server-side OpenAI key
app.post("/generate", async (req, res) => {
  const { platform, authorName, content } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "OpenAI API key not configured on server" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content: "You are a social media engagement expert. Always respond with valid JSON only — no markdown, no extra text.",
          },
          {
            role: "user",
            content: `Generate 3 distinct engaging comments for this ${platform} post. Return ONLY a JSON array of 3 strings.

Post by ${authorName}: "${content}"

Rules:
- Comment 1: Insightful/analytical
- Comment 2: Personal/relatable
- Comment 3: Question/curious
- 1-3 sentences each, genuine tone, no hashtags
Return only: ["c1","c2","c3"]`,
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "OpenAI error");
    const txt = data.choices?.[0]?.message?.content || "[]";
    const comments = JSON.parse(txt.replace(/```json|```/g, "").trim());
    res.json({ comments });
  } catch (err) {
    console.error("AI generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /health — simple check
app.get("/health", (req, res) => {
  res.json({ status: "ok", feeds: RSS_FEEDS.length });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ PULSE backend running at http://localhost:${PORT}`);
  console.log(`📡 Watching ${RSS_FEEDS.length} RSS feeds`);
  console.log(`🔗 Posts API: http://localhost:${PORT}/posts\n`);
});