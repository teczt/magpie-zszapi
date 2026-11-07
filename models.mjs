// models.mjs converts 执算者AI (zszapi.com) model catalogue entries into
// Magpie runtime models. One API Key belongs to exactly one group on the site,
// so the catalogue already reflects that group's permissions. Standard Sub2API
// lists carry no protocol metadata; the model family chooses the text API the
// gateway serves natively for that family. Explicit server protocols, when a
// future backend reports them, always take precedence over name inference.
//
// Non-chat models (image, video, audio, embedding) cannot be used by coding
// agents through Magpie and are left out, so an image-only group yields an
// empty list that the usage card explains.

export const PROVIDER = "zszapi";

// ENDPOINTS maps server protocol identifiers to the AI SDK package that Magpie
// uses to choose request shapes, and the URL suffix below the site base.
export const ENDPOINTS = [
  ["anthropic_messages", "@ai-sdk/anthropic", "/v1"],
  ["openai_responses", "@ai-sdk/openai", "/v1"],
  ["openai_chat_completions", "@ai-sdk/openai-compatible", "/v1"],
  ["gemini_generate_content", "@ai-sdk/google", "/v1beta"],
];

// NON_CHAT recognizes generation endpoints that are not text conversations.
const NON_CHAT =
  /(?:image|dall-e|sora|video|veo|seedance|kling|imagen|midjourney|tts|whisper|transcribe|audio|speech|embedding|embed|rerank|moderation|realtime)/;

// FAMILIES lists recognizable model families, their native text protocol and
// conservative capability defaults (tool calls and input kinds that every
// current model of the family supports). Server attributes override them.
const TEXT_IMAGE = { text: true, image: true, audio: false, video: false, pdf: false };
const TEXT_ONLY = { text: true, image: false, audio: false, video: false, pdf: false };
const FAMILIES = [
  {
    label: "Claude",
    test: /^claude(?:[-_.]|$)/,
    protocol: "anthropic_messages",
    capabilities: { reasoning: true, toolcall: true, input: TEXT_IMAGE },
  },
  {
    label: "GPT",
    test: /^(?:gpt[-_.]|chatgpt[-_.]|codex[-_.]|o\d)/,
    protocol: "openai_responses",
    capabilities: { reasoning: true, toolcall: true, input: TEXT_IMAGE },
  },
  {
    label: "Gemini",
    test: /^gemini(?:[-_.]|$)/,
    protocol: "gemini_generate_content",
    capabilities: { reasoning: true, toolcall: true, input: TEXT_IMAGE },
  },
  {
    label: "DeepSeek",
    test: /^deepseek(?:[-_.]|$)/,
    protocol: "openai_chat_completions",
    capabilities: { toolcall: true, input: TEXT_ONLY },
  },
  {
    label: "Grok",
    test: /^grok(?:[-_.]|$)/,
    protocol: "openai_chat_completions",
    capabilities: { toolcall: true },
  },
];

/** familyOf returns the recognized family of one model ID, or undefined.
 * Composite group prefixes ("work/claude-…") are ignored for recognition only.
 */
export function familyOf(id) {
  const name = String(id).slice(String(id).lastIndexOf("/") + 1).toLowerCase();
  return FAMILIES.find((family) => family.test.test(name));
}

/** isChatModel reports whether a catalogue entry can serve text conversations.
 * Server protocols decide when present; otherwise known non-chat names are excluded.
 */
export function isChatModel(model) {
  if (Object.hasOwn(model, "protocols")) {
    return model.protocols.some((protocol) =>
      ENDPOINTS.some(([id]) => id === protocol),
    );
  }
  const name = model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
  return !NON_CHAT.test(name);
}

/** familyLabel summarizes the families present in a catalogue, e.g. "GPT" or
 * "Claude/GPT". It names the account so a customer holding several Keys (one
 * per group) can tell them apart. Unknown families contribute nothing.
 */
export function familyLabel(models) {
  const labels = [];
  for (const model of models) {
    if (!isChatModel(model)) continue;
    const label = familyOf(model.id)?.label;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join("/");
}

/** accountName builds "执算者AI · GPT · 尾号 8bfa". The model family tells a
 * customer's per-group Keys apart; Keys shorter than eight characters show no
 * suffix so a mistyped short value is never displayed whole.
 */
export function accountName(key, families) {
  const parts = ["执算者AI"];
  if (families) parts.push(families);
  parts.push(key.length >= 8 ? `尾号 ${key.slice(-4)}` : "API Key");
  return parts.join(" · ");
}

/** protocolsOf chooses text protocol candidates for one catalogue entry.
 * Server permissions win, including an explicitly empty list; then exact
 * user overrides; then the family's native protocol; Chat Completions last.
 */
export function protocolsOf(model, overrides) {
  if (Object.hasOwn(model, "protocols")) return model.protocols;
  if (Object.hasOwn(overrides, model.id)) return [overrides[model.id]];
  return [familyOf(model.id)?.protocol || "openai_chat_completions"];
}

/** validateModelProtocols checks optional exact overrides for model IDs. */
export function validateModelProtocols(value) {
  if (value == null) return Object.create(null);
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([model, protocol]) =>
        !model || !ENDPOINTS.some(([id]) => id === protocol),
    )
  ) {
    throw new Error(
      "modelProtocols 需要使用完整模型 ID 和支持的文本协议名称（anthropic_messages / openai_responses / openai_chat_completions / gemini_generate_content）。",
    );
  }
  return { ...value };
}

/** runtimeModel converts one catalogue entry to a Magpie model, or undefined
 * when the entry cannot serve text conversations. Server attributes take
 * precedence over family defaults; numeric limits are never invented.
 */
export function runtimeModel(model, base, overrides) {
  if (!isChatModel(model)) return undefined;
  const protocols = protocolsOf(model, overrides);
  const native = Array.isArray(model.native_protocols)
    ? model.native_protocols
    : [];
  const endpoint =
    ENDPOINTS.find(([id]) => protocols.includes(id) && native.includes(id)) ||
    ENDPOINTS.find(([id]) => protocols.includes(id));
  if (!endpoint) return undefined;
  const [, npm, suffix] = endpoint;
  const attrs = model.attributes || {};
  const capabilities = structuredClone(familyOf(model.id)?.capabilities || {});
  for (const [source, target] of [
    ["reasoning", "reasoning"],
    ["tool_call", "toolcall"],
    ["temperature", "temperature"],
    ["attachment", "attachment"],
  ]) {
    if (typeof attrs[source] === "boolean") capabilities[target] = attrs[source];
    // Magpie's boolean capability cannot express gateway request conditions.
    if (attrs.conditions?.[source]) capabilities[target] = false;
  }
  for (const [source, target] of [
    ["input_modalities", "input"],
    ["output_modalities", "output"],
  ]) {
    if (Array.isArray(attrs[source])) {
      capabilities[target] = Object.fromEntries(
        ["text", "image", "audio", "video", "pdf"].map((kind) => [
          kind,
          attrs[source].includes(kind),
        ]),
      );
    }
  }
  if (attrs.interleaved !== undefined) capabilities.interleaved = attrs.interleaved;
  const variants = Object.create(null);
  for (const option of Array.isArray(attrs.reasoning_options)
    ? attrs.reasoning_options
    : []) {
    if (attrs.reasoning !== true || option?.type !== "effort" || !Array.isArray(option.values))
      continue;
    for (const value of option.values) {
      if (typeof value === "string" && value) variants[value] = {};
    }
  }
  const limit = {};
  for (const [source, target] of [
    ["context", "context"],
    ["input_limit", "input"],
    ["output_limit", "output"],
  ]) {
    if (Number.isFinite(attrs[source]) && attrs[source] > 0) limit[target] = attrs[source];
  }
  return {
    id: model.id,
    providerID: PROVIDER,
    name: model.display_name || model.id,
    api: { id: model.id, url: base + suffix, npm },
    capabilities,
    limit,
    variants,
    status: "active",
    headers: {},
    options: {},
  };
}
