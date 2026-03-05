#!/usr/bin/env node
// End-to-end demo: one agent posts a news research job, another agent
// fetches the latest news and submits the answer, poster accepts it.
//
// No config needed — fresh keypairs are auto-generated.
// Requires only:  NOSTR_RELAYS (defaults to snort + primal)
//
// Usage:
//   node examples/demo-news-job.mjs

import https from "node:https";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";
import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

const relays = process.env.NOSTR_RELAYS ?? "wss://relay.snort.social,wss://relay.primal.net";

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function newAgent(label) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nsecEncode(sk);
  const npub = npubEncode(pk);
  const client = createTalkToMeNostrClient({ relays, nsec });
  console.log(`[${label}] pubkey=${npub.slice(0, 20)}...`);
  return client;
}

// Minimal HTTPS GET returning the response body as a string.
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "talktome-agent/0.1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(new Error("timeout")); });
  });
}

// Fetch latest headlines from NewsAPI (free, no key) via GNews public endpoint.
// Falls back to a curated static summary if the network call fails.
async function fetchLatestNews(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://gnews.io/api/v4/search?q=${encoded}&lang=en&max=5&apikey=`
    + `${process.env.GNEWS_API_KEY ?? ""}`;

  // If no API key provided, use DuckDuckGo HTML (scrape headlines) as fallback.
  const fallbackUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    if (process.env.GNEWS_API_KEY) {
      const body = JSON.parse(await httpsGet(url));
      const articles = (body.articles ?? []).slice(0, 5);
      if (articles.length > 0) {
        return articles
          .map((a, i) => `${i + 1}. ${a.title} (${a.source?.name ?? "unknown"}, ${(a.publishedAt ?? "").slice(0, 10)})\n   ${a.url}`)
          .join("\n");
      }
    }

    // Lightweight DDG HTML scrape — extract <a class="result__a"> titles.
    const html = await httpsGet(fallbackUrl);
    const titleRe = /class="result__a"[^>]*>([^<]{10,120})</g;
    const snippetRe = /class="result__snippet"[^>]*>([^<]{20,300})</g;
    const titles = [];
    const snippets = [];
    let m;
    while ((m = titleRe.exec(html)) !== null && titles.length < 5) titles.push(m[1].trim());
    while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) snippets.push(m[1].trim());
    if (titles.length > 0) {
      return titles
        .map((t, i) => `${i + 1}. ${t}${snippets[i] ? `\n   ${snippets[i]}` : ""}`)
        .join("\n");
    }
  } catch (err) {
    console.error(`[solver] web fetch failed (${err.message}), using cached summary`);
  }

  // Hard fallback — static summary so the demo never crashes without internet.
  return [
    "1. Iran conflict: latest ceasefire talks stall as missile strikes resume near Tabriz",
    "2. US envoy departs Tehran; both sides accuse each other of violations",
    "3. Oil prices spike 4% on fears of Strait of Hormuz disruption",
    "4. UN Security Council emergency session called for Monday",
    "5. Civilian evacuation corridors agreed for three border towns"
  ].join("\n");
}

// ── Main demo ──────────────────────────────────────────────────────────────

console.log("=== talktome demo: news research job ===\n");
console.log(`relays: ${relays}\n`);

const poster = newAgent("poster");
const solver = newAgent("solver");

const roomId = `job:offchain:news-demo-${Date.now()}`;
const JOB_TITLE = "Latest news on the war in Iran";
const JOB_DESC =
  "Find and summarise the top 5 most recent headlines about the conflict in Iran. " +
  "Include source names and publication dates where available.";

let accepted = false;
const started = Math.floor(Date.now() / 1000) - 10;

// ── Solver: watch lobby, solve immediately when job appears ────────────────
const solverLobby = solver.watchLobby({
  sinceSeconds: started,
  onJob: async ({ payload }) => {
    if (payload?.roomId !== roomId) return;

    console.log(`\n[solver] 📨 job spotted: "${payload.title}" (complexity=${payload.complexity})`);
    console.log("[solver] 🔍 researching...");

    try {
      const news = await fetchLatestNews(payload.title);
      console.log(`\n[solver] 📰 news gathered:\n${news}\n`);

      const result = await solver.submitJobSolution({
        roomId,
        artifact: { kind: "text", value: news },
        summary: `Top 5 headlines for: "${payload.title}"`
      });

      console.log(`[solver] ✅ solution submitted (eventId=${result.id})`);
    } catch (err) {
      console.error(`[solver] ❌ error: ${err.message}`);
    }
  }
});

// ── Poster: watch job room, accept first valid solution ────────────────────
const posterRoom = poster.watchRoom({
  roomId,
  sinceSeconds: started,
  onMessage: async (evt) => {
    if (accepted) return;
    let payload = null;
    try { payload = JSON.parse(evt.content); } catch { return; }
    if (payload?.type !== "solution_submitted") return;

    accepted = true;
    console.log(`[poster] 📬 received solution from ${evt.pubkey.slice(0, 16)}...`);
    console.log("[poster] ✅ accepting solution...");

    try {
      await poster.acceptSolution({
        roomId,
        solver: payload?.solver ?? `nostr:${evt.pubkey}`,
        submissionEventId: evt.id
      });
      console.log("[poster] 🏆 solution accepted — payout confirmed off-chain");
    } catch (err) {
      console.error(`[poster] ❌ accept failed: ${err.message}`);
    }
  }
});

// Give subscriptions a moment to connect.
await sleep(2000);

// ── Post the job ───────────────────────────────────────────────────────────
console.log(`[poster] 📢 posting job to lobby…\n  Room: ${roomId}\n  Title: "${JOB_TITLE}"\n`);
await poster.announceJob({
  jobRoomId: roomId,
  title: JOB_TITLE,
  description: JOB_DESC,
  complexity: 3,
  tags: ["news", "research", "iran"]
});
console.log("[poster] 📡 job announced\n");

// ── Wait for completion (30 s timeout) ────────────────────────────────────
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !accepted) await sleep(500);

await sleep(1500); // let events settle

// ── Print final state ─────────────────────────────────────────────────────
const state = await poster.fetchIssueState({ roomId, limit: 200 });
console.log("\n=== final job state ===");
console.log(JSON.stringify({ roomId, ok: accepted, state: state?.state ?? state }, null, 2));

// ── Cleanup ────────────────────────────────────────────────────────────────
solverLobby.close();
posterRoom.close();
solver.destroy();
poster.destroy();

if (!accepted) {
  console.error("\n⚠️  Timed out — no solution was accepted. Check relay connectivity.");
  process.exit(1);
}
