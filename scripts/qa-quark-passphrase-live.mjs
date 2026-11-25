import assert from "node:assert/strict";
import { QuarkShareSigner } from "../desktop/quark-share-signer.ts";
import { createQuarkPassphrases } from "../core/providers/quark-passphrase.ts";
import { parseShare } from "../core/links.ts";

// Explicit opt-in: generates commands for an existing share; never creates a netdisk share.
const input = process.env.PANXU_QUARK_COMMAND_SHARE;
assert(input, "设置 PANXU_QUARK_COMMAND_SHARE 为已授权的现有夸克分享链接。");
const source = parseShare(input);
assert.equal(source.provider, "quark");
const native = new QuarkShareSigner(),
  signers = new Set();
const generator = createQuarkPassphrases({
  withSigner: (action) =>
    native.withSigner((sign) => {
      signers.add(sign);
      return action(sign);
    }),
  request: fetch,
});
try {
  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const start = Date.now();
    const value = await generator.create(
      {
        id: "existing-protocol-check",
        url: source.url,
        code: source.code,
        ownerUid: "not-transmitted",
      },
      "分享资源",
      process.env.PANXU_QUARK_COMMAND_PLAN || "auto3_c_code",
    );
    assert.match(value, /^[\p{Script=Han}]{4,40}$/u);
    rounds.push({
      chineseLength: value.length,
      roundTripMatched: true,
      elapsedMs: Date.now() - start,
    });
  }
  assert.equal(signers.size, 1, "同一个桌面 SDK 会话复用，避免每次重开客户端");
  console.log(
    JSON.stringify({
      rounds,
      nativeSessions: signers.size,
      netdiskSharesCreated: 0,
      androidUsed: false,
    }),
  );
} finally {
  native.close();
}
