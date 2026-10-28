import { useIpcQuery } from "../api/useIpcQuery";
import { Select } from "../ui/Select";
import {
  bindingVerificationState,
  channelProfiles,
  contentFormats,
  linkPositionLabels,
  type ContentFormat,
  type LinkPosition,
} from "../../shared/channels";
import { useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import type { Platform } from "../../shared/types";
import { platformSpecs } from "../../shared/platforms";

import { BindingOpen } from "./BindingOpen";
export function BrowserBindings({
  windows,
}: {
  windows: { id: string; name: string; seq: number | null }[];
}) {
  const { data } = useAppData();
  const environments = useIpcQuery("environments.list", undefined, {
    keepPrevious: true,
  });
  const { command } = useAppActions();
  const { busy } = useAppActivity();
  const { navigate } = useAppNavigation();
  const [bindingId, setBindingId] = useState<string | undefined>(),
    [bindingPlatform, setBindingPlatform] = useState<Platform>("xiaohongshu"),
    [alias, setAlias] = useState(""),
    [windowId, setWindowId] = useState(""),
    [editorUrl, setEditorUrl] = useState(platformSpecs[0].defaultUrl),
    [allowLink, setAllowLink] = useState(false),
    [ruleNote, setRuleNote] = useState("");
  const [verifiedFormats, setVerifiedFormats] = useState<ContentFormat[]>([]);
  const [linkPositions, setLinkPositions] = useState<LinkPosition[]>([]);
  const [editorUrls, setEditorUrls] = useState<
    Partial<Record<ContentFormat, string>>
  >({});
  const [confirmCapabilities, setConfirmCapabilities] = useState(false);
  useEffect(() => {
    setConfirmCapabilities(false);
  }, [
    bindingId,
    bindingPlatform,
    windowId,
    editorUrl,
    verifiedFormats,
    linkPositions,
    editorUrls,
    allowLink,
    ruleNote,
  ]);
  const aliasInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (bindingId) {
      aliasInput.current?.focus();
      aliasInput.current?.scrollIntoView({ block: "center" });
    }
  }, [bindingId]);
  const bindingSpec = platformSpecs.find((p) => p.id === bindingPlatform)!;
  const fingerprintEnvironments = (environments.data ?? []).filter(
    (env) => env.engine === "bitbrowser",
  );
  return (
    <Panel title="平台账号与指纹窗口映射" className="settings-bindings-panel">
      <QueryError
        error={environments.error}
        loading={environments.loading}
        onRetry={environments.reload}
        title="暂时无法读取浏览器环境"
      />
      {!environments.data && !environments.error ? (
        <LoadingState compact label="正在读取可用浏览器环境…" />
      ) : null}
      {environments.data &&
      !environments.error &&
      !fingerprintEnvironments.length ? (
        <Empty compact title="尚未接入指纹浏览器环境">
          先在侧栏“指纹浏览器”中接入比特配置，再添加平台映射。
          <Button onClick={() => navigate("browser-environments")}>
            管理指纹浏览器
          </Button>
        </Empty>
      ) : null}
      <h3 className="settings-form-title">
        {bindingId ? "编辑账号映射" : "添加账号映射"}
      </h3>
      <div className="field-pair">
        <Field label="内容平台">
          <Select
            aria-label="内容平台"
            disabled={!!bindingId}
            value={bindingPlatform}
            onValueChange={(nextValue) => {
              const platform = nextValue as Platform;
              setBindingPlatform(platform);
              setEditorUrl(
                platformSpecs.find((p) => p.id === platform)!.defaultUrl,
              );
              setAllowLink(false);
              setVerifiedFormats([]);
              setLinkPositions([]);
              setRuleNote("");
              setEditorUrls({});
            }}
            items={[
              ...platformSpecs.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>
        <Field label="发布账号别名">
          <input
            ref={aliasInput}
            aria-label="发布账号别名"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="例如：效率分享小红书账号"
          />
        </Field>
        <Field label="浏览器环境" hint="在侧栏“指纹浏览器”中接入比特配置">
          <Select
            aria-label="发布浏览器环境"
            value={windowId}
            onValueChange={setWindowId}
            disabled={!environments.data || !fingerprintEnvironments.length}
            items={[
              { value: "", label: "请选择浏览器环境", disabled: true },
              ...fingerprintEnvironments.map((env) => ({
                value: env.profileId,
                label: env.name,
              })),
            ]}
          />
        </Field>
        <Field label="编辑器入口">
          <input
            aria-label="编辑器入口"
            value={editorUrl}
            onChange={(e) => setEditorUrl(e.target.value)}
          />
        </Field>
      </div>
      <p className="muted settings-binding-summary" aria-label="账号联调概况">
        已核实{" "}
        {
          data!.bindings.filter(
            (b) => bindingVerificationState(b) === "verified",
          ).length
        }{" "}
        个账号 · 待核验{" "}
        {
          data!.bindings.filter(
            (b) => bindingVerificationState(b) === "pending",
          ).length
        }{" "}
        个 · 链接待复核{" "}
        {
          data!.bindings.filter(
            (b) => bindingVerificationState(b) === "expired",
          ).length
        }{" "}
        个
      </p>
      <fieldset className="channel-fieldset">
        <legend>按内容形式设置发布入口</legend>
        <small>
          使用本人账号后台确认过的官方地址。留空使用上方通用入口，打开站点不代表已进入编辑器。
        </small>
        <div className="field-pair">
          {channelProfiles[bindingPlatform].formats.map((format) => (
            <Field key={format} label={`${contentFormats[format].name}入口`}>
              <input
                aria-label={`${contentFormats[format].name}发布入口`}
                type="url"
                value={editorUrls[format] ?? ""}
                placeholder="留空使用通用入口"
                onChange={(e) =>
                  setEditorUrls((previous) => ({
                    ...previous,
                    [format]: e.target.value,
                  }))
                }
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <Notice warning>{bindingSpec.rule}</Notice>
      <fieldset className="channel-fieldset">
        <legend>已核实账号可发布的内容形式</legend>
        <small>
          仅勾选此账号后台实际具备的能力；未勾选的形式仍可写稿，但不能交付给此账号。
        </small>
        <div className="channel-capabilities">
          {channelProfiles[bindingPlatform].formats.map((format) => (
            <label className="checkbox" key={format}>
              <input
                type="checkbox"
                checked={verifiedFormats.includes(format)}
                onChange={(e) =>
                  setVerifiedFormats((previous) =>
                    e.target.checked
                      ? [...previous, format]
                      : previous.filter((v) => v !== format),
                  )
                }
              />
              {contentFormats[format].name}
              {format === "longform" ? "（请先确认长文入口）" : ""}
            </label>
          ))}
        </div>
      </fieldset>
      <Button
        quiet
        onClick={() =>
          void command("system.external", { url: bindingSpec.ruleUrl })
        }
      >
        查看平台规则与能力来源
      </Button>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowLink}
          disabled={!channelProfiles[bindingPlatform].positions.length}
          onChange={(e) => setAllowLink(e.target.checked)}
        />
        此账号需要使用获准的网盘资源入口
      </label>
      {allowLink ? (
        <fieldset className="channel-fieldset">
          <legend>允许的链接位置</legend>
          <small>
            以下为待核验的候选位置，并非平台已授权；适用于上面勾选的内容形式。组件资料不会附加到正文。
          </small>
          <div className="channel-capabilities">
            {channelProfiles[bindingPlatform].positions.map((position) => (
              <label className="checkbox" key={position}>
                <input
                  type="checkbox"
                  checked={linkPositions.includes(position)}
                  onChange={(e) =>
                    setLinkPositions((previous) =>
                      e.target.checked
                        ? [...previous, position]
                        : previous.filter((v) => v !== position),
                    )
                  }
                />
                {linkPositionLabels[position]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {
        <Field
          label="核实依据"
          hint="至少10字，记录具体后台能力、场景与规则来源"
        >
          <textarea
            aria-label="核实依据"
            value={ruleNote}
            onChange={(e) => setRuleNote(e.target.value)}
            placeholder="记录允许的发布场景和核实依据"
          />
        </Field>
      }
      <label className="checkbox">
        <input
          aria-label="确认本次账号能力核实"
          type="checkbox"
          checked={confirmCapabilities}
          onChange={(e) => setConfirmCapabilities(e.target.checked)}
        />
        已在此指纹窗口核对本人账号、内容形式、发布入口和链接场景，确认本次核实
      </label>
      <small>
        仅修改别名不会续期。更换窗口、入口或权限范围会使旧核实失效；重新核实后勾选上方确认。
      </small>

      <div className="actions">
        <Button
          primary
          disabled={!alias || !windowId || !editorUrl || busy > 0}
          onClick={async () => {
            const saved = await command(
              "binding.save",
              {
                id: bindingId,
                platform: bindingPlatform,
                alias,
                windowId,
                editorUrl,
                linkPermission: allowLink ? "allowed" : "none",
                ruleNote,
                capabilities: {
                  formats: verifiedFormats,
                  linkPositions,
                  editorUrls,
                },
                confirmCapabilities,
              },
              "平台账号与窗口映射已保存。",
            );
            if (saved) {
              setBindingId(undefined);
              setVerifiedFormats([]);
              setLinkPositions([]);
              setEditorUrls({});
              setConfirmCapabilities(false);
              setAlias("");
              setWindowId("");
              setRuleNote("");
              setAllowLink(false);
            }
          }}
        >
          <Save size={14} />
          {bindingId ? "更新映射" : "保存映射"}
        </Button>
        {bindingId ? (
          <Button
            quiet
            onClick={() => {
              setBindingId(undefined);
              setVerifiedFormats([]);
              setLinkPositions([]);
              setEditorUrls({});
              setConfirmCapabilities(false);
              setAlias("");
              setWindowId("");
              setAllowLink(false);
              setRuleNote("");
            }}
          >
            取消修改
          </Button>
        ) : null}
      </div>
      <h3 className="settings-list-title">
        已保存的映射 <span className="muted">{data!.bindings.length}</span>
      </h3>
      {data!.bindings.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>平台账号</th>
                <th>浏览器环境</th>
                <th>链接策略</th>
                <th>编辑器入口</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data!.bindings.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.alias}
                    <br />
                    <small>
                      {platformSpecs.find((p) => p.id === b.platform)?.name}
                      {" · "}
                      {b.capabilities.formats
                        .map((f) => contentFormats[f].name)
                        .join("、") || "内容形式待核验"}
                    </small>
                  </td>
                  <td>
                    {environments.data?.find((env) =>
                      env.accounts.some((ref) =>
                        b.websiteAccountId
                          ? ref.kind === "website" &&
                            ref.id === b.websiteAccountId
                          : ref.kind === "binding" && ref.id === b.id,
                      ),
                    )?.name ?? "关联环境待读取"}
                  </td>
                  <td>
                    <Status
                      kind={
                        bindingVerificationState(b) === "verified"
                          ? "good"
                          : "warning"
                      }
                    >
                      {bindingVerificationState(b) === "pending"
                        ? "待核验"
                        : bindingVerificationState(b) === "expired"
                          ? "链接待复核"
                          : "已核实"}
                    </Status>
                    <small>
                      {b.linkPermission === "allowed"
                        ? "按核实场景允许链接"
                        : "不附链接"}
                    </small>
                    <small className="table-note">
                      {b.capabilities.linkPositions
                        .map((p) => linkPositionLabels[p])
                        .join("、")}
                    </small>
                    {b.verifiedAt ? (
                      <small className="table-note">
                        核实：{formatTime(b.verifiedAt)} · 链接权限30天内有效
                      </small>
                    ) : null}
                  </td>
                  <td className="break-word">
                    {b.editorUrl}
                    {b.lastCheckedAt ? (
                      <small className="table-note">
                        最近检查：{formatTime(b.lastCheckedAt)}
                      </small>
                    ) : null}
                    {b.openError ? (
                      <Notice warning>{b.openError}</Notice>
                    ) : b.lastOpenedAt ? (
                      <small className="table-note">
                        上次导航成功，发布前仍需核对窗口内的登录账号。
                      </small>
                    ) : (
                      <small className="table-note">尚未检查页面访问状态</small>
                    )}
                  </td>
                  <td>
                    <BindingOpen binding={b} />
                    <Button
                      quiet
                      onClick={() => {
                        if (b.websiteAccountId) {
                          navigate("website-accounts");
                          return;
                        }
                        setBindingId(b.id);
                        setBindingPlatform(b.platform);
                        setAlias(b.alias);
                        setWindowId(b.windowId);
                        setEditorUrl(b.editorUrl);
                        setAllowLink(b.linkPermission === "allowed");
                        setRuleNote(b.ruleNote);
                        setVerifiedFormats(b.capabilities.formats);
                        setLinkPositions(b.capabilities.linkPositions);
                        setEditorUrls(b.capabilities.editorUrls ?? {});
                        setConfirmCapabilities(false);
                      }}
                    >
                      {b.websiteAccountId ? "管理账号" : "编辑"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty compact title="尚未添加账号映射">
          先连接比特浏览器，再填写本人账号与指纹窗口；发布前仍需完成能力核验。
        </Empty>
      )}
    </Panel>
  );
}
