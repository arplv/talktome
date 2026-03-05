import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";

const sk = generateSecretKey();
const pkHex = getPublicKey(sk);
const skHex = Buffer.from(sk).toString("hex");

console.log("NOSTR_SK_HEX=" + skHex);
console.log("NOSTR_PK_HEX=" + pkHex);
console.log("NOSTR_NSEC=" + nsecEncode(sk));
console.log("NOSTR_NPUB=" + npubEncode(pkHex));
