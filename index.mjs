import { createHash } from "node:crypto";
import {
  PROVIDER,
  accountName,
  familyLabel,
  runtimeModel,
  validateModelProtocols,
} from "./models.mjs";
import { createQueries } from "./queries.mjs";
import { SITE, currencyOf, usageOf } from "./usage.mjs";

// index.mjs connects Magpie to 执算者AI (https://zszapi.com). A customer pastes
// one API Key; the plugin discovers that Key's chat models, routes each model
// family to the protocol the gateway serves natively, and shows the wallet
// balance in yuan. One Key belongs to one group on the site (GPT, Claude,
// DeepSeek…), so customers add one Magpie account per Key and Magpie fails
// over between them. The site owns group selection, pricing and billing.
//
// Magpie selects the account before invoking the loader. Each loader captures
// that account's Key, replaces caller authentication and returns the upstream
// response without reading its stream. Gemini paths are rewritten to /v1beta.

/** ZszapiPlugin supplies per-Key models, generation and usage to Magpie.
 *
 * Options (magpie plugin options magpie-zszapi '<json>'):
 * - currency: "CNY" (default, ¥1 = 1 site unit) or "USD" (backend unit).
 * - modelProtocols: { "<model id>": "<protocol>" } exact protocol overrides.
 * - baseURL: alternative site address, for staging or self-hosted mirrors.
 * - name: provider display name.
 */
export async function ZszapiPlugin({ client } = {}, options = {}) {
  options ??= {};
  const configuredBase = normalizeBase(options.baseURL || SITE);
  const currency = currencyOf(options.currency);
  const modelProtocols = validateModelProtocols(options.modelProtocols);
  const queries = createQueries();
  return {
    /** config declares the provider before any account exists. Existing user
     * configuration takes precedence, including its display name and models.
     */
    config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {
        name: options.name || "执算者AI",
        npm: "@ai-sdk/openai-compatible",
        api: configuredBase + "/v1",
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "执算者AI API Key",
          placeholder: "sk-…（在 zszapi.com「API 密钥」页复制）",
          /** authorize records the site address next to the Key Magpie saves. */
          async authorize() {
            return { type: "success", metadata: { baseURL: configuredBase } };
          },
        },
      ],
      /** loader binds generation to the current account's address and Key.
       * The placeholder API key is replaced inside fetch.
       */
      async loader(getAuth) {
        const account = accountOf(await getAuth(), configuredBase);
        await nameAccount(client, account, queries);
        return {
          baseURL: account.base + "/v1",
          apiKey: "zszapi-plugin",
          fetch: (input, init) => forward(account, input, init, queries),
        };
      },
      /** usage returns the balance card or a user-visible query failure.
       * Query failures keep the sign-in unless the site returned 401.
       */
      async usage(getAuth, provider) {
        try {
          const account = accountOf(await getAuth(), configuredBase);
          const body = await queries.get(account, "/v1/usage");
          const result = usageOf(body, { currency });
          if (
            !result.error &&
            provider?.models &&
            !provider.fellBack &&
            Object.keys(provider.models).length === 0
          ) {
            result.error =
              "此密钥所属分组没有可用的对话模型（生图分组不能用于对话）。请到 zszapi.com「API 密钥」页更换分组，再在 Magpie 点「重新获取模型」。";
          }
          return result;
        } catch (error) {
          return {
            error: error.message,
            windows: [],
            signIn: error.signIn || "kept",
          };
        }
      },
    },
    provider: {
      id: PROVIDER,
      /** models discovers the current Key's chat models. Query failures
       * propagate so Magpie keeps its previous list; an empty successful list
       * replaces it, including revoked permissions.
       */
      async models(_provider, { auth } = {}) {
        const account = accountOf(auth, configuredBase);
        const body = await queries.get(account, "/v1/models");
        await nameAccount(client, account, queries, body);
        const models = Object.create(null);
        for (const model of body.data) {
          const entry = runtimeModel(model, account.base, modelProtocols);
          if (entry) models[model.id] = entry;
        }
        return models;
      },
    },
  };
}

/** normalizeBase validates an address and removes a trailing API version.
 * Embedded credentials, queries, fragments and non-HTTP schemes are rejected
 * without echoing the input, which may contain a pasted secret.
 */
function normalizeBase(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("请输入完整站点地址，例如 https://zszapi.com。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("站点地址仅支持 HTTP(S)，不能包含账号、查询参数或片段。");
  }
  return url.href.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/, "");
}

/** accountOf resolves one saved Key and its private identity. Saved addresses
 * take precedence over the configured default so existing accounts keep
 * working if the option changes.
 */
function accountOf(auth, configuredBase) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) {
    throw Object.assign(new Error("请先添加执算者AI API Key。"), {
      signIn: "expired",
    });
  }
  const base = normalizeBase(auth.metadata?.baseURL || configuredBase);
  const key = auth.key.trim();
  const identity = createHash("sha256").update(base + "\0" + key).digest("hex");
  return { auth, base, key, identity };
}

/** nameAccount gives a new account a readable, stable label once. Existing
 * labels are kept because Magpie ties model selections to them. The catalogue
 * is used when available; failures to read it only drop the family part.
 */
async function nameAccount(client, account, queries, catalogue) {
  if (account.auth.accountId || !client?.auth?.set) return;
  let body = catalogue;
  if (!body) {
    try {
      body = await queries.get(account, "/v1/models");
    } catch {
      body = undefined;
    }
  }
  const families = body ? familyLabel(body.data) : "";
  const accountId = accountName(account.key, families);
  await client.auth.set({
    path: { id: PROVIDER },
    body: { ...account.auth, accountId, uid: account.auth.uid || account.identity },
  });
  account.auth = { ...account.auth, accountId };
}

/** forward sends one generation request with the selected account's Key.
 * Requests must target that account's text endpoints; caller authentication
 * is replaced, Gemini's version prefix is corrected, redirects fail, and the
 * returned Response keeps its stream and cancellation. A 401 clears cached
 * metadata for the account.
 */
async function forward(account, input, init, queries) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const base = new URL(account.base);
  const prefix = base.pathname.replace(/\/$/, "") + "/v1/";
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("模型请求地址与当前执算者AI账号不一致。");
  }
  const operation = url.pathname.slice(prefix.length);
  const gemini =
    /^models\/.+:(?:streamGenerateContent|generateContent|countTokens)$/.test(operation);
  if (
    !gemini &&
    !["messages", "messages/count_tokens", "responses", "chat/completions"].includes(operation)
  ) {
    throw new Error("执算者AI 插件不支持此请求接口。");
  }
  if (gemini) url.pathname = prefix.replace(/v1\/$/, "v1beta/") + operation;
  url.searchParams.delete("key");
  const headers = new Headers(request.headers);
  for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name);
  headers.set("Authorization", `Bearer ${account.key}`);
  if (operation.startsWith("messages")) {
    headers.set("x-api-key", account.key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  }
  if (gemini) headers.set("x-goog-api-key", account.key);
  const response = await fetch(new Request(url, request), { headers, redirect: "error" });
  if (response.status === 401) queries.clear(account);
  return response;
}
