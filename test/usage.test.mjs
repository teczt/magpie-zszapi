import assert from "node:assert/strict";
import test from "node:test";
import { currencyOf, usageOf } from "../usage.mjs";

// usage.test.mjs checks the Magpie usage card built from /v1/usage. Fixtures
// use the response shapes of the 执算者AI (Sub2API) gateway.

// The live wallet response: ¥1 buys 1 unit, so the card shows yuan by default.
test("wallet balance is shown in yuan by default", () => {
  const usage = usageOf({
    mode: "unrestricted",
    isValid: true,
    planName: "钱包余额",
    remaining: 8586.7957554,
    unit: "USD",
    balance: 8586.7957554,
  });
  assert.equal(usage.plan, "余额 ¥8586.80");
  assert.equal(usage.balance, "¥8586.80");
  assert.equal(usage.error, undefined);
  assert.equal(usage.signIn, "kept");
  assert.deepEqual(usage.windows, []);
});

test("USD currency option keeps the backend unit", () => {
  const usage = usageOf(
    { mode: "unrestricted", balance: 12.34, unit: "USD" },
    { currency: "USD" },
  );
  assert.equal(usage.plan, "余额 $12.34");
  assert.equal(usage.balance, "$12.34");
});

test("currency option is validated", () => {
  assert.equal(currencyOf(undefined), "CNY");
  assert.equal(currencyOf("usd"), "USD");
  assert.throws(() => currencyOf("EUR"), /currency/);
});

test("an empty wallet asks the customer to top up without dropping the Key", () => {
  for (const body of [
    { mode: "unrestricted", balance: 0 },
    { mode: "unrestricted", balance: -0.5 },
  ]) {
    const usage = usageOf(body);
    assert.match(usage.error, /充值/);
    assert.match(usage.error, /zszapi\.com\/purchase/);
    assert.equal(usage.signIn, "kept");
  }
  assert.equal(usageOf({ mode: "unrestricted", balance: -0.5 }).balance, "-¥0.50");
});

test("small positive balances remain visible", () => {
  assert.equal(usageOf({ mode: "unrestricted", balance: 0.004 }).balance, "¥0.004");
  assert.equal(
    usageOf({ mode: "unrestricted", balance: 0.0000001 }).balance,
    "<¥0.000001",
  );
  assert.equal(usageOf({ mode: "unrestricted" }).plan, "余额未返回");
});

// Keys with their own quota and rolling limits report quota_limited.
test("Key quota and spending windows become separate windows", () => {
  const usage = usageOf(
    {
      mode: "quota_limited",
      isValid: true,
      status: "active",
      quota: { limit: 100, used: 25, remaining: 75, unit: "USD" },
      remaining: 75,
      unit: "USD",
      rate_limits: [
        { window: "5h", limit: 10, used: 2, reset_at: "2030-01-01T05:00:00Z" },
        { window: "1d", limit: 20, used: 30 },
        { window: "custom", limit: 5, used: 1 },
      ],
      expires_at: "2031-01-01T00:00:00Z",
    },
    { now: Date.parse("2030-01-01T00:00:00Z") },
  );
  assert.equal(usage.plan, "密钥额度");
  assert.equal(usage.balance, undefined);
  assert.deepEqual(
    usage.windows.map((window) => [window.name, window.used, window.display]),
    [
      ["密钥总额度", 25, "¥25.00 / ¥100.00"],
      ["密钥 5 小时限额", 20, "¥2.00 / ¥10.00"],
      ["密钥 24 小时限额", 150, "¥30.00 / ¥20.00"],
      ["custom", 20, "¥1.00 / ¥5.00"],
    ],
  );
  assert.equal(usage.windows[1].span, 5 * 3600);
  assert.equal(usage.windows[1].resetsAt, "2030-01-01T05:00:00Z");
  assert.equal(usage.windows[3].span, undefined);
  assert.equal(usage.until, "2031-01-01T00:00:00Z");
  assert.equal(usage.error, undefined);
});

test("subscription groups show plan windows and the earlier expiry", () => {
  const usage = usageOf(
    {
      mode: "unrestricted",
      isValid: true,
      planName: "【Claude】月卡",
      unit: "USD",
      remaining: 5,
      subscription: {
        daily_usage_usd: 5,
        weekly_usage_usd: 10,
        monthly_usage_usd: 20,
        daily_limit_usd: 10,
        weekly_limit_usd: 50,
        monthly_limit_usd: 0,
        expires_at: "2030-02-01T00:00:00Z",
      },
    },
    { now: Date.parse("2030-01-01T00:00:00Z") },
  );
  assert.equal(usage.plan, "【Claude】月卡");
  assert.equal(usage.balance, undefined);
  assert.deepEqual(
    usage.windows.map((window) => window.name),
    ["每日额度", "每周额度"],
  );
  assert.equal(usage.until, "2030-02-01T00:00:00Z");
  assert.equal(usage.error, undefined);
});

test("expired and exhausted Keys keep their sign-in with actionable errors", () => {
  const cases = [
    [{ mode: "quota_limited", status: "expired" }, /到期/],
    [
      { mode: "quota_limited", status: "quota_exhausted", quota: { used: 10, limit: 10 } },
      /总额度已用完/,
    ],
    [
      { mode: "unrestricted", planName: "月卡", subscription: { status: "expired" } },
      /订阅不可用/,
    ],
    [
      { mode: "unrestricted", expires_at: "2000-01-01T00:00:00Z", balance: 5 },
      /到期/,
    ],
  ];
  for (const [body, pattern] of cases) {
    const usage = usageOf(body);
    assert.match(usage.error, pattern);
    assert.equal(usage.signIn, "kept");
  }
  assert.throws(() => usageOf({}), /格式无效/);
});

test("unknown counters are never shown as zero", () => {
  const usage = usageOf({
    mode: "quota_limited",
    quota: { used: null, limit: 100 },
    rate_limits: [
      { window: "7d", used: false, limit: 100 },
      { window: "1d", used: "3", limit: 0 },
    ],
  });
  assert.deepEqual(usage.windows, []);
});
