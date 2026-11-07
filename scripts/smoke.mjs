// smoke.mjs checks a real 执算者AI Key without spending balance: it reads the
// Key's model catalogue and usage through the plugin hooks and prints what
// Magpie would show. Usage: ZSZAPI_KEY=sk-… npm run smoke
// Optional: ZSZAPI_BASE=https://zszapi.com ZSZAPI_CURRENCY=USD
import { ZszapiPlugin } from "../index.mjs";

const key = process.env.ZSZAPI_KEY;
if (!key) {
  console.error("请设置 ZSZAPI_KEY 环境变量。");
  process.exit(2);
}
const options = {};
if (process.env.ZSZAPI_BASE) options.baseURL = process.env.ZSZAPI_BASE;
if (process.env.ZSZAPI_CURRENCY) options.currency = process.env.ZSZAPI_CURRENCY;
const saved = [];
const hooks = await ZszapiPlugin(
  { client: { auth: { set: async (value) => saved.push(value) } } },
  options,
);
const { metadata } = await hooks.auth.methods[0].authorize();
const auth = { type: "api", key, metadata };
const models = await hooks.provider.models({}, { auth });
await hooks.auth.loader(async () => auth);
const usage = await hooks.auth.usage(async () => auth, { models });
console.log("账号名:", saved[0]?.body.accountId);
console.log("模型:");
for (const model of Object.values(models)) {
  console.log(`  ${model.id.padEnd(28)} ${model.api.npm.padEnd(26)} ${model.api.url}`);
}
console.log("用量:", JSON.stringify(usage, null, 2));
