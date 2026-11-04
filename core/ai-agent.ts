import type { AiModel } from "../shared/ai-models";
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentToolCall,
  AgentTurnInput,
  AgentTurnResult,
} from "../shared/ai-agent";
import { Database, id, now } from "./database";
import { AppError, ServiceHttpError, safeMessage } from "./errors";
import { fetchJson } from "./http";
import { nonnegativePrice } from "./model-pricing";
import { budgetDayStart } from "./traffic";

const maxPayloadBytes = 2_000_000;
const namePattern = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const callIdPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const scopeIdPattern = /^[A-Za-z0-9_-]{1,150}$/;

function invalid(message: string): never {
  throw new AppError("INVALID_AGENT_REQUEST", message);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function amount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`${label}必须是非负整数美元微单位。`);
  return value;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max)
    invalid(`${label}格式错误或超过长度限制。`);
  return value;
}
/** Also rejects cyclic/non-JSON values instead of silently altering signed reasoning blocks. */
function jsonSize(value: unknown, maxBytes: number, label: string): number {
  const seen = new Set<object>();
  let nodes = 0;
  function walk(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32) invalid(`${label}结构过大。`);
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || seen.has(item))
      invalid(`${label}必须为有限JSON数据。`);
    seen.add(item);
    if (Array.isArray(item)) item.forEach((child) => walk(child, depth + 1));
    else Object.values(item).forEach((child) => walk(child, depth + 1));
    seen.delete(item);
  }
  walk(value, 0);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maxBytes) invalid(`${label}超过大小限制。`);
  return bytes;
}

function toolCall(value: unknown, toolNames: Set<string>): AgentToolCall {
  if (!record(value) || value.type !== "function" || !record(value.function))
    invalid("模型工具调用结构无法识别。");
  const callId = text(value.id, 200, "工具调用ID");
  const name = text(value.function.name, 64, "工具名称");
  if (!callIdPattern.test(callId) || !toolNames.has(name))
    invalid("模型返回未知工具名称或无效调用ID。");
  return {
    id: callId,
    type: "function",
    function: {
      name,
      // Domain code must parse JSON and validate the argument schema before executing a tool.
      arguments: text(value.function.arguments, 64_000, "工具参数"),
    },
  };
}

function assistantMessage(
  value: unknown,
  toolNames: Set<string>,
  maxToolCalls = 1,
): AgentAssistantMessage {
  if (!record(value) || value.role !== "assistant")
    invalid("模型未返回assistant消息。");
  const content =
    value.content == null ? null : text(value.content, 200_000, "模型内容");
  const result: AgentAssistantMessage = { role: "assistant", content };
  if (value.tool_calls != null) {
    // A provider can return several requests even when the prompt asks for one.
    // The domain validates the whole bounded batch, then runs it sequentially.
    if (
      !Array.isArray(value.tool_calls) ||
      value.tool_calls.length > maxToolCalls
    )
      invalid(`本轮模型响应最多接受${maxToolCalls}个顺序工具请求。`);
    result.tool_calls = value.tool_calls.map((call) =>
      toolCall(call, toolNames),
    );
    if (
      new Set(result.tool_calls.map((call) => call.id)).size !==
      result.tool_calls.length
    )
      invalid("同一响应的工具调用ID重复，未执行任何工具。");
  }
  if (value.reasoning != null)
    result.reasoning = text(value.reasoning, 500_000, "推理上下文");
  else if (value.reasoning === null) result.reasoning = null;
  if (value.reasoning_details != null) {
    if (
      !Array.isArray(value.reasoning_details) ||
      !value.reasoning_details.every(record)
    )
      invalid("模型推理上下文结构无法识别。");
    jsonSize(value.reasoning_details, 1_000_000, "推理上下文");
    // Never redact, rebuild, rearrange, summarize, or strip fields from these signed blocks.
    result.reasoning_details = value.reasoning_details;
  }
  if (!content?.trim() && !result.tool_calls?.length)
    invalid("模型没有返回可用内容或工具调用。");
  return result;
}

function validateConversation(
  messages: unknown,
  tools: unknown,
  maxToolCalls = 1,
) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 32)
    invalid("每轮必须提供1至32个工具定义。");
  const names = new Set<string>();
  for (const tool of tools) {
    if (!record(tool) || tool.type !== "function" || !record(tool.function))
      invalid("工具定义格式错误。");
    const definition = tool.function;
    const name = text(definition.name, 64, "工具名称");
    if (!namePattern.test(name) || names.has(name))
      invalid("工具名称无效或重复。");
    names.add(name);
    text(definition.description, 8_000, "工具描述");
    if (
      !record(definition.parameters) ||
      definition.parameters.type !== "object" ||
      (definition.strict != null && typeof definition.strict !== "boolean")
    )
      invalid("工具参数定义格式错误。");
  }
  jsonSize(tools, 250_000, "工具定义");
  if (!Array.isArray(messages) || !messages.length || messages.length > 200)
    invalid("智能运营上下文必须包含1至200条消息。");
  const calls = new Set<string>(),
    outstanding = new Set<string>();
  const clean: AgentMessage[] = [];
  for (const message of messages) {
    if (!record(message)) invalid("对话消息格式错误。");
    if (message.role === "tool") {
      const callId = text(message.tool_call_id, 200, "工具结果调用ID");
      if (!outstanding.delete(callId))
        invalid("工具结果缺少对应调用或已重复返回。");
      clean.push({
        role: "tool",
        tool_call_id: callId,
        content: text(message.content, 200_000, "工具结果"),
      });
      continue;
    }
    if (outstanding.size) invalid("必须先返回所有工具调用结果再继续对话。");
    if (message.role === "assistant") {
      const parsed = assistantMessage(message, names, maxToolCalls);
      for (const call of parsed.tool_calls ?? []) {
        if (calls.has(call.id)) invalid("对话中存在重复工具调用ID。");
        calls.add(call.id);
        outstanding.add(call.id);
      }
      clean.push(parsed);
    } else if (message.role === "system" || message.role === "user") {
      clean.push({
        role: message.role,
        content: text(message.content, 200_000, "对话内容"),
      });
    } else invalid("对话角色无法识别。");
  }
  if (outstanding.size) invalid("尚有未返回结果的工具调用，不能继续请求模型。");
  return { messages: clean, names, callIds: calls };
}

export function agentModelPrices(selected: AiModel) {
  const prompt = nonnegativePrice(selected.promptPrice),
    completion = nonnegativePrice(selected.completionPrice),
    quotedRequest = nonnegativePrice(selected.requestPrice);
  if (
    prompt == null ||
    completion == null ||
    (selected.requestPrice != null && quotedRequest == null)
  )
    throw new AppError(
      "MODEL_PRICE_REQUIRED",
      "自主运营需要有效的输入、输出报价及可识别的固定费格式，请刷新OpenRouter模型列表。",
    );
  // PublicPricing.request is optional in OpenRouter's OpenAPI schema. Missing is
  // not a quoted zero: the routing policy refuses endpoints charging a fixed fee.
  return {
    prompt,
    completion,
    requestPriceKnown: quotedRequest != null,
    requestPriceCeiling: quotedRequest ?? 0,
  };
}

function actualCost(response: unknown): number | null {
  if (!record(response) || !record(response.usage)) return null;
  const value = response.usage.cost;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  const micros = Math.ceil(value * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function perMillion(price: number): number {
  // Avoid routing a $0.1/M endpoint out with a binary-float ceiling of 0.09999999999999999.
  return Number((price * 1_000_000).toPrecision(15));
}

function providerDiagnostic(error: unknown, key: string): string {
  if (!(error instanceof ServiceHttpError)) return "";
  let message = error.message;
  // A provider may echo a credential without the usual sk-/Bearer prefix. Scrub
  // this request's actual value before truncating or retaining diagnostic text.
  const forms = new Set([
    key,
    JSON.stringify(key).slice(1, -1),
    Buffer.from(key).toString("base64"),
  ]);
  try {
    forms.add(encodeURIComponent(key));
    forms.add(encodeURI(key));
  } catch {
    /* Malformed pasted Unicode must not break error accounting. */
  }
  for (const secret of forms)
    if (secret) message = message.split(secret).join("[已隐藏Key]");
  message = message.replace(
    /\b(?:api[-_]?key|key|credential|secret|password|token)["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi,
    "凭据=[已隐藏]",
  );
  const safe = safeMessage(new Error(message))
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return safe ? ` 服务原因：${safe}` : "";
}

export interface AgentTransportDependencies {
  db: Database;
  model: string;
  selected: AiModel;
  getKey(): Promise<string | null>;
  requestJson: typeof fetchJson;
  changed(): void;
}

/** One non-retried OpenRouter request. The operations domain owns the tool execution loop. */
export async function runAgentTurn(
  deps: AgentTransportDependencies,
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  const maxToolCalls = input.maxToolCalls ?? 1;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 4)
    invalid("模型工具请求批次上限需要在1至4之间。");
  const { messages, names, callIds } = validateConversation(
    input.messages,
    input.tools,
    maxToolCalls,
  );
  const scope = input.budgetScope;
  if (
    !scope ||
    typeof scope.planId !== "string" ||
    typeof scope.cycleId !== "string" ||
    !scopeIdPattern.test(scope.planId) ||
    !scopeIdPattern.test(scope.cycleId)
  )
    invalid("智能运营计划或周期ID格式错误。");
  amount(scope.dayLimitMicros, "计划日预算");
  amount(scope.cycleLimitMicros, "周期预算");
  amount(input.maxCostMicros, "本轮剩余预算");
  const maxTokens = input.maxOutputTokens ?? 4_000;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 16_000)
    invalid("单轮输出上限必须介于1至16000 tokens。");
  const timeoutMs = input.timeoutMs ?? 90_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 180_000
  )
    invalid("请求超时应介于1至180秒。");
  const prices = agentModelPrices(deps.selected);
  const effort = input.reasoningEffort ?? "default";
  if (!["auto", "default", "low", "medium", "high", "none"].includes(effort))
    invalid("推理强度配置无法识别。");
  const selectedEffort =
    effort === "auto"
      ? deps.selected.reasoningEfforts?.includes("low")
        ? "low"
        : null
      : effort === "default"
        ? null
        : effort;
  if (
    selectedEffort &&
    !deps.selected.reasoningEfforts?.includes(selectedEffort)
  )
    invalid(
      "当前模型目录未声明所选推理强度，未发送请求；请刷新目录或选择自动。",
    );
  const payload = {
    model: deps.model,
    messages,
    tools: input.tools,
    tool_choice: "auto",
    max_tokens: maxTokens,
    stream: false,
    ...(selectedEffort ? { reasoning: { effort: selectedEffort } } : {}),
    provider: {
      require_parameters: true,
      allow_fallbacks: false,
      // Catalog prices are a ceiling, not permission to route to a more expensive provider.
      max_price: {
        prompt: perMillion(prices.prompt),
        completion: perMillion(prices.completion),
        request: prices.requestPriceCeiling,
      },
    },
  };
  const bytes = jsonSize(payload, maxPayloadBytes, "智能运营请求");
  // UTF-8 bytes are a conservative input-token upper bound, including tools and reasoning.
  const reserved = Math.ceil(
    (bytes * prices.prompt +
      maxTokens * prices.completion +
      prices.requestPriceCeiling) *
      1_000_000,
  );
  if (!Number.isSafeInteger(reserved)) invalid("模型报价无法安全估算。");
  if (reserved > input.maxCostMicros)
    throw new AppError(
      "AI_BUDGET_EXCEEDED",
      "本轮剩余模型预算不足，已阻止请求。",
    );
  input.signal?.throwIfAborted();
  const key = await deps.getKey();
  if (!key)
    throw new AppError("API_KEY_REQUIRED", "请先保存OpenRouter API Key。");
  input.signal?.throwIfAborted();
  const requestId = id("ai"),
    phase = `agent:${scope.planId}:${scope.cycleId}`;
  const planPrefix = `agent:${scope.planId}:`;
  deps.db.transaction(() => {
    const base =
      "SELECT COALESCE(SUM(COALESCE(reserved_micros,estimated_micros,0)),0) amount FROM api_calls WHERE endpoint='openrouter' AND status IN ('reserved','success','uncertain')";
    const used = (where: string, ...values: (string | number)[]) =>
      deps.db.get<{ amount: number }>(base + where, ...values)?.amount ?? 0;
    const day = budgetDayStart();
    if (
      deps.db.get(
        "SELECT id FROM api_calls WHERE endpoint='openrouter' AND phase=? AND status IN ('reserved','uncertain') LIMIT 1",
        phase,
      )
    )
      throw new AppError(
        "AI_COST_UNCERTAIN",
        "本周期存在进行中或费用待核实的模型请求，禁止重复调用。",
        true,
      );
    const globalLimit = deps.db.setting<number | null>(
      "dailyAiBudgetMicros",
      null,
    );
    if (
      globalLimit != null &&
      used(" AND created_at>=?", day) + reserved >
        amount(globalLimit, "全局日预算")
    )
      throw new AppError(
        "AI_BUDGET_EXCEEDED",
        "OpenRouter今日全局预算不足，已阻止调用。",
      );
    if (
      used(
        " AND created_at>=? AND substr(phase,1,?)=?",
        day,
        planPrefix.length,
        planPrefix,
      ) +
        reserved >
      scope.dayLimitMicros
    )
      throw new AppError(
        "AI_BUDGET_EXCEEDED",
        "当前运营计划今日模型预算不足，已阻止调用。",
      );
    if (used(" AND phase=?", phase) + reserved > scope.cycleLimitMicros)
      throw new AppError(
        "AI_BUDGET_EXCEEDED",
        "当前运营周期模型预算不足，已阻止调用。",
      );
    deps.db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,estimated_micros,reserved_micros,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      requestId,
      "openrouter",
      phase,
      1,
      reserved,
      reserved,
      "reserved",
      now(),
    );
  });
  let dispatched = false,
    billed: number | null = null,
    reconciled = false;
  const settle = (message: string, status?: "failed") => {
    deps.db.run(
      "UPDATE api_calls SET status=?,confirmed_micros=?,reserved_micros=?,message=? WHERE id=?",
      status ?? (billed == null ? "uncertain" : "success"),
      billed,
      billed ?? reserved,
      message +
        (prices.requestPriceKnown
          ? ""
          : " 目录未提供固定请求费；路由策略强制固定费上限为0，不将缺省报价记为免费。"),
      requestId,
    );
    reconciled = true;
  };
  try {
    input.signal?.throwIfAborted();
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    dispatched = true;
    const response = await deps.requestJson(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Panxu Studio",
        },
        body: JSON.stringify(payload),
        signal,
      },
      timeoutMs,
      (raw) => {
        try {
          billed = actualCost(JSON.parse(raw));
        } catch {
          /* No trustworthy bill was returned. */
        }
      },
    );
    billed = actualCost(response) ?? billed;
    settle(
      billed == null
        ? "自主运营模型已响应；实费未知，保留预留预算并停止周期（美元）。"
        : "自主运营模型调用；按OpenRouter usage.cost登记（美元）。",
    );
    signal.throwIfAborted();
    if (billed != null && billed > reserved)
      throw new AppError(
        "AI_COST_OVERRUN",
        "实际模型费用高于预留，已记录实费并停止当前周期，未执行工具。",
      );
    if (
      response.error ||
      !Array.isArray(response.choices) ||
      response.choices.length !== 1
    )
      throw new AppError(
        "INVALID_AI_RESPONSE",
        "模型响应结构无法识别，费用已登记，未执行工具。",
      );
    const choice = response.choices[0];
    if (!record(choice))
      throw new AppError(
        "INVALID_AI_RESPONSE",
        "模型响应结构无法识别，未执行工具。",
      );
    const finishReason =
      choice.finish_reason == null
        ? null
        : text(choice.finish_reason, 100, "模型结束原因");
    if (
      finishReason !== null &&
      !["stop", "tool_calls"].includes(finishReason)
    ) {
      const usage = record(response.usage) ? response.usage : {},
        details = record(usage.completion_tokens_details)
          ? usage.completion_tokens_details
          : {};
      const count = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? value
          : "未提供";
      throw new AppError(
        "INVALID_AI_RESPONSE",
        `模型输出未完整结束（${finishReason === "length" ? "达到输出token上限" : "服务中止"}），费用已登记，未执行工具。输出tokens=${count(usage.completion_tokens)}，推理tokens=${count(details.reasoning_tokens)}。`,
      );
    }
    let message: AgentAssistantMessage;
    try {
      message = assistantMessage(choice.message, names, maxToolCalls);
    } catch (error) {
      const detail =
        error instanceof AppError && error.code === "INVALID_AGENT_REQUEST"
          ? safeMessage(error)
          : "结构无法识别";
      throw new AppError(
        "INVALID_AI_RESPONSE",
        `模型内容或工具调用未通过结构校验：${detail}费用已登记，未执行工具。`,
      );
    }
    for (const call of message.tool_calls ?? []) {
      if (callIds.has(call.id))
        throw new AppError(
          "INVALID_AI_RESPONSE",
          "模型重复使用工具调用ID，已停止周期，未执行工具。",
        );
    }
    if (
      (finishReason != null &&
        !["stop", "tool_calls"].includes(finishReason)) ||
      !!message.tool_calls?.length !== (finishReason === "tool_calls")
    )
      throw new AppError(
        "INVALID_AI_RESPONSE",
        "模型结束状态与工具调用不一致或输出被中止，费用已登记，未执行工具。",
      );
    return {
      message,
      finishReason,
      costMicros: billed,
      costKnown: billed != null,
      requestId,
      reservedMicros: reserved,
    };
  } catch (error) {
    // Once dispatch has begun, even abort/network/HTTP failures may have been billed. Never retry.
    const diagnostic = providerDiagnostic(error, key);
    if (!reconciled) {
      if (!dispatched)
        deps.db.run(
          "UPDATE api_calls SET status='failed',reserved_micros=0,message=? WHERE id=?",
          "自主运营请求在发送前取消，未调用服务。",
          requestId,
        );
      else if (
        error instanceof ServiceHttpError &&
        error.status === 404 &&
        !(billed != null && billed > 0)
      ) {
        // OpenRouter commits HTTP 200 once a provider accepts inference. A real
        // HTTP 404 is a pre-acceptance routing/request rejection, not a mid-run
        // error.code=404 carried inside HTTP 200. Do not generalize to 5xx/timeouts.
        billed = 0;
        settle(
          `自主运营HTTP 404在服务接受生成前拒绝；确认未计费，预留已释放，未执行工具且不自动重试。${diagnostic}`,
          "failed",
        );
      } else
        settle(
          billed == null
            ? `自主运营请求中断；账单未知，保留预留预算并停止周期（美元）。${diagnostic}`
            : `自主运营响应异常；已登记服务返回实费，未执行工具（美元）。${diagnostic}`,
        );
    } else
      deps.db.run(
        "UPDATE api_calls SET message=message||? WHERE id=?",
        ` 返回内容或费用未通过检查，当前周期停止，未执行工具。${diagnostic}`,
        requestId,
      );
    if (
      error instanceof AppError &&
      !error.uncertain &&
      !(error instanceof ServiceHttpError) &&
      [
        "INVALID_AI_RESPONSE",
        "AI_BUDGET_EXCEEDED",
        "AI_COST_OVERRUN",
        "INVALID_AGENT_REQUEST",
      ].includes(error.code) &&
      reconciled &&
      billed != null
    )
      throw error;
    const status =
      error instanceof ServiceHttpError ? `（HTTP ${error.status}）` : "";
    throw new AppError(
      dispatched && billed == null
        ? "AI_COST_UNCERTAIN"
        : "AI_AGENT_REQUEST_FAILED",
      `自主运营模型请求未完成${status}，调用记录 ${requestId}；${dispatched && billed == null ? "实际费用待核实，禁止自动重试" : "当前周期已停止"}。${diagnostic}`,
      dispatched && billed == null,
    );
  } finally {
    deps.changed();
  }
}
