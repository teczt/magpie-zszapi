import { createHash } from "node:crypto";
import {
  PROVIDER,
  accountName,
  familyLabel,
  runtimeModel,
  validateModelProtocols,
} from "./models.mjs";
import { createQueries } from "./queries.mjs";
import { KR_SITE, SITE, currencyOf, usageOf } from "./usage.mjs";

/** ROUTE_OPTION is the switch on the provider's editor that moves every
 * request to the Seoul relay. Magpie hands its current value to the plugin on
 * each read, so turning it on or off needs no sign-in and no restart. */
const ROUTE_OPTION = "route_kr";
/** OFFICIAL_SITES are the site's own addresses. An account saved with one of
 * them follows the route switch; any other saved address (staging, a
 * self-hosted mirror) is kept as it is. */
const OFFICIAL_SITES = [SITE, KR_SITE];

// index.mjs connects Magpie to 执算者AI (https://zszapi.com). A customer pastes
// one API Key; the plugin discovers that Key's chat and image models, routes
// each model family to the protocol the gateway serves natively, and shows the
// wallet balance in yuan. Image models (gpt-image) reach Magpie's image
// generation, which draws at /v1/images/* through the same fetch. A Key belongs
// to one group on the site (GPT, Claude, DeepSeek…) or several, so customers
// add one Magpie account per Key and Magpie fails over between them. The site owns group selection, pricing and billing.
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
 *
 * Route switch (the provider's editor, Plugin options): "route_kr" off sends
 * requests to baseURL (zszapi.com by default), on sends them to kr.zszapi.com.
 */
export async function ZszapiPlugin({ client, magpie } = {}, options = {}) {
  options ??= {};
  const configuredBase = normalizeBase(options.baseURL || SITE);
  const currency = currencyOf(options.currency);
  const modelProtocols = validateModelProtocols(options.modelProtocols);
  const queries = createQueries();
  /** routeKr reads the route switch as it is now. Hosts without plugin
   * options (OpenCode, older Magpie) never turn it on. */
  const routeKr = async () => {
    try {
      return (await magpie?.option?.(PROVIDER, ROUTE_OPTION)) === true;
    } catch {
      return false;
    }
  };
  /** current resolves an account against the route switch at call time. */
  const current = async (auth) => accountOf(auth, configuredBase, await routeKr());
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
      /** options declares the route switch, drawn under the accounts. */
      options: [
        {
          key: ROUTE_OPTION,
          label: "China-optimized route (kr.zszapi.com)",
          labels: { zh: "国内优化线路（kr.zszapi.com）" },
          description:
            "Off: connect to zszapi.com directly (default). On: use the China-optimized route kr.zszapi.com, often steadier from mainland China. Applies from the next request; no sign-in needed.",
          descriptions: {
            zh: "关闭：直连 zszapi.com（默认）。打开：走国内优化线路 kr.zszapi.com，国内部分网络（如移动）通常更稳。切换后下一个请求即生效，无需重新登录。",
          },
          placement: "top",
        },
      ],
      /** loader binds generation to the current account's Key. The address is
       * resolved again on every request, so the route switch applies to
       * sessions that are already open. The placeholder API key is replaced
       * inside fetch.
       */
      async loader(getAuth) {
        const account = await current(await getAuth());
        await nameAccount(client, account, queries);
        const loaded = account.base;
        return {
          baseURL: loaded + "/v1",
          apiKey: "zszapi-plugin",
          fetch: async (input, init) =>
            forward(await current(account.auth), [loaded, ...OFFICIAL_SITES], input, init, queries),
        };
      },
      /** usage returns the balance card or a user-visible query failure.
       * Query failures keep the sign-in unless the site returned 401.
       */
      async usage(getAuth, provider) {
        try {
          const account = await current(await getAuth());
          const body = await queries.get(account, "/v1/usage");
          const result = usageOf(body, { currency });
          if (
            !result.error &&
            provider?.models &&
            !provider.fellBack &&
            Object.keys(provider.models).length === 0
          ) {
            result.error =
              "此密钥所属分组没有 Magpie 可用的模型。请到 zszapi.com「API 密钥」页更换分组，再在 Magpie 点「重新获取模型」。";
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
      /** models discovers the current Key's chat and image models. Query failures
       * propagate so Magpie keeps its previous list; an empty successful list
       * replaces it, including revoked permissions.
       */
      async models(provider, { auth } = {}) {
        // Magpie also asks before any Key is added; keep its current list
        // quietly instead of logging a sign-in error for an unused provider.
        if (auth == null) {
          const kept = { ...(provider?.models || {}) };
          kept[Symbol.for("magpie.fellBack")] = true;
          return kept;
        }
        const account = await current(auth);
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

/** accountOf resolves one saved Key, the address it is sent to now, and its
 * private identity. An account saved with one of the site's own addresses
 * follows the route switch: on is the Seoul relay, off is the configured
 * baseURL. Any other saved address (staging, a self-hosted mirror) is kept,
 * so those accounts keep working whatever the switch says.
 */
function accountOf(auth, configuredBase, routeKr = false) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) {
    throw Object.assign(new Error("请先添加执算者AI API Key。"), {
      signIn: "expired",
    });
  }
  const saved = auth.metadata?.baseURL ? normalizeBase(auth.metadata.baseURL) : "";
  const base =
    saved && !OFFICIAL_SITES.includes(saved) ? saved : routeKr ? KR_SITE : configuredBase;
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

/** forward sends one generation request with the selected account's Key to
 * the account's current address. The caller may address any of `accepted`
 * (the address the session was loaded with, or one of the site's own), since
 * model lists and loaders opened before a route switch still carry the old
 * one; the request is moved to the current address, so the Key only ever goes
 * there. Only text and image endpoints are allowed; caller authentication is
 * replaced, Gemini's version prefix is corrected, redirects fail, and the
 * returned Response keeps its stream and cancellation. A 401 clears cached
 * metadata for the account.
 */
async function forward(account, accepted, input, init, queries) {
  const request = new Request(input, init);
  const source = new URL(request.url);
  const prefixOf = (base) => base.pathname.replace(/\/$/, "") + "/v1/";
  const from = accepted
    .map((address) => new URL(address))
    .find((base) => source.origin === base.origin && source.pathname.startsWith(prefixOf(base)));
  if (!from) {
    throw new Error("模型请求地址与当前执算者AI账号不一致。");
  }
  const operation = source.pathname.slice(prefixOf(from).length);
  const base = new URL(account.base);
  const prefix = prefixOf(base);
  const url = new URL(base.origin + prefix + operation);
  url.search = source.search;
  const gemini =
    /^models\/.+:(?:streamGenerateContent|generateContent|countTokens)$/.test(operation);
  if (
    !gemini &&
    ![
      "messages",
      "messages/count_tokens",
      "responses",
      "chat/completions",
      "images/generations",
      "images/edits",
    ].includes(operation)
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
