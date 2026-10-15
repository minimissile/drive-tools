import { id, now, parseJson } from "./database";
import { AppError, safeMessage } from "./errors";
import { parseShare } from "./links";
import { Repository, type Row } from "./repository";
import { SecretStore } from "./secrets";
import { NoteExporter } from "./notes";
import {
  assertManifest,
  type DriveProvider,
  type OwnShare,
} from "./providers/provider";
import type {
  Account,
  Job,
  Provider,
  RemoteFile,
  SplitItem,
  SplitRun,
  TransferBatch,
  TransferBatchItem,
} from "../shared/types";

const active = [
  "queued",
  "preflight",
  "transferring",
  "verifying",
  "sharing",
  "archiving",
];
export class Operations {
  constructor(
    private repo: Repository,
    private providers: Record<Provider, DriveProvider>,
    private secrets: SecretStore,
    private notes: NoteExporter,
    private verifyAccount: (id: string) => Promise<Account>,
    private changed: () => void,
  ) {}
  private get db() {
    return this.repo.db;
  }
  private addJob(
    copyId: string,
    kind: Job["kind"],
    targetId: string,
    batchId: string | null,
  ) {
    const jobId = id("job");
    this.db.run(
      "INSERT INTO jobs(id,copy_id,kind,target_id,batch_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
      jobId,
      copyId,
      kind,
      targetId,
      batchId,
      now(),
      now(),
    );
    return jobId;
  }
  private step(jobId: string, stage: string, checkpoint?: string) {
    if (this.repo.getJob(jobId).stage === "cancelled")
      throw new AppError("CANCELLED", "本地等待已停止。");
    this.db.run(
      "UPDATE jobs SET stage=?,checkpoint=COALESCE(?,checkpoint),error=NULL,updated_at=? WHERE id=?",
      stage,
      checkpoint ?? null,
      now(),
      jobId,
    );
    this.changed();
  }
  private finish(jobId: string) {
    if (this.repo.getJob(jobId).stage !== "cancelled")
      this.db.run(
        "UPDATE jobs SET stage='completed',checkpoint='complete',error=NULL,updated_at=? WHERE id=?",
        now(),
        jobId,
      );
    this.changed();
  }
  async execute(jobId: string) {
    const job = this.repo.getJob(jobId);
    if (job.stage === "cancelled" || job.stage === "completed") return;
    try {
      if (job.kind === "batch_inspect") await this.inspectBatchItem(job);
      else if (job.kind === "split_preview") await this.inspectSplit(job);
      else if (job.kind === "split_share") await this.shareSplit(job);
      else throw new AppError("INVALID_OPERATION", "任务类型不正确。");
    } catch (error) {
      const current = this.repo.getJob(jobId),
        message = safeMessage(error);
      if (current.stage === "cancelled") return;
      const code = error instanceof AppError ? error.code : "OPERATION_FAILED";
      const stage =
        code === "AUTH_EXPIRED"
          ? "waiting_login"
          : current.checkpoint === "share_requested" ||
              (error instanceof AppError && error.uncertain) ||
              code === "ACCOUNT_UID_MISMATCH"
            ? "needs_review"
            : "failed";
      const rejected =
        error instanceof AppError &&
        !error.uncertain &&
        ["AUTH_EXPIRED", "USER_ACTION_REQUIRED", "QUOTA_EXCEEDED"].includes(
          code,
        );
      this.db.run(
        "UPDATE jobs SET stage=?,error=?,checkpoint=?,updated_at=? WHERE id=?",
        stage,
        message,
        rejected && job.kind === "split_share" ? "new" : current.checkpoint,
        now(),
        jobId,
      );
      if (job.kind === "batch_inspect")
        this.db.run(
          "UPDATE transfer_batch_items SET state='failed',error=? WHERE id=?",
          message,
          job.targetId!,
        );
      if (job.kind === "split_preview")
        this.db.run(
          "UPDATE split_runs SET status='failed',error=? WHERE id=?",
          message,
          job.targetId!,
        );
      if (job.kind === "split_share")
        this.db.run(
          "UPDATE split_items SET status=?,error=? WHERE id=?",
          stage,
          message,
          job.targetId!,
        );
      this.repo.log(jobId, message);
      if (
        [
          "AUTH_EXPIRED",
          "USER_ACTION_REQUIRED",
          "ACCOUNT_UID_MISMATCH",
          "QUOTA_EXCEEDED",
        ].includes(code)
      )
        this.pauseAccount(
          job.accountId,
          code === "AUTH_EXPIRED" ? "waiting_login" : "needs_review",
          message,
        );
      this.changed();
    }
  }
  pauseAccount(
    accountId: string,
    stage: "waiting_login" | "needs_review",
    message: string,
  ) {
    const pending = this.db.all<Row>(
      "SELECT j.id FROM jobs j JOIN copies c ON c.id=j.copy_id WHERE c.account_id=? AND j.stage='queued'",
      accountId,
    );
    for (const row of pending) {
      const job = this.repo.getJob(row.id),
        reason = `账号需人工处理，已暂停同账号待执行任务：${message}`;
      this.db.run(
        "UPDATE jobs SET stage=?,error=?,updated_at=? WHERE id=?",
        stage,
        reason,
        now(),
        job.id,
      );
      if (job.kind === "transfer")
        this.db.run(
          "UPDATE copies SET status=?,error=? WHERE id=?",
          stage,
          reason,
          job.copyId,
        );
      else if (job.kind === "batch_inspect")
        this.db.run(
          "UPDATE transfer_batch_items SET state='failed',error=? WHERE id=?",
          reason,
          job.targetId!,
        );
      else if (job.kind === "split_preview")
        this.db.run(
          "UPDATE split_runs SET status='failed',error=? WHERE id=?",
          reason,
          job.targetId!,
        );
      else
        this.db.run(
          "UPDATE split_items SET status=?,error=? WHERE id=?",
          stage,
          reason,
          job.targetId!,
        );
    }
  }
  candidates(query: string, accountId: string, page: number) {
    const values: (string | number)[] = [],
      where = [
        "c.status='draft'",
        "NOT EXISTS(SELECT 1 FROM jobs j WHERE j.copy_id=c.id AND j.kind='transfer')",
      ];
    if (query.trim()) {
      where.push(
        "(r.title LIKE ? ESCAPE '\\' OR r.category LIKE ? ESCAPE '\\')",
      );
      const term = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term);
    }
    if (accountId !== "all") {
      where.push("c.account_id=?");
      values.push(accountId);
    }
    const base = `FROM copies c JOIN resources r ON r.id=c.resource_id WHERE ${where.join(" AND ")}`;
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n ${base}`,
      ...values,
    )!.n;
    page = Math.min(page, Math.max(1, Math.ceil(total / 25)));
    return {
      total,
      page,
      pageSize: 25,
      items: this.db
        .all<Row>(
          `SELECT c.id,c.account_id,r.title,r.provider,r.category ${base} ORDER BY r.updated_at DESC,c.id LIMIT 25 OFFSET ?`,
          ...values,
          (page - 1) * 25,
        )
        .map((r) => ({
          copyId: r.id,
          accountId: r.account_id,
          title: r.title,
          provider: r.provider,
          category: r.category,
        })),
    };
  }
  createBatch(copyIds: string[]) {
    const ids = [...new Set(copyIds)];
    if (!ids.length || ids.length > 100)
      throw new AppError("BATCH_LIMIT", "每批请选择1至100份资料。");
    for (const copyId of ids) this.repo.getCopy(copyId);
    const batchId = id("batch");
    this.db.transaction(() => {
      this.db.run("INSERT INTO transfer_batches VALUES(?,?)", batchId, now());
      for (const copyId of ids) {
        const itemId = id("batch_item"),
          jobId = this.addJob(copyId, "batch_inspect", itemId, batchId);
        this.db.run(
          "INSERT INTO transfer_batch_items(id,batch_id,copy_id,inspect_job_id) VALUES(?,?,?,?)",
          itemId,
          batchId,
          copyId,
          jobId,
        );
      }
    });
    this.changed();
    return this.batch(batchId);
  }
  batches() {
    return this.db
      .all<Row>(
        "SELECT b.id,b.created_at,COUNT(i.id) count FROM transfer_batches b LEFT JOIN transfer_batch_items i ON i.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 30",
      )
      .map((r) => ({ id: r.id, createdAt: r.created_at, count: r.count }));
  }
  batch(batchId: string): TransferBatch {
    const batch = this.db.get<Row>(
      "SELECT * FROM transfer_batches WHERE id=?",
      batchId,
    );
    if (!batch) throw new AppError("NOT_FOUND", "批次不存在。");
    const items = this.db
      .all<Row>(
        "SELECT i.*,r.title,c.account_id,j.stage inspect_stage,t.stage transfer_stage,t.error transfer_error FROM transfer_batch_items i JOIN copies c ON c.id=i.copy_id JOIN resources r ON r.id=c.resource_id JOIN jobs j ON j.id=i.inspect_job_id LEFT JOIN jobs t ON t.id=i.transfer_job_id WHERE i.batch_id=? ORDER BY i.rowid",
        batchId,
      )
      .map(
        (r) =>
          ({
            id: r.id,
            copyId: r.copy_id,
            title: r.title,
            accountId: r.account_id,
            state: r.state,
            error: r.transfer_error ?? r.error,
            files: parseJson(r.files, []),
            selectedIds: parseJson(r.selected_ids, []),
            inspectJobId: r.inspect_job_id,
            transferJobId: r.transfer_job_id,
            stage: r.transfer_stage ?? r.inspect_stage,
          }) as TransferBatchItem,
      );
    return { id: batch.id, createdAt: batch.created_at, items };
  }
  private async inspectBatchItem(job: Job) {
    const copy = this.repo.getCopy(job.copyId),
      resource = this.repo.getResource(copy.resourceId);
    if (
      copy.status !== "draft" ||
      this.db.get(
        "SELECT id FROM jobs WHERE copy_id=? AND kind='transfer'",
        copy.id,
      )
    )
      throw new AppError(
        "COPY_HAS_JOB",
        "该副本已有转存结果或任务，请恢复原任务，避免重复转存。",
      );
    this.step(job.id, "preflight");
    this.db.run(
      "UPDATE transfer_batch_items SET state='inspecting',error=NULL WHERE id=?",
      job.targetId!,
    );
    this.changed();
    const account = await this.verifyAccount(copy.accountId),
      provider = this.providers[account.provider];
    const source = parseShare(
      resource.sourceUrl,
      (await this.secrets.get(`source:${resource.id}`)) ?? "",
    );
    if (source.provider !== account.provider)
      throw new AppError(
        "CROSS_PROVIDER_UNSUPPORTED",
        "批量转存仍须选择同网盘账号。",
      );
    const prior = this.repo.selectedFiles(copy.id),
      parents = [...new Set(prior.map((f) => f.parentId))];
    if (parents.length > 1)
      throw new AppError(
        "MIXED_SELECTION",
        "原选择跨越多个目录，请先在单份录入中核对。",
      );
    const files: RemoteFile[] = [];
    let completed = false;
    for (let page = 1; page <= 100; page++) {
      const inspected = await provider.inspect(
        account,
        source,
        parents[0] ?? "0",
        page,
      );
      files.push(...inspected.files);
      if (!prior.length && files.length > 100)
        throw new AppError(
          "BATCH_FILE_LIMIT",
          "根目录超过100项，请先在单份录入中选择文件，再批量预检。",
        );
      if (!inspected.hasMore) {
        completed = true;
        break;
      }
    }
    if (!completed)
      throw new AppError(
        "INCOMPLETE_LIST",
        "分享目录超过读取上限，未截断为成功结果。",
      );
    const selected = prior.length
      ? prior.map((p) => files.find((f) => f.id === p.id))
      : files;
    if (!selected.length || selected.some((f) => !f))
      throw new AppError(
        "SOURCE_CHANGED",
        "分享为空或原已选文件发生变化，请人工核对。",
      );
    if (new Set(files.map((f) => f.id)).size !== files.length)
      throw new AppError(
        "UNSTABLE_LIST",
        "分享分页出现重复文件，请稍后重新预检。",
      );
    const actual = selected as RemoteFile[];
    if (prior.length) assertManifest(prior, actual);
    this.step(job.id, "preflight");
    this.db.run(
      "UPDATE transfer_batch_items SET state='ready',files=?,selected_ids=?,owner_uid=?,error=NULL WHERE id=?",
      JSON.stringify(actual),
      JSON.stringify(actual.map((f) => f.id)),
      account.uid,
      job.targetId!,
    );
    this.repo.log(job.id, `已读取${actual.length}项，尚未转存，等待批次确认。`);
    this.finish(job.id);
  }
  selectBatchItem(itemId: string, ids: string[]) {
    const row = this.db.get<Row>(
      "SELECT * FROM transfer_batch_items WHERE id=?",
      itemId,
    );
    if (!row || row.state !== "ready" || row.transfer_job_id)
      throw new AppError("BATCH_LOCKED", "此项不可再修改选择。");
    const files = parseJson<RemoteFile[]>(row.files, []);
    if (ids.some((id) => !files.some((f) => f.id === id)))
      throw new AppError("INVALID_SELECTION", "文件不在本次预检清单中。");
    this.db.run(
      "UPDATE transfer_batch_items SET selected_ids=? WHERE id=?",
      JSON.stringify([...new Set(ids)]),
      itemId,
    );
    this.changed();
    return this.batch(row.batch_id);
  }
  startBatch(batchId: string, selected: string[]) {
    const batch = this.batch(batchId),
      ids = [...new Set(selected)];
    if (
      batch.items.some((i) =>
        active.includes(this.repo.getJob(i.inspectJobId).stage),
      )
    )
      throw new AppError(
        "BATCH_INSPECTING",
        "请等待本批预检结束，再选择开始转存的资料。",
      );
    if (
      !ids.length ||
      ids.some(
        (id) =>
          !batch.items.some(
            (i) =>
              i.id === id && (i.state === "ready" || i.state === "started"),
          ),
      )
    )
      throw new AppError("INVALID_SELECTION", "请选择已预检通过的资料。");
    const result = { created: 0, reused: 0, skipped: 0 };
    this.db.transaction(() => {
      for (const itemId of ids) {
        const row = this.db.get<Row>(
          "SELECT * FROM transfer_batch_items WHERE id=?",
          itemId,
        )!;
        if (row.transfer_job_id) {
          result.reused++;
          continue;
        }
        const copy = this.repo.getCopy(row.copy_id),
          account = this.repo.getAccount(copy.accountId);
        if (
          !account.enabled ||
          !account.uid ||
          account.uid !== row.owner_uid ||
          copy.status !== "draft" ||
          this.db.get(
            "SELECT id FROM jobs WHERE copy_id=? AND kind='transfer'",
            copy.id,
          )
        ) {
          this.db.run(
            "UPDATE transfer_batch_items SET state='skipped',error=? WHERE id=?",
            "账号状态或副本已变化，请核对原任务。",
            itemId,
          );
          result.skipped++;
          continue;
        }
        const selectedIds = parseJson<string[]>(row.selected_ids, []),
          files = parseJson<RemoteFile[]>(row.files, []).filter((f) =>
            selectedIds.includes(f.id),
          );
        if (!files.length)
          throw new AppError(
            "SELECTION_REQUIRED",
            "每份待转存资料至少选择一项文件。",
          );
        const jobId = this.addJob(copy.id, "transfer", itemId, batchId);
        this.db.run(
          "UPDATE copies SET selected_files=?,status='queued',error=NULL WHERE id=?",
          JSON.stringify(files),
          copy.id,
        );
        this.db.run(
          "UPDATE transfer_batch_items SET state='started',transfer_job_id=?,error=NULL WHERE id=?",
          jobId,
          itemId,
        );
        result.created++;
      }
    });
    this.changed();
    return result;
  }
  batchJobs(batchId: string) {
    return this.batch(batchId).items.flatMap((i) => [
      i.inspectJobId,
      ...(i.transferJobId ? [i.transferJobId] : []),
    ]);
  }
  createSplit(copyId: string, depth: number, mode: "level" | "all") {
    const copy = this.repo.getCopy(copyId);
    if (
      copy.status !== "ready" ||
      !copy.folderId ||
      !copy.verifiedAt ||
      !copy.ownerUid
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "请先完成本人资料转存和文件归属核验。",
      );
    const runId = id("split_run");
    this.db.transaction(() => {
      const jobId = this.addJob(copyId, "split_preview", runId, null);
      this.db.run(
        "INSERT INTO split_runs(id,copy_id,depth,mode,job_id,created_at) VALUES(?,?,?,?,?,?)",
        runId,
        copyId,
        depth,
        mode,
        jobId,
        now(),
      );
    });
    this.changed();
    return this.split(runId);
  }
  splitItem(itemId: string): SplitItem {
    const row = this.db.get<Row>(
      "SELECT i.*,j.stage FROM split_items i LEFT JOIN jobs j ON j.id=i.job_id WHERE i.id=?",
      itemId,
    );
    if (!row) throw new AppError("NOT_FOUND", "拆分项不存在。");
    return {
      id: row.id,
      copyId: row.copy_id,
      file: parseJson(row.file, {} as RemoteFile),
      ancestors: parseJson(row.ancestors, []),
      path: row.path,
      depth: row.depth,
      status: row.status,
      shareId: row.share_id,
      shareUrl: row.share_url,
      ownerUid: row.owner_uid,
      verifiedAt: row.verified_at,
      error: row.error,
      jobId: row.job_id,
      shareVersion: row.share_version,
      stage: row.stage ?? null,
    };
  }
  split(runId: string): SplitRun {
    const row = this.db.get<Row>("SELECT * FROM split_runs WHERE id=?", runId);
    if (!row) throw new AppError("NOT_FOUND", "拆分预览不存在。");
    return {
      id: row.id,
      copyId: row.copy_id,
      depth: row.depth,
      mode: row.mode,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      jobId: row.job_id,
      items: this.db
        .all<Row>(
          "SELECT item_id FROM split_run_items WHERE run_id=? ORDER BY rowid",
          runId,
        )
        .map((r) => this.splitItem(r.item_id)),
    };
  }
  splits(copyId: string) {
    return this.db
      .all<Row>(
        "SELECT id,depth,mode,status,created_at FROM split_runs WHERE copy_id=? ORDER BY created_at DESC LIMIT 30",
        copyId,
      )
      .map((r) => ({
        id: r.id,
        depth: r.depth,
        mode: r.mode,
        status: r.status,
        createdAt: r.created_at,
      }));
  }
  private directory(provider: Provider, file: RemoteFile) {
    if (!file.isDirectory)
      throw new AppError("NOT_DIRECTORY", "该节点不是目录。");
    if (provider === "baidu" && (!file.path || !file.path.startsWith("/")))
      throw new AppError(
        "DIRECTORY_PATH_MISSING",
        "百度未返回子目录绝对路径，未继续展开。",
      );
    return provider === "baidu" ? file.path! : file.id;
  }
  private async ownedRoot(copyId: string) {
    const copy = this.repo.getCopy(copyId),
      account = await this.verifyAccount(copy.accountId),
      provider = this.providers[account.provider];
    if (
      copy.status !== "ready" ||
      !copy.folderId ||
      !copy.verifiedAt ||
      !copy.files.length ||
      copy.ownerUid !== account.uid
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "资料文件尚未通过当前本人账号的归属核验。",
      );
    const files = await provider.list(account, copy.folderId);
    assertManifest(copy.files, files);
    if (copy.files.some((f) => !files.some((a) => a.id === f.id)))
      throw new AppError(
        "TARGET_CHANGED",
        "资料根目录文件ID发生变化，未继续处理。",
      );
    return { copy, account, provider, files };
  }
  private async inspectSplit(job: Job) {
    const run = this.split(job.targetId!);
    this.step(job.id, "preflight");
    this.db.run(
      "UPDATE split_runs SET status='inspecting',error=NULL WHERE id=?",
      run.id,
    );
    this.changed();
    const { account, provider, files } = await this.ownedRoot(job.copyId);
    const candidates: {
        file: RemoteFile;
        ancestors: RemoteFile[];
        depth: number;
        path: string;
      }[] = [],
      seen = new Set<string>();
    let nodes = 0;
    const walk = async (
      rows: RemoteFile[],
      ancestors: RemoteFile[],
      depth: number,
    ): Promise<void> => {
      for (const file of rows) {
        if (this.repo.getJob(job.id).stage === "cancelled")
          throw new AppError("CANCELLED", "目录读取已停止。");
        if (++nodes > 2000 || seen.has(file.id))
          throw new AppError(
            "TREE_LIMIT",
            "目录超过2000项或出现重复节点，请缩小资料范围。",
          );
        seen.add(file.id);
        const path = [...ancestors.map((f) => f.name), file.name].join(" / ");
        let children: RemoteFile[] | null = null;
        if (file.isDirectory && depth < run.depth)
          children = await provider.list(
            account,
            this.directory(account.provider, file),
          );
        if (
          run.mode === "all" ||
          !file.isDirectory ||
          depth === run.depth ||
          children?.length === 0
        ) {
          candidates.push({ file, ancestors, depth, path });
          if (nodes % 25 === 0) {
            this.repo.log(job.id, `已处理${nodes}个目录节点，继续读取。`);
            this.changed();
          }
        }
        if (children?.length)
          await walk(children, [...ancestors, file], depth + 1);
      }
    };
    await walk(files, [], 1);
    this.step(job.id, "preflight");
    if (!candidates.length)
      throw new AppError("EMPTY_SPLIT", "资料中没有可拆分的文件或文件夹。");
    this.db.transaction(() => {
      this.db.run("DELETE FROM split_run_items WHERE run_id=?", run.id);
      for (const candidate of candidates) {
        let row = this.db.get<Row>(
          "SELECT * FROM split_items WHERE copy_id=? AND file_id=?",
          job.copyId,
          candidate.file.id,
        );
        const changed =
          row &&
          (row.file !== JSON.stringify(candidate.file) ||
            row.ancestors !== JSON.stringify(candidate.ancestors));
        if (
          changed &&
          row?.job_id &&
          (active.includes(this.repo.getJob(row.job_id).stage) ||
            this.repo.getJob(row.job_id).checkpoint === "share_requested")
        )
          throw new AppError(
            "SPLIT_ITEM_BUSY",
            "已有拆分任务等待核对，目录变化前请先处理该任务。",
          );
        const itemId = row?.id ?? id("split_item");
        if (!row)
          this.db.run(
            "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth) VALUES(?,?,?,?,?,?,?)",
            itemId,
            job.copyId,
            candidate.file.id,
            JSON.stringify(candidate.file),
            JSON.stringify(candidate.ancestors),
            candidate.path,
            candidate.depth,
          );
        else if (changed)
          this.db.run(
            "UPDATE split_items SET file=?,ancestors=?,path=?,depth=?,status='draft',verified_at=NULL,error=NULL WHERE id=?",
            JSON.stringify(candidate.file),
            JSON.stringify(candidate.ancestors),
            candidate.path,
            candidate.depth,
            itemId,
          );
        this.db.run("INSERT INTO split_run_items VALUES(?,?)", run.id, itemId);
      }
      this.db.run(
        "UPDATE split_runs SET status='ready',error=NULL WHERE id=?",
        run.id,
      );
    });
    this.repo.log(
      job.id,
      `三级范围读取完成，预计${candidates.length}个链接；尚未创建分享。`,
    );
    this.finish(job.id);
  }
  startSplit(runId: string, selected: string[]) {
    const run = this.split(runId),
      ids = [...new Set(selected)];
    if (
      run.status !== "ready" ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => !run.items.some((i) => i.id === id))
    )
      throw new AppError(
        "INVALID_SELECTION",
        "请选择已完成预览的拆分项，最多100项。",
      );
    const result = { created: 0, reused: 0 };
    this.db.transaction(() => {
      for (const itemId of ids) {
        const item = this.splitItem(itemId);
        if (item.status === "ready" && item.verifiedAt) {
          result.reused++;
          continue;
        }
        if (item.jobId) {
          const job = this.repo.getJob(item.jobId);
          if (active.includes(job.stage)) {
            result.reused++;
            continue;
          }
          this.db.run(
            "UPDATE jobs SET stage='queued',checkpoint=?,attempts=attempts+1,error=NULL,updated_at=? WHERE id=?",
            job.checkpoint === "complete" ? "new" : job.checkpoint,
            now(),
            job.id,
          );
        } else {
          const jobId = this.addJob(item.copyId, "split_share", item.id, runId);
          this.db.run(
            "UPDATE split_items SET job_id=? WHERE id=?",
            jobId,
            item.id,
          );
        }
        this.db.run(
          "UPDATE split_items SET status='queued',error=NULL WHERE id=?",
          item.id,
        );
        result.created++;
      }
    });
    this.changed();
    return result;
  }
  private async liveItem(item: SplitItem) {
    if (
      item.depth < 1 ||
      item.depth > 3 ||
      item.ancestors.length !== item.depth - 1
    )
      throw new AppError("INVALID_DEPTH", "拆分项层级不正确，请重新预览。");
    const root = await this.ownedRoot(item.copyId);
    let files = root.files;
    for (const ancestor of item.ancestors) {
      const folder = files.find((f) => f.id === ancestor.id);
      if (!folder)
        throw new AppError(
          "TARGET_CHANGED",
          "拆分项所在目录已变化，请重新预览。",
        );
      assertManifest([ancestor], [folder]);
      files = await root.provider.list(
        root.account,
        this.directory(root.account.provider, folder),
      );
    }
    const actual = files.find((f) => f.id === item.file.id);
    if (!actual)
      throw new AppError(
        "TARGET_CHANGED",
        "拆分文件已移动或删除，请重新预览。",
      );
    assertManifest([item.file], [actual]);
    return { ...root, file: actual };
  }
  private async storeSplit(
    item: SplitItem,
    account: Account,
    provider: DriveProvider,
    share: OwnShare,
  ) {
    const resource = this.repo.getResource(
        this.repo.getCopy(item.copyId).resourceId,
      ),
      parsed = parseShare(share.url);
    if (
      share.ownerUid !== account.uid ||
      parsed.provider !== account.provider ||
      parsed.url === resource.sourceUrl ||
      !(await provider.verifyShare(account, share.id, [item.file]))
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "拆分分享未通过本人UID、分享记录与文件核验，禁止分发。",
      );
    await this.secrets.set(`split:${item.id}`, share.code);
    this.db.run(
      "UPDATE split_items SET status='ready',share_id=?,share_url=?,owner_uid=?,verified_at=?,share_version=share_version+?,error=NULL WHERE id=?",
      share.id,
      parsed.url,
      account.uid,
      now(),
      Number(item.shareId !== share.id || item.shareUrl !== parsed.url),
      item.id,
    );
    this.notes.enqueue(item.copyId);
    this.changed();
  }
  private async shareSplit(job: Job) {
    const item = this.splitItem(job.targetId!);
    this.step(job.id, "verifying");
    const { account, provider } = await this.liveItem(item);
    const checkpoint = this.repo.getJob(job.id).checkpoint;
    let share = await provider.findOwnShare(account, [item.file]);
    if (!share && checkpoint === "share_requested")
      throw new AppError(
        "UNCERTAIN_SHARE_RESULT",
        "上次建链结果未知，尚未找到对应本人分享；请在网盘核对后恢复，未重复建链。",
        true,
      );
    if (!share) {
      this.step(job.id, "sharing", "share_requested");
      share = await provider.createShare(account, [item.file], item.file.name);
    }
    await this.storeSplit(item, account, provider, share);
    this.repo.log(
      job.id,
      "本人子链接已核验；没有移动文件、重新转存或更换原资料链接。",
    );
    await this.notes.flush();
    this.finish(job.id);
  }
  async splitLink(itemId: string, includeCode = true) {
    const item = this.splitItem(itemId);
    if (
      item.status !== "ready" ||
      !item.shareId ||
      !item.shareUrl ||
      !item.verifiedAt
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "拆分链接尚未就绪，请先完成或恢复分享。",
      );
    const { account, provider } = await this.liveItem(item);
    if (
      item.ownerUid !== account.uid ||
      item.shareUrl ===
        this.repo.getResource(this.repo.getCopy(item.copyId).resourceId)
          .sourceUrl
    )
      throw new AppError("OWNERSHIP_UNVERIFIED", "拆分链接归属不匹配。");
    if (!(await provider.verifyShare(account, item.shareId, [item.file]))) {
      this.db.run(
        "UPDATE split_items SET status='needs_review',verified_at=NULL,error=? WHERE id=?",
        "本人分享失效或不匹配，请恢复分享。",
        item.id,
      );
      this.changed();
      throw new AppError("SHARE_INVALID", "拆分分享未通过有效性检查。");
    }
    this.db.run(
      "UPDATE split_items SET verified_at=? WHERE id=?",
      now(),
      item.id,
    );
    const code = includeCode
      ? ((await this.secrets.get(`split:${item.id}`)) ?? "")
      : "";
    return {
      path: item.path,
      title: item.file.name,
      url: item.shareUrl,
      code,
      text: `${item.shareUrl}${code ? `\n提取码：${code}` : ""}`,
    };
  }
  async recoverSplit(itemId: string, text: string, code?: string) {
    const item = this.splitItem(itemId),
      { account, provider } = await this.liveItem(item),
      source = parseShare(text, code);
    const share = await provider.recoverOwnShare(account, source, [item.file]);
    if (parseShare(share.url).url !== source.url)
      throw new AppError("OWNERSHIP_UNVERIFIED", "恢复结果与提交链接不一致。");
    await this.storeSplit(item, account, provider, share);
    if (item.jobId) this.finish(item.jobId);
    await this.notes.flush();
    return this.splitItem(itemId);
  }
  splitJobs(runId: string) {
    const run = this.split(runId);
    return [run.jobId, ...run.items.flatMap((i) => (i.jobId ? [i.jobId] : []))];
  }
  cancelled(job: Job) {
    if (job.kind === "batch_inspect")
      this.db.run(
        "UPDATE transfer_batch_items SET state='cancelled',error='已停止读取，请核对后恢复。' WHERE id=?",
        job.targetId!,
      );
    if (job.kind === "split_preview")
      this.db.run(
        "UPDATE split_runs SET status='cancelled',error='已停止目录读取。' WHERE id=?",
        job.targetId!,
      );
    if (job.kind === "split_share")
      this.db.run(
        "UPDATE split_items SET status='cancelled',error='已停止本地等待，请核对远端分享。' WHERE id=? AND status<>'ready'",
        job.targetId!,
      );
  }
}
