import test from "node:test";
import assert from "node:assert/strict";
import {
  CmccShares,
  encodeCmccShare,
  decodeCmccShare,
} from "../core/providers/cmcc-share";
import type { Account, RemoteFile, ShareInput } from "../shared/types";
import type { JsonObject } from "../core/providers/provider";

const account = {
  id: "cmcc-share-account",
  uid: "own-user",
  provider: "cmcc",
} as Account;
const source: ShareInput = {
  provider: "cmcc",
  shareKey: "original",
  url: "https://yun.139.com/shareweb/#/w/i/original",
  code: "",
};
const local: RemoteFile = {
  id: "file-a",
  name: "资源说明.txt",
  size: 12,
  isDirectory: false,
  parentId: "target",
};
function fixture() {
  const state = {
    owner: "own-user",
    status: 2,
    resultCode: 1,
    flatReceipt: false,
    writes: 0,
    broken: false,
    hasMore: false,
    files: [
      {
        coID: "file-a",
        coName: local.name,
        coSize: 12,
        path: "own-root/file-a",
      },
    ] as JsonObject[],
    history: [] as JsonObject[],
  };
  const calls: { path: string; data: JsonObject; write: boolean }[] = [];
  const share = new CmccShares(
    async () => ({ uid: account.uid!, account: "13800000000" }),
    async (_a, path, data, write = false) => {
      calls.push({ path, data, write });
      if (write) {
        state.writes++;
        if (state.broken) throw Error("connection reset");
      }
      if (path.endsWith("getOutLinkGeneral"))
        return {
          isPasswd: 0,
          getOutLinkGeneralResp: {
            outLinkGeneral: [
              {
                linkID: data.getOutLinkGeneralReq.linkID,
                ownerUserId: state.owner,
                expireTime: "",
              },
            ],
          },
        };
      if (path.endsWith("getOutLinkInfoV6"))
        return {
          nodNum: state.hasMore ? 400 : state.files.length,
          coLst: state.files,
          caLst: null,
          lkName: "归档资料",
        };
      if (path.endsWith("createOuterLinkBatchOprTask"))
        return { taskID: "remote-task" };
      if (path.endsWith("queryBatchOprTaskDetail"))
        return {
          queryBatchOprTaskDetailRes: {
            batchOprTask: {
              taskStatus: state.status,
              taskResultCode: state.resultCode,
              resultCode: 0,
            },
          },
        };
      if (path.endsWith("getOutLink"))
        return state.flatReceipt
          ? { getOutLinkResSet: [{ linkID: "own-link", passwd: "abcd" }] }
          : {
              getOutLinkRes: {
                getOutLinkResSet: [{ linkID: "own-link", passwd: "abcd" }],
              },
            };
      throw Error("unexpected endpoint");
    },
    async (_a, _path, data) => {
      assert.equal(
        data.getOutLinkLstReq.qryType,
        1,
        "only own shares, never received shares",
      );
      return {
        getOutLinkLstRes: {
          outLinks: state.history,
          count: state.history.length,
        },
      };
    },
  );
  return { share, state, calls };
}
test("CMCC share codec uses an IV-prefixed authenticated-account wire payload without mutating input", () => {
  const plain = JSON.stringify({
    getOutLinkGeneralReq: { linkID: "fixture", isPasswd: 1 },
  });
  const payload = encodeCmccShare(plain, Buffer.alloc(16, 3));
  assert.deepEqual(decodeCmccShare(payload), JSON.parse(plain));
  assert.deepEqual(
    Buffer.from(payload, "base64").subarray(0, 16),
    Buffer.alloc(16, 3),
  );
  assert.throws(() => decodeCmccShare("broken envelope"));
  assert.deepEqual(decodeCmccShare('{"resultCode":"0","data":{}}'), {
    resultCode: "0",
    data: {},
  });
});
test("CMCC share paging keeps provider paths for nested browsing and transfer", async () => {
  const f = fixture();
  f.state.hasMore = true;
  const page = await f.share.inspect(account, source, "share-root/folder", 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.files[0].id, "own-root/file-a");
  assert.equal(page.files[0].path, "own-root/file-a");
  assert.equal(page.files[0].parentId, "share-root/folder");
  assert.deepEqual(f.calls[0].data.getOutLinkInfoReq, {
    account: "13800000000",
    linkID: "original",
    passwd: "",
    caSrt: 0,
    coSrt: 0,
    srtDr: 1,
    bNum: 201,
    pCaID: "share-root/folder",
    eNum: 400,
  });
  assert.equal(f.state.writes, 0);
});
test("CMCC malformed size and duplicate share paths stop before writes", async () => {
  for (const files of [
    [{ coName: "file", coSize: null, path: "root/file" }],
    [{ coName: "file", coSize: -1, path: "root/file" }],
    [
      { coName: "file", coSize: 1, path: "root/file" },
      { coName: "file", coSize: 1, path: "root/file" },
    ],
  ]) {
    const f = fixture();
    f.state.files = files;
    await assert.rejects(f.share.inspect(account, source));
    assert.equal(f.state.writes, 0);
  }
});
test("CMCC transfer uses verified source owner and full source paths; polls never resubmit", async () => {
  const f = fixture();
  f.state.owner = "source-owner";
  assert.deepEqual(
    await f.share.transfer(
      account,
      source,
      [{ ...local, path: "source-root/file-a" }],
      "target-folder",
    ),
    { taskId: "remote-task" },
  );
  const input = f.calls.find((c) => c.write)!.data
    .createOuterLinkBatchOprTaskReq;
  assert.equal(input.ownerAccount, "source-owner");
  assert.deepEqual(input.taskInfo.contentInfoList, ["source-root/file-a"]);
  assert.equal(input.taskInfo.newCatalogID, "target-folder");
  f.state.status = 1;
  assert.equal(await f.share.poll(account, "remote-task"), false);
  f.state.status = 2;
  assert.equal(await f.share.poll(account, "remote-task"), true);
  const polled = f.calls.find((c) =>
    c.path.endsWith("queryBatchOprTaskDetail"),
  )!.data;
  assert.equal(polled.queryBatchOprTaskDetailReq.msisdn, "13800000000");
  for (const code of [0, 2, 3]) {
    f.state.resultCode = code;
    await assert.rejects(f.share.poll(account, "remote-task"), {
      code: "PARTIAL_SUCCESS",
      uncertain: true,
    });
  }
  f.state.resultCode = 1;
  f.state.status = 4;
  await assert.rejects(f.share.poll(account, "remote-task"), {
    code: "PARTIAL_SUCCESS",
    uncertain: true,
  });
  assert.equal(f.state.writes, 1);
});
test("CMCC own share validates account UID and exact files, then recovers from authenticated history", async () => {
  const f = fixture();
  f.state.flatReceipt = true;
  const own = await f.share.create(account, [local], "归档资料");
  assert.equal(own.ownerUid, account.uid);
  assert.equal(own.code, "abcd");
  assert.equal(own.url, "https://yun.139.com/shareweb/#/w/i/own-link");
  assert.equal(own.expiresAt, null);
  assert.equal(f.state.writes, 1);
  const submitted = f.calls.find((c) =>
    c.path.endsWith("/IOutLink/getOutLink"),
  )!.data;
  assert.deepEqual(submitted.getOutLinkReq.coIDLst, { item: ["file-a"] });
  assert.deepEqual(submitted.getOutLinkReq.caIDLst, { item: [] });
  assert.deepEqual(submitted.getOutLinkReq.commonAccountInfo, {
    account: "13800000000",
    accountType: 1,
  });
  assert.equal(submitted.commonAccountInfo, undefined);
  assert.equal(submitted.getOutLinkReq.userDomainId, account.uid);
  assert.equal(submitted.getOutLinkReq.linkType, 0);
  f.state.history = [
    { linkID: "own-link", passwd: "abcd", isOutLinkInvalid: 0, expireTime: "" },
  ];
  assert.equal((await f.share.find(account, [local]))?.id, "own-link");
  assert.equal(f.state.writes, 1);
  f.state.owner = "somebody-else";
  assert.equal(
    await f.share.verify(account, "own-link", [local], "abcd"),
    false,
  );
  f.state.owner = "own-user";
  assert.equal(
    await f.share.verify(
      account,
      "own-link",
      [{ ...local, id: "different-file" }],
      "abcd",
    ),
    false,
  );
});
test("CMCC lost share write result is uncertain and never automatically repeated", async () => {
  const f = fixture();
  f.state.broken = true;
  await assert.rejects(f.share.create(account, [local], "归档资料"), {
    uncertain: true,
  });
  assert.equal(f.state.writes, 1);
});
