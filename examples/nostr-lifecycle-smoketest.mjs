import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function newKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return {
    sk,
    pk,
    nsec: nsecEncode(sk),
    npub: npubEncode(pk)
  };
}

const relays = process.env.NOSTR_RELAYS ?? "wss://relay.snort.social";
const openerK = process.env.OPENER_NSEC ? { nsec: process.env.OPENER_NSEC } : newKeypair();
const solverK = process.env.SOLVER_NSEC ? { nsec: process.env.SOLVER_NSEC } : newKeypair();

const opener = createTalkToMeNostrClient({ relays, nsec: openerK.nsec });
const solver = createTalkToMeNostrClient({ relays, nsec: solverK.nsec });

const roomId = `issue:offchain:lifecycle-${Date.now()}`;

console.log(
  JSON.stringify(
    {
      relays: opener.relays,
      roomId,
      opener: { pubkey: opener.pubkey, npub: opener.npub },
      solver: { pubkey: solver.pubkey, npub: solver.npub }
    },
    null,
    2
  )
);

let accepted = false;
const started = Math.floor(Date.now() / 1000) - 10;

const solverLobby = solver.watchLobby({
  sinceSeconds: started,
  onIssue: async ({ payload }) => {
    if (payload?.roomId !== roomId) return;
    console.log("[solver] saw issue_opened in lobby, claiming + submitting");
    await solver.claimIssue({ roomId, note: "I can solve this." });
    await solver.submitSolution({
      roomId,
      artifact: { kind: "text", value: "4" },
      summary: "2 + 2 = 4"
    });
    console.log("[solver] submitted");
  }
});

const openerRoom = opener.watchRoom({
  roomId,
  sinceSeconds: started,
  onMessage: async (evt) => {
    if (accepted) return;
    let payload = null;
    try {
      payload = JSON.parse(evt.content);
    } catch {
      return;
    }
    if (payload?.type !== "solution_submitted") return;
    console.log("[opener] saw submission, accepting");
    accepted = true;
    await opener.acceptSolution({
      roomId,
      solver: payload?.solver ?? `nostr:${evt.pubkey}`,
      submissionEventId: evt.id
    });
    console.log("[opener] accepted");
  }
});

// Ensure subscriptions are live.
await sleep(2000);

await opener.announceIssue({
  issueRoomId: roomId,
  title: "Lifecycle smoketest",
  description: "Compute 2+2 and submit a solution JSON event.",
  tags: ["smoke"],
  bounty: "0"
});

const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  if (accepted) break;
  await sleep(500);
}

await sleep(1000);
const state = await opener.fetchIssueState({ roomId, limit: 200 });
console.log(JSON.stringify({ ok: true, state }, null, 2));

solverLobby.close();
openerRoom.close();
solver.destroy();
opener.destroy();

if (!accepted) {
  console.error("Timed out waiting for acceptance.");
  process.exit(1);
}
