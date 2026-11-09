import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import * as entry from "../index.mjs";
import { ZszapiPlugin } from "../index.mjs";

// plugin.test.mjs exercises the exported Magpie hooks against a local HTTP
// gateway shaped like zszapi.com. Requests cross the real fetch boundary so
// protocol URLs, Key isolation, streaming and cancellation are checked together.

// CATALOGUES mirrors the per-group model lists the site returns for one Key.
const CATALOGUES = {
  "Bearer sk-gpt-group-8bfa": [
    { id: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", owned_by: "openai" },
    { id: "gpt-6-astra", display_name: "GPT-6 Astra", owned_by: "openai" },
    { id: "codex-mini-latest", owned_by: "openai" },
  ],
  "Bearer sk-claude-group-c1c1": [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
  ],
  "Bearer sk-deepseek-be7c": [
    { id: "deepseek-v4-pro" },
    { id: "deepseek-v4-flash" },
  ],
  "Bearer sk-image-only-d5f7": [
    { id: "gpt-image-2.5" },
    { id: "gpt-image-2.5-sunburst" },
  ],
  "Bearer sk-multi-group-3b78": [
    { id: "claude-opus-5-5" },
    { id: "deepseek-v4.1-flash" },
    { id: "gpt-6.1-sol", display_name: "GPT-6.1 Sol" },
    { id: "gpt-image-2", display_name: "GPT Image 2" },
    { id: "gpt-image-2.6" },
  ],
  "Bearer sk-mixed-0000": [
    { id: "gemini-3.8-flash" },
    { id: "grok-4.6" },
    { id: "kimi-k3" },
    { id: "sora-2" },
    { id: "text-embedding-3-large" },
    { id: "claude-explicit", protocols: ["openai_chat_completions"] },
    { id: "gpt-disabled", protocols: [] },
  ],
};

/** gateway starts a local fixture and registers cleanup with the test. */
async function gateway(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: request.url, headers: request.headers, body });
    const auth = request.headers.authorization;
    if (auth === "Bearer sk-invalid-0000") {
      response.writeHead(401);
      response.end("sk-invalid-0000 must never appear in plugin errors");
      return;
    }
    if (auth === "Bearer sk-redirect-0000") {
      response.writeHead(302, { Location: "/redirected" });
      response.end();
      return;
    }
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: (CATALOGUES[auth] || []).map((model) => ({
            object: "model",
            type: "model",
            created: 1790640000,
            ...model,
          })),
        }),
      );
      return;
    }
    if (request.url === "/v1/usage") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          mode: "unrestricted",
          isValid: true,
          planName: "钱包余额",
          remaining: 88.5,
          unit: "USD",
          balance: 88.5,
          usage: { today: { requests: 3 } },
        }),
      );
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.write("data: " + body + "\n\n");
    if (request.url.endsWith("?slow=1")) return;
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = (key) => ({ type: "api", key, metadata: { baseURL: base } });
  return { base, requests, auth };
}

// Magpie calls every exported function of the entry module as a plugin.
test("the entry module exports exactly one plugin function", () => {
  const functions = Object.entries(entry).filter(([, value]) => typeof value === "function");
  assert.deepEqual(functions.map(([name]) => name), ["ZszapiPlugin"]);
});

test("sign-in asks only for the API Key and fixes the site to zszapi.com", async () => {
  const hooks = await ZszapiPlugin();
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  assert.equal(method.prompts, undefined);
  assert.match(method.label, /执算者AI/);
  assert.deepEqual(await method.authorize(), {
    type: "success",
    metadata: { baseURL: "https://zszapi.com" },
  });
  assert.equal(hooks.auth.provider, "zszapi");
  assert.equal(hooks.provider.id, "zszapi");
  const config = {};
  hooks.config(config);
  assert.equal(config.provider.zszapi.name, "执算者AI");
  assert.equal(config.provider.zszapi.api, "https://zszapi.com/v1");
  const kept = { provider: { zszapi: { name: "我的中转" } } };
  hooks.config(kept);
  assert.equal(kept.provider.zszapi.name, "我的中转");
});

test("options validate the site address, currency and protocol overrides", async () => {
  const hooks = await ZszapiPlugin({}, { baseURL: "http://localhost:8080/v1/" });
  assert.deepEqual((await hooks.auth.methods[0].authorize()).metadata, {
    baseURL: "http://localhost:8080",
  });
  for (const baseURL of [
    "bad-secret",
    "file:///secret",
    "https://user:secret@example.com",
    "https://example.com?key=secret",
  ]) {
    await assert.rejects(ZszapiPlugin({}, { baseURL }), (error) => {
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  await assert.rejects(ZszapiPlugin({}, { currency: "EUR" }), /currency/);
  await assert.rejects(ZszapiPlugin({}, { modelProtocols: { a: "typo" } }), /modelProtocols/);
  await ZszapiPlugin({}, null);
});

test("each family uses the protocol the gateway serves natively", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const gpt = await hooks.provider.models({}, { auth: fixture.auth("sk-gpt-group-8bfa") });
  assert.deepEqual(Object.keys(gpt), ["gpt-6.1-sol", "gpt-6-astra", "codex-mini-latest"]);
  assert.equal(gpt["gpt-6.1-sol"].api.npm, "@ai-sdk/openai");
  assert.equal(gpt["gpt-6.1-sol"].api.url, fixture.base + "/v1");
  assert.equal(gpt["gpt-6.1-sol"].name, "GPT-6.1 Sol");
  assert.equal(gpt["gpt-6.1-sol"].providerID, "zszapi");
  assert.equal(gpt["gpt-6.1-sol"].capabilities.toolcall, true);
  assert.deepEqual(gpt["gpt-6.1-sol"].limit, {});
  assert.equal(gpt["gpt-6.1-sol"].cost, undefined);

  const claude = await hooks.provider.models({}, { auth: fixture.auth("sk-claude-group-c1c1") });
  assert.equal(claude["claude-opus-5-5"].api.npm, "@ai-sdk/anthropic");

  const deepseek = await hooks.provider.models({}, { auth: fixture.auth("sk-deepseek-be7c") });
  assert.equal(deepseek["deepseek-v4-pro"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(deepseek["deepseek-v4-pro"].capabilities.input.image, false);

  const mixed = await hooks.provider.models({}, { auth: fixture.auth("sk-mixed-0000") });
  assert.deepEqual(Object.keys(mixed), [
    "gemini-3.8-flash",
    "grok-4.6",
    "kimi-k3",
    "claude-explicit",
  ]);
  assert.equal(mixed["gemini-3.8-flash"].api.npm, "@ai-sdk/google");
  assert.equal(mixed["gemini-3.8-flash"].api.url, fixture.base + "/v1beta");
  assert.equal(mixed["kimi-k3"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(mixed["claude-explicit"].api.npm, "@ai-sdk/openai-compatible");
});

test("protocol overrides apply to models without server protocols", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin({}, {
    modelProtocols: { "kimi-k3": "anthropic_messages", "gpt-disabled": "openai_responses" },
  });
  const models = await hooks.provider.models({}, { auth: fixture.auth("sk-mixed-0000") });
  assert.equal(models["kimi-k3"].api.npm, "@ai-sdk/anthropic");
  assert.ok(!Object.hasOwn(models, "gpt-disabled"));
});

test("images-API models are listed as image-only models on the OpenAI-compatible package", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin({}, {
    modelProtocols: { "gpt-image-2.5": "anthropic_messages" },
  });
  const auth = fixture.auth("sk-image-only-d5f7");
  const models = await hooks.provider.models({}, { auth });
  assert.deepEqual(Object.keys(models), ["gpt-image-2.5", "gpt-image-2.5-sunburst"]);
  const image = models["gpt-image-2.5"];
  // Magpie's image generation picker requires the OpenAI-compatible package
  // and draws at {api.url}/images/*; protocol overrides never apply.
  assert.equal(image.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(image.api.url, fixture.base + "/v1");
  assert.equal(image.providerID, "zszapi");
  assert.equal(image.capabilities.output.image, true);
  assert.equal(image.capabilities.output.text, false);
  assert.equal(image.capabilities.input.image, true);
  assert.equal(image.capabilities.toolcall, false);
  const usage = await hooks.auth.usage(async () => auth, { models });
  assert.equal(usage.plan, "余额 ¥88.50");
  assert.equal(usage.error, undefined);
});

test("multi-group Keys list chat and image models together", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const models = await hooks.provider.models({}, { auth: fixture.auth("sk-multi-group-3b78") });
  assert.deepEqual(Object.keys(models), [
    "claude-opus-5-5",
    "deepseek-v4.1-flash",
    "gpt-6.1-sol",
    "gpt-image-2",
    "gpt-image-2.6",
  ]);
  assert.equal(models["gpt-6.1-sol"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-6.1-sol"].capabilities.output, undefined);
  assert.equal(models["gpt-image-2"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["gpt-image-2"].name, "GPT Image 2");
  assert.equal(models["gpt-image-2.6"].capabilities.output.image, true);
});

test("Keys without usable models get an explanatory usage card", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const auth = fixture.auth("sk-empty-0000");
  const models = await hooks.provider.models({}, { auth });
  assert.deepEqual(Object.keys(models), []);
  const usage = await hooks.auth.usage(async () => auth, { models });
  assert.equal(usage.plan, "余额 ¥88.50");
  assert.match(usage.error, /更换分组/);
  const fine = await hooks.auth.usage(async () => auth, { models: { a: {} } });
  assert.equal(fine.error, undefined);
  const fellBack = await hooks.auth.usage(async () => auth, { models: {}, fellBack: true });
  assert.equal(fellBack.error, undefined);
});

test("new accounts are named by site, model family and Key suffix", async (t) => {
  const fixture = await gateway(t);
  const saved = [];
  const hooks = await ZszapiPlugin({
    client: { auth: { set: async (value) => saved.push(value) } },
  });
  await hooks.auth.loader(async () => ({
    ...fixture.auth("sk-gpt-group-8bfa"),
    metadata: { baseURL: fixture.base, custom: "kept" },
  }));
  await hooks.provider.models({}, { auth: fixture.auth("sk-claude-group-c1c1") });
  await hooks.auth.loader(async () => fixture.auth("sk-mixed-0000"));
  await hooks.auth.loader(async () => fixture.auth("sk-image-only-d5f7"));
  await hooks.auth.loader(async () => fixture.auth("sk-multi-group-3b78"));
  await hooks.auth.loader(async () => fixture.auth("abcd"));
  assert.deepEqual(
    saved.map((entry) => entry.body.accountId),
    [
      "执算者AI · GPT · 尾号 8bfa",
      "执算者AI · Claude · 尾号 c1c1",
      "执算者AI · Gemini/Grok/Claude · 尾号 0000",
      "执算者AI · 生图 · 尾号 d5f7",
      "执算者AI · Claude/DeepSeek/GPT/生图 · 尾号 3b78",
      "执算者AI · API Key",
    ],
  );
  assert.equal(saved[0].path.id, "zszapi");
  assert.equal(saved[0].body.metadata.custom, "kept");
  assert.equal(saved[0].body.key, "sk-gpt-group-8bfa");
  assert.match(saved[0].body.uid, /^[0-9a-f]{64}$/);
  assert.notEqual(saved[0].body.uid, saved[1].body.uid);

  const before = saved.length;
  await hooks.auth.loader(async () => ({
    ...fixture.auth("sk-gpt-group-8bfa"),
    accountId: "客户自定义名称",
  }));
  assert.equal(saved.length, before);
});

test("generation isolates Keys and forwards all four text protocols", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const loaders = await Promise.all(
    ["sk-gpt-group-8bfa", "sk-claude-group-c1c1"].map((key) =>
      hooks.auth.loader(async () => fixture.auth(key)),
    ),
  );
  assert.equal(loaders[0].baseURL, fixture.base + "/v1");
  for (const [index, operation] of [
    "messages",
    "responses",
    "chat/completions",
    "models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=caller",
  ].entries()) {
    const loader = loaders[index % 2];
    const body = JSON.stringify({ model: "m", stream: true, messages: [] });
    const response = await loader.fetch(loader.baseURL + "/" + operation, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
        "x-api-key": "caller",
        "x-goog-api-key": "caller",
        "Content-Type": "application/json",
        "session-id": "kept",
      },
      body,
    });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.ok((await response.text()).includes("data: " + body));
    const observed = fixture.requests.at(-1);
    assert.equal(observed.body, body);
    assert.equal(
      observed.headers.authorization,
      index % 2 ? "Bearer sk-claude-group-c1c1" : "Bearer sk-gpt-group-8bfa",
    );
    assert.equal(observed.headers["session-id"], "kept");
    if (index === 0) {
      assert.equal(observed.headers["x-api-key"], "sk-gpt-group-8bfa");
      assert.equal(observed.headers["anthropic-version"], "2023-06-01");
    }
    if (index === 3) {
      assert.equal(observed.url, "/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
      assert.equal(observed.headers["x-goog-api-key"], "sk-claude-group-c1c1");
    }
  }
  await assert.rejects(loaders[0].fetch("https://example.com/v1/messages"), /不一致/);
  await assert.rejects(loaders[0].fetch(fixture.base + "/v1/images/variations"), /不支持/);
  await assert.rejects(loaders[0].fetch(fixture.base + "/v1/embeddings"), /不支持/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loaders[0].fetch(loaders[0].baseURL + "/responses", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

test("image generation and edits are forwarded with the account's Key", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const loader = await hooks.auth.loader(async () => fixture.auth("sk-image-only-d5f7"));
  const body = JSON.stringify({ model: "gpt-image-2", prompt: "a magpie", n: 1 });
  await loader.fetch(loader.baseURL + "/images/generations", {
    method: "POST",
    headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
    body,
  });
  let observed = fixture.requests.at(-1);
  assert.equal(observed.url, "/v1/images/generations");
  assert.equal(observed.body, body);
  assert.equal(observed.headers.authorization, "Bearer sk-image-only-d5f7");
  assert.equal(observed.headers["x-api-key"], undefined);

  // Magpie sends an edit as multipart form data; the boundary must survive.
  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", "make it blue");
  form.set("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "image0.png");
  await loader.fetch(loader.baseURL + "/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer caller" },
    body: form,
  });
  observed = fixture.requests.at(-1);
  assert.equal(observed.url, "/v1/images/edits");
  assert.equal(observed.headers.authorization, "Bearer sk-image-only-d5f7");
  const boundary = observed.headers["content-type"].match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
  assert.ok(boundary);
  assert.ok(observed.body.includes("--" + boundary));
  assert.ok(observed.body.includes('name="prompt"\r\n\r\nmake it blue'));
  assert.ok(observed.body.includes('filename="image0.png"'));
});

test("streaming returns the first chunk immediately and stays cancellable", { timeout: 3000 }, async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const loader = await hooks.auth.loader(async () => fixture.auth("sk-gpt-group-8bfa"));
  const controller = new AbortController();
  const response = await loader.fetch(loader.baseURL + "/responses?slow=1", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  controller.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
});

test("invalid Keys request a new sign-in without echoing secrets", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const auth = fixture.auth("sk-invalid-0000");
  const usage = await hooks.auth.usage(async () => auth);
  assert.equal(usage.signIn, "expired");
  assert.match(usage.error, /API 密钥/);
  assert.ok(!usage.error.includes("sk-invalid"));
  await assert.rejects(hooks.provider.models({}, { auth }), { signIn: "expired" });
  await assert.rejects(
    hooks.provider.models({}, { auth: { type: "api", key: " " } }),
    { signIn: "expired" },
  );
});

test("discovery before any sign-in keeps the current list quietly", async () => {
  const hooks = await ZszapiPlugin();
  const empty = await hooks.provider.models({}, {});
  assert.deepEqual(Object.keys(empty), []);
  assert.equal(empty[Symbol.for("magpie.fellBack")], true);
  const kept = await hooks.provider.models({ models: { a: { id: "a" } } });
  assert.deepEqual(Object.keys(kept), ["a"]);
});

test("authenticated queries and generation refuse redirects", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  const auth = fixture.auth("sk-redirect-0000");
  const usage = await hooks.auth.usage(async () => auth);
  assert.equal(usage.signIn, "kept");
  assert.match(usage.error, /无法连接/);
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(
    loader.fetch(loader.baseURL + "/responses", { method: "POST", body: "{}" }),
  );
  assert.ok(fixture.requests.every((request) => request.url !== "/redirected"));
});

test("a 401 during generation clears cached models", async (t) => {
  let modelQueries = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/v1/models")) {
      modelQueries++;
      return Response.json({ data: [] });
    }
    return new Response("unauthorized", { status: 401 });
  });
  const hooks = await ZszapiPlugin();
  const auth = { type: "api", key: "sk-fixture-1234", metadata: { baseURL: "https://zszapi.com" } };
  await hooks.provider.models({}, { auth });
  await hooks.provider.models({}, { auth });
  assert.equal(modelQueries, 1);
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch(loader.baseURL + "/responses", { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  await hooks.provider.models({}, { auth });
  assert.equal(modelQueries, 2);
});

test("metadata queries identify the plugin", async (t) => {
  const fixture = await gateway(t);
  const hooks = await ZszapiPlugin();
  await hooks.provider.models({}, { auth: fixture.auth("sk-gpt-group-8bfa") });
  assert.match(fixture.requests.at(-1).headers["user-agent"], /^magpie-zszapi\//);
});
