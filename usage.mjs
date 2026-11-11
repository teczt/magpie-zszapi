// usage.mjs maps the 执算者AI /v1/usage response to Magpie's usage card.
//
// The site sells balance at ¥1 per 1 unit (the backend stores the amount in
// its "USD" unit), so the amount a customer sees in their wallet is exactly the
// yuan they paid. The card therefore shows "¥12.34" by default; the "USD"
// currency option restores the backend's own unit for operators.
//
// A Key's own quota and 5h/1d/7d spending limits become separate windows,
// subscription groups add daily/weekly/monthly windows, and wallet amounts stay
// balances rather than invented percentages. Only server-reported reset times
// are used. Exhausted funds and expired plans keep the sign-in so customers can
// top up or renew the existing Key; only HTTP 401 (handled by the caller)
// asks for a new Key.

export const SITE = "https://zszapi.com";
/** KR_SITE is the Seoul relay in front of the same site, chosen by the
 * "route_kr" plugin option. It serves the same accounts, Keys and APIs. */
export const KR_SITE = "https://kr.zszapi.com";
export const RECHARGE_URL = SITE + "/purchase";

const DAY_SECONDS = 86400;
const SPANS = {
  "5h": ["密钥 5 小时限额", 5 * 3600],
  "1d": ["密钥 24 小时限额", DAY_SECONDS],
  "7d": ["密钥 7 天限额", 7 * DAY_SECONDS],
};

/** currencyOf validates the display currency option. */
export function currencyOf(value) {
  if (value == null || value === "") return "CNY";
  const upper = String(value).toUpperCase();
  if (upper !== "CNY" && upper !== "USD") {
    throw new Error('currency 只支持 "CNY" 或 "USD"。');
  }
  return upper;
}

/** usageOf combines Key limits with the funding source of one Key.
 * Missing or malformed amounts are never shown as zero.
 */
export function usageOf(body, { currency = "CNY", now = Date.now() } = {}) {
  if (
    !body ||
    typeof body !== "object" ||
    !["unrestricted", "quota_limited"].includes(body.mode)
  ) {
    throw new Error("执算者AI 返回的额度信息格式无效。");
  }
  const fmt = formatter(currency);
  const billing = body.billing || {};
  const subscription = body.subscription;
  const subscriptionFunded =
    billing.source === "subscription" || (!billing.source && subscription);
  // quota_limited responses use remaining for the Key's own allowance, which
  // is not the account wallet.
  const legacyWallet =
    body.mode === "unrestricted" && !subscriptionFunded && !body.quota;
  const balance = numberOf(
    body.balance ?? billing.balance ?? (legacyWallet ? body.remaining : undefined),
  );
  const balanceText = balance === undefined ? undefined : fmt.money(balance);
  let plan;
  if (subscriptionFunded) {
    plan = billing.plan_name || body.planName || "订阅套餐";
  } else if (balanceText !== undefined) {
    plan = `余额 ${balanceText}`;
  } else {
    plan = body.mode === "quota_limited" ? "密钥额度" : "余额未返回";
  }
  const out = { plan, windows: [], signIn: "kept" };
  const quota = windowOf(fmt, "密钥总额度", body.quota?.used, body.quota?.limit);
  if (quota) out.windows.push(quota);
  for (const row of Array.isArray(body.rate_limits) ? body.rate_limits : []) {
    const [name, span] = (Object.hasOwn(SPANS, row.window)
      ? SPANS[row.window]
      : undefined) || [String(row.window || "密钥限额"), undefined];
    const window = windowOf(fmt, name, row.used, row.limit, span, row.reset_at);
    if (window) out.windows.push(window);
  }
  if (subscriptionFunded) {
    for (const [field, label, span] of [
      ["daily", "每日额度", DAY_SECONDS],
      ["weekly", "每周额度", 7 * DAY_SECONDS],
      ["monthly", "每月额度", 30 * DAY_SECONDS],
    ]) {
      const window = windowOf(
        fmt,
        label,
        subscription?.[field + "_usage_usd"],
        subscription?.[field + "_limit_usd"],
        span,
        subscription?.[field + "_reset_at"],
      );
      if (window) out.windows.push(window);
    }
    if (
      !subscription ||
      subscription.available === false ||
      (subscription.status && subscription.status !== "active")
    ) {
      out.error = "订阅不可用，请登录 zszapi.com 检查套餐状态。";
    }
  } else if (balanceText !== undefined) {
    out.balance = balanceText;
  }
  // Both expirations constrain the same Key; show the earlier one.
  const endings = [body.expires_at, subscription?.expires_at]
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  if (endings.length) out.until = endings[0];
  if (body.status === "expired" || (out.until && Date.parse(out.until) <= now)) {
    out.error = "密钥或订阅已到期，请登录 zszapi.com 续期。";
  } else if (body.status === "quota_exhausted") {
    out.error = "此密钥的总额度已用完，请登录 zszapi.com 调整密钥额度。";
  } else if (
    !out.error &&
    (billing.available === false || body.isValid === false) &&
    !out.windows.some((window) => window.used >= 100)
  ) {
    out.error = `当前扣费来源不可用，请到 ${RECHARGE_URL} 检查余额或订阅。`;
  } else if (!out.error && !subscriptionFunded && balance !== undefined && balance <= 0) {
    out.error = `余额已用完，请到 ${RECHARGE_URL} 充值。`;
  }
  return out;
}

/** formatter returns money helpers for the chosen display currency. */
function formatter(currency) {
  const symbol = currency === "USD" ? "$" : "¥";
  const money = (value) => {
    const sign = value < 0 ? "-" : "";
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.000001) return `${sign}<${symbol}0.000001`;
    const amount =
      abs > 0 && abs < 0.01 ? abs.toFixed(6).replace(/0+$/, "") : abs.toFixed(2);
    return `${sign}${symbol}${amount}`;
  };
  return { currency, symbol, money };
}

/** numberOf accepts finite numbers and nonempty numeric strings only. */
function numberOf(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** windowOf formats a measured allowance, or omits unknown/unlimited windows. */
function windowOf(fmt, name, used, limit, span, resetsAt) {
  const amount = numberOf(used);
  const maximum = numberOf(limit);
  if (amount === undefined || amount < 0 || maximum === undefined || maximum <= 0)
    return undefined;
  const result = {
    name,
    used: (amount / maximum) * 100,
    amount,
    limit: maximum,
    unit: fmt.currency,
    display: `${fmt.money(amount)} / ${fmt.money(maximum)}`,
  };
  if (span) result.span = span;
  if (typeof resetsAt === "string" && Number.isFinite(Date.parse(resetsAt)))
    result.resetsAt = resetsAt;
  return result;
}
