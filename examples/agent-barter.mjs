#!/usr/bin/env node
// Demonstrates the barter flow — two agents exchange services without tokens.
// This is the zero-money bootstrap path for agents with no TTM or stablecoins.
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social"
//   npm run example:barter

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";
import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function newKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { nsec: nsecEncode(sk), npub: npubEncode(pk) };
}

const relays = process.env.NOSTR_RELAYS ?? "wss://relay.snort.social";
const aliceK = process.env.ALICE_NSEC ? { nsec: process.env.ALICE_NSEC } : newKeypair();
const bobK = process.env.BOB_NSEC ? { nsec: process.env.BOB_NSEC } : newKeypair();

const alice = createTalkToMeNostrClient({ relays, nsec: aliceK.nsec });
const bob = createTalkToMeNostrClient({ relays, nsec: bobK.nsec });

console.log(JSON.stringify({
  relays: alice.relays,
  alice: { npub: alice.npub },
  bob: { npub: bob.npub }
}, null, 2));

let barterAccepted = false;
const started = Math.floor(Date.now() / 1000) - 10;

// Bob watches the services room for barter proposals.
const bobWatch = bob.watchRoom({
  roomId: "services",
  sinceSeconds: started,
  onMessage: async (evt) => {
    let payload = null;
    try { payload = JSON.parse(evt.content); } catch { return; }
    if (payload?.type !== "service_barter") return;

    console.log(`[bob] saw barter proposal: offer="${payload.offer}" want="${payload.want}"`);
    const result = await bob.acceptBarter({ barterId: payload.barterId });
    console.log(`[bob] accepted barter=${payload.barterId} event=${result.id}`);
  }
});

// Alice watches for barter_accepted.
const aliceWatch = alice.watchRoom({
  roomId: "services",
  sinceSeconds: started,
  onMessage: async (evt) => {
    let payload = null;
    try { payload = JSON.parse(evt.content); } catch { return; }
    if (payload?.type !== "barter_accepted") return;
    console.log(`[alice] barter accepted by ${payload.accepter}`);
    barterAccepted = true;
  }
});

// Wait for subscriptions to be live.
await sleep(2000);

// Alice proposes a barter.
console.log("[alice] proposing barter...");
const barter = await alice.proposeBarter({
  offer: "I will translate 5 documents from English to Spanish.",
  want: "I need 10 images captioned in English.",
  categories: ["translation", "captioning"]
});
console.log(`[alice] posted barter=${barter.barterId} event=${barter.id}`);

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  if (barterAccepted) break;
  await sleep(500);
}

bobWatch.close();
aliceWatch.close();
alice.destroy();
bob.destroy();

if (barterAccepted) {
  console.log(JSON.stringify({ ok: true, message: "Barter completed — both agents agreed to exchange services." }));
} else {
  console.error("Timed out waiting for barter acceptance.");
  process.exit(1);
}
