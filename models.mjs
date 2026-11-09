// models.mjs converts 执算者AI (zszapi.com) model catalogue entries into
// Magpie runtime models. One API Key belongs to exactly one group on the site,
// so the catalogue already reflects that group's permissions. Standard Sub2API
// lists carry no protocol metadata; the model family chooses the text API the
// gateway serves natively for that family. Explicit server protocols, when a
// future backend reports them, always take precedence over name inference.
//
// Images-API models (gpt-image, dall-e) are listed as image-only models on the
// OpenAI-compatible package: Magpie offers them in its image generation picker
// and draws with them at /v1/images/generations and /v1/images/edits. Other
// non-chat models (video, audio, embedding) cannot be used through Magpie and
// are left out.

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

// IMAGES_API recognizes models the gateway draws with on the OpenAI images API.
// It matches the names Magpie itself draws on that API (catalog.ImagesAPI), so
// a listed model always reaches the image generation picker.
const IMAGES_API = /(?:gpt-image|chatgpt-image|dall-e)/;

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
  const name = baseName(id);
  return FAMILIES.find((family) => family.test.test(name));
}

/** baseName returns a model ID without a composite group prefix, lowercased. */
function baseName(id) {
  return String(id).slice(String(id).lastIndexOf("/") + 1).toLowerCase();
}

/** isImageModel reports whether a catalogue entry draws on the images API. */
export function isImageModel(model) {
  return IMAGES_API.test(baseName(model.id));
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
  return !NON_CHAT.test(baseName(model.id));
}

/** familyLabel summarizes the families present in a catalogue, e.g. "GPT" or
 * "Claude/GPT". It names the account so a customer holding several Keys (one
 * per group) can tell them apart. Unknown families contribute nothing; image
 * models add "生图" last, so an image-only Key reads "生图".
 */
export function familyLabel(models) {
  const labels = [];
  let images = false;
  for (const model of models) {
    if (isImageModel(model)) images = true;
    if (!isChatModel(model)) continue;
    const label = familyOf(model.id)?.label;
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (images) labels.push("生图");
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

/** imageModel converts one images-API catalogue entry to a Magpie model that
 * gives images alone. Magpie lists such a model in its image generation picker
 * only on the OpenAI-compatible package, and sends it to {api.url}/images/*
 * through the plugin's fetch.
 */
function imageModel(model, base) {
  return {
    id: model.id,
    providerID: PROVIDER,
    name: model.display_name || model.id,
    api: { id: model.id, url: base + "/v1", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      reasoning: false,
      toolcall: false,
      attachment: false,
      input: TEXT_IMAGE,
      output: { text: false, image: true, audio: false, video: false, pdf: false },
    },
    limit: {},
    variants: Object.create(null),
    status: "active",
    headers: {},
    options: {},
  };
}

/** runtimeModel converts one catalogue entry to a Magpie model, or undefined
 * when the entry can serve neither text conversations nor image generation.
 * Server attributes take precedence over family defaults; numeric limits are
 * never invented.
 */
export function runtimeModel(model, base, overrides) {
  if (isImageModel(model)) return imageModel(model, base);
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
