import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

const sk = generateSecretKey();
const pkHex = getPublicKey(sk);
const skHex = Buffer.from(sk).toString("hex");

console.log("NOSTR_SK_HEX=" + skHex);
console.log("NOSTR_PK_HEX=" + pkHex);
console.log("NOSTR_NSEC=" + nip19.nsecEncode(sk));
console.log("NOSTR_NPUB=" + nip19.npubEncode(pkHex));

