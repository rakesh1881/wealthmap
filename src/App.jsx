// ============================================================
// WEALTHMAP v15 — Net Worth Double-Count Fix
// Changes vs v14:
//  1.  calcNetWorth now receives accountCategories as 8th parameter
//  2.  Investment accounts correctly excluded from base balance sum
//      (was checking acc.isInvestmentType which is a property of *categories*, not accounts)
//  3.  Holdings value counted once only — no more double-count
// Changes vs v11:
//  1.  FD Close: Undo support (FD marked closed, not deleted)
//  2.  Profits tab: summary per stock only (no individual trade rows)
//  3.  Remove market price API / manual price input / stocks master enforcement
//  4.  Stock name autocomplete from existing trade history
//  5.  Trade account sync: BUY credits investment acct, SELL debits it
//  6.  Account balance verification for all trade/FD actions
// ============================================================

import { useState, useEffect, useReducer, useRef, useMemo, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://hqkqhgrfcwixqoehjfaj.supabase.co";
const SUPABASE_KEY = "sb_publishable_N-ZcUkVL6fF-pch1sZPg6Q_hbd8sUPv";
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY  = "wealthmap_v15";

// ─── CURRENCIES ───────────────────────────────────────────────────────────────
const CURRENCIES = [
  { code:"INR", symbol:"₹",   name:"Indian Rupee"      },
  { code:"USD", symbol:"$",   name:"US Dollar"         },
  { code:"EUR", symbol:"€",   name:"Euro"              },
  { code:"GBP", symbol:"£",   name:"British Pound"     },
  { code:"JPY", symbol:"¥",   name:"Japanese Yen"      },
  { code:"SGD", symbol:"S$",  name:"Singapore Dollar"  },
  { code:"AED", symbol:"د.إ", name:"UAE Dirham"        },
  { code:"HKD", symbol:"HK$", name:"Hong Kong Dollar"  },
  { code:"CHF", symbol:"Fr",  name:"Swiss Franc"       },
  { code:"AUD", symbol:"A$",  name:"Australian Dollar" },
];

// ─── TX TYPES (removed refund_expense / refund_income) ────────────────────────
const TX_TYPES = {
  expense:  { label:"Expense",  color:"#EF4444", icon:"↑", bg:"#FEF2F2" },
  income:   { label:"Income",   color:"#10B981", icon:"↓", bg:"#F0FDF4" },
  transfer: { label:"Transfer", color:"#6366F1", icon:"⇄", bg:"#EEF2FF" },
};

// ─── DEFAULT STATE ─────────────────────────────────────────────────────────────
const DEFAULT = {
  accounts: [],
  accountCategories: [
    { id:"cat_bank",   name:"Bank",         icon:"🏦", color:"#3B82F6", isCreditCardType:false },
    { id:"cat_cash",   name:"Cash",         icon:"💵", color:"#10B981", isCreditCardType:false },
    { id:"cat_cc",     name:"Credit Card",  icon:"💳", color:"#EF4444", isCreditCardType:true  },
    { id:"cat_wallet", name:"Wallet / UPI", icon:"📱", color:"#F59E0B", isCreditCardType:false },
    { id:"cat_broker", name:"Stock Broker", icon:"📈", color:"#8B5CF6", isCreditCardType:false },
    { id:"cat_mf",     name:"Mutual Funds", icon:"📊", color:"#06B6D4", isCreditCardType:false },
    { id:"cat_invest",  name:"Investment",   icon:"📈", color:"#6366F1", isCreditCardType:false, isInvestmentType:true },
    { id:"cat_other",   name:"Other",        icon:"🏷️", color:"#6B7280", isCreditCardType:false },
  ],
  expenseCategories: [
    { id:"ec_food",  name:"Food & Dining",    icon:"🍽️" },
    { id:"ec_tpt",   name:"Transport",        icon:"🚗" },
    { id:"ec_shop",  name:"Shopping",         icon:"🛍️" },
    { id:"ec_bills", name:"Bills & Utilities",icon:"⚡" },
    { id:"ec_hlth",  name:"Health",           icon:"🏥" },
    { id:"ec_ent",   name:"Entertainment",    icon:"🎬" },
    { id:"ec_edu",   name:"Education",        icon:"📚" },
    { id:"ec_lend",  name:"Lend / Borrow",    icon:"🤝" },
    { id:"ec_other", name:"Other",            icon:"🏷️" },
  ],
  incomeCategories: [
    { id:"ic_sal",  name:"Salary",         icon:"💼" },
    { id:"ic_free", name:"Freelance",      icon:"💻" },
    { id:"ic_biz",  name:"Business",       icon:"🏢" },
    { id:"ic_int",  name:"Interest",       icon:"🏦" },
    { id:"ic_div",  name:"Dividends",      icon:"📊" },
    { id:"ic_rent", name:"Rental",         icon:"🏠" },
    { id:"ic_ref",  name:"Refund Received",icon:"↩️" },
    { id:"ic_other",name:"Other",          icon:"🏷️" },
  ],
  transactions:        [],
  holdings:            [],
  investmentTx:        [],
  fixedDeposits:       [],
  // ── NEW in v9: Stocks Master Table ──────────────────────────────────────────
  // stocks: [{ id, symbol, name, type:"stock"|"mf", exchange }]
  // Trades must reference a stock from this table (by symbol).
  stocks:              [],
  // ── NEW in v7 ──────────────────────────────────────────────────────────────
  // marketPrices: { [symbol]: { current_price, last_updated } }
  // Used for current value of holdings; separate from trade prices.
  marketPrices:        {},
  // corporateActions: array of { id, symbol, action_type, ratio, date, note }
  // Supported: stock_split, bonus, reverse_split, dividend, stock_name_change
  corporateActions:    [],
  // tradeBalanceEffects: synthetic ledger entries for buy/sell balance changes
  // { id, accountId, amount, sign: 1|-1, tradeId, date }
  tradeBalanceEffects: [],
  fxRates: { USD:83.5, EUR:91.2, GBP:106.5, JPY:0.56, SGD:62.1, AED:22.7, HKD:10.7, CHF:94.3, AUD:54.8 },
};

// ─── SANITIZE ─────────────────────────────────────────────────────────────────
// Also normalizes legacy account fields for backward compatibility:
//   disabled → is_active (inverted), includeInNetWorth → include_in_networth
function sanitizeAccount(a) {
  if (!a || typeof a !== "object") return a;
  const out = { ...a };
  // Normalize is_active from legacy `disabled` field
  if (out.is_active === undefined) {
    out.is_active = out.disabled === true ? false : true;
  }
  // Keep disabled in sync for backward compat
  out.disabled = !out.is_active;
  // Normalize include_in_networth
  if (out.include_in_networth === undefined) {
    out.include_in_networth = out.includeInNetWorth !== undefined ? out.includeInNetWorth : true;
  }
  out.includeInNetWorth = out.include_in_networth; // keep both in sync
  // Normalize account_type from legacy categoryId
  if (out.account_type === undefined && out.categoryId !== undefined) {
    out.account_type = out.categoryId;
  }
  if (out.categoryId === undefined && out.account_type !== undefined) {
    out.categoryId = out.account_type;
  }
  return out;
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT };
  return {
    accounts:            Array.isArray(raw.accounts)            ? raw.accounts.map(sanitizeAccount) : [],
    accountCategories:   Array.isArray(raw.accountCategories)   ? raw.accountCategories
                       : Array.isArray(raw.categories)          ? raw.categories : DEFAULT.accountCategories,
    expenseCategories:   Array.isArray(raw.expenseCategories)   ? raw.expenseCategories  : DEFAULT.expenseCategories,
    incomeCategories:    Array.isArray(raw.incomeCategories)     ? raw.incomeCategories   : DEFAULT.incomeCategories,
    transactions:        Array.isArray(raw.transactions)         ? raw.transactions        : [],
    holdings:            Array.isArray(raw.holdings)             ? raw.holdings            : [],
    investmentTx:        Array.isArray(raw.investmentTx)         ? raw.investmentTx        : [],
    fxRates:           (raw.fxRates && typeof raw.fxRates === "object") ? raw.fxRates    : DEFAULT.fxRates,
    fixedDeposits:       Array.isArray(raw.fixedDeposits)        ? raw.fixedDeposits       : [],
    marketPrices:       (raw.marketPrices && typeof raw.marketPrices === "object") ? raw.marketPrices : {},
    corporateActions:    Array.isArray(raw.corporateActions)     ? raw.corporateActions    : [],
    tradeBalanceEffects: Array.isArray(raw.tradeBalanceEffects)  ? raw.tradeBalanceEffects : [],
    stocks:              Array.isArray(raw.stocks)               ? raw.stocks              : [],
  };
}

// ─── LOCAL STORAGE ────────────────────────────────────────────────────────────
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch(e) { console.warn("loadLocal:", e); }
  return sanitize({});
}
function saveLocal(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch(e) { console.warn("saveLocal:", e); }
}

// ─── CLOUD ────────────────────────────────────────────────────────────────────
async function pushCloud(userId, s) {
  const { error } = await supabase.from("user_data").upsert(
    { id: userId, data: s, updated_at: new Date().toISOString() },
    { onConflict: "id" }
  );
  if (error) throw error;
}
async function pullCloud(userId) {
  try {
    const { data, error } = await supabase.from("user_data")
      .select("data").eq("id", userId).maybeSingle();
    if (error || !data?.data) return null;
    return sanitize(data.data);
  } catch { return null; }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const uid = () => "id_" + Math.random().toString(36).slice(2,10);

function fmtCur(amount, code="INR") {
  try {
    return new Intl.NumberFormat("en-IN", {
      style:"currency", currency:code,
      maximumFractionDigits: code==="JPY" ? 0 : 2,
    }).format(amount);
  } catch { return String(amount); }
}
function toINR(amount, currency, fxRates) {
  if (!currency || currency==="INR") return amount;
  const r = fxRates?.[currency];
  return r ? amount * r : amount;
}
const fmtINR  = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(n);
const fmtNum  = n => new Intl.NumberFormat("en-IN",{maximumFractionDigits:2}).format(n);
const fmtDate = d => new Date(d+"T00:00:00").toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});

// ─── CREDIT CARD BILLING CYCLE LOGIC ─────────────────────────────────────────
// Returns the billing period (start/end dates) for a given CC at a given reference date.
// If billDay=15, on/after 15th the NEW cycle started on 15th of current month.
// The PAYABLE balance is all txns from previous cycle (prevStart to prevEnd).
// The OUTSTANDING balance is all txns in current cycle (since last billDay).
function getBillingCycle(billDay, refDate = new Date()) {
  const y = refDate.getFullYear();
  const m = refDate.getMonth(); // 0-indexed
  const d = refDate.getDate();

  let cycleStart, cycleEnd, prevStart, prevEnd;

  if (d >= billDay) {
    // Current cycle: billDay of this month → billDay-1 of next month
    cycleStart = new Date(y, m, billDay);
    cycleEnd   = new Date(y, m+1, billDay-1);
    // Previous cycle: billDay of last month → billDay-1 of this month
    prevStart  = new Date(y, m-1, billDay);
    prevEnd    = new Date(y, m, billDay-1);
  } else {
    // Current cycle: billDay of last month → billDay-1 of this month
    cycleStart = new Date(y, m-1, billDay);
    cycleEnd   = new Date(y, m, billDay-1);
    // Previous cycle: billDay of two months ago → billDay-1 of last month
    prevStart  = new Date(y, m-2, billDay);
    prevEnd    = new Date(y, m-1, billDay-1);
  }
  return { cycleStart, cycleEnd, prevStart, prevEnd };
}

// Returns { outstanding, payable } balances for a Credit Card account.
// outstanding = sum of CC expenses in current (open) cycle.
// payable     = sum of CC expenses in the previous (closed/billed) cycle minus payments.
function calcCCBalance(acc, transactions) {
  if (!acc.isCreditCard || !acc.billDay) {
    // Fallback to normal balance calc if not configured as CC
    return { outstanding: 0, payable: 0 };
  }
  const { cycleStart, prevStart, prevEnd } = getBillingCycle(acc.billDay);

  let outstanding = 0;
  let payable     = 0;

  transactions.forEach(tx => {
    if (tx.accountId !== acc.id && tx.toAccountId !== acc.id && tx.fromAccountId !== acc.id) return;
    const txDate = new Date(tx.date+"T00:00:00");

    if (tx.type === "expense" && tx.accountId === acc.id) {
      const netAmt = (parseFloat(tx.amount)||0) - (parseFloat(tx.refundedAmount)||0);
      if (txDate >= cycleStart) {
        // In current open cycle → outstanding
        outstanding += netAmt;
      } else if (txDate >= prevStart && txDate <= prevEnd) {
        // In previous closed cycle → payable
        payable += netAmt;
      }
    } else if (tx.type === "transfer" && tx.toAccountId === acc.id) {
      // Payment to CC (transfer in) reduces payable first, then outstanding
      const amt = parseFloat(tx.amount)||0;
      if (txDate >= cycleStart) {
        outstanding = Math.max(0, outstanding - amt);
      } else {
        payable = Math.max(0, payable - amt);
      }
    }
  });

  return { outstanding, payable };
}

// ─── BALANCE (regular accounts) ──────────────────────────────────────────────
// For CC accounts, use calcCCBalance instead.
// For regular accounts: openingBalance ± transaction effects ± trade effects.
// tradeBalanceEffects: buy → deduct from source; sell → credit to source.
function calcBalance(accountId, transactions, accounts, tradeBalanceEffects) {
  const acc     = (accounts||[]).find(a => a.id === accountId);
  const opening = parseFloat(acc?.openingBalance) || 0;

  const txBal = (transactions||[]).reduce((bal, tx) => {
    if (tx.type === "transfer") {
      if (tx.fromAccountId === accountId) return bal - (parseFloat(tx.amount)||0);
      if (tx.toAccountId   === accountId) return bal + (parseFloat(tx.amount)||0);
    } else if (tx.accountId === accountId) {
      if (tx.type === "income") return bal + (parseFloat(tx.amount)||0);
      if (tx.type === "expense") {
        // Net expense: deduct full amount; refundedAmount adds back
        const net = (parseFloat(tx.amount)||0) - (parseFloat(tx.refundedAmount)||0);
        return bal - net;
      }
    }
    return bal;
  }, opening);

  // Add trade balance effects (buy deducts from source, sell credits source)
  const tradeBal = (tradeBalanceEffects||[]).reduce((bal, eff) => {
    if (eff.accountId === accountId) return bal + eff.amount * eff.sign;
    return bal;
  }, 0);

  return txBal + tradeBal;
}

// ─── NET WORTH CALCULATOR (CENTRALIZED SERVICE) ───────────────────────────────
// Single source of truth — all views must use this function.
// Net Worth = bank + cash + wallet + holdings value (invested cost)
//           + fixed deposits (principal, active only)
//           − credit card payable balances
//
// Investment accounts (categoryId maps to a category with isInvestmentType:true)
// are EXCLUDED from the base account balance sum. Their value is represented
// entirely by the holdings array — adding both would double-count.
//
// @param accounts            - all accounts
// @param transactions        - all transactions
// @param fxRates             - FX rates map { "USD": 83.5, ... }
// @param holdings            - computed holdings (stocks + MFs)
// @param fixedDeposits       - FD array
// @param marketPrices        - unused (kept for signature compat)
// @param tradeBalanceEffects - trade balance effects (buy/sell)
// @param accountCategories   - account category definitions (needed to detect investment type)
function calcNetWorth(accounts, transactions, fxRates, holdings, fixedDeposits, marketPrices, tradeBalanceEffects, accountCategories) {
  let assets    = 0;
  let ccPayable = 0;
  const eff = tradeBalanceEffects || [];

  // Build a set of category IDs that are investment-type
  // (category objects carry isInvestmentType:true, accounts do NOT)
  const cats = accountCategories || DEFAULT.accountCategories;
  const investmentCatIds = new Set(
    cats.filter(c => c.isInvestmentType).map(c => c.id)
  );

  accounts.forEach(acc => {
    // Respect both legacy includeInNetWorth and new include_in_networth flags
    const inNW = acc.include_in_networth !== undefined
      ? acc.include_in_networth
      : acc.includeInNetWorth;
    if (!inNW) return;

    if (acc.isCreditCard) {
      // Credit card: subtract outstanding payable from net worth
      const { payable, outstanding } = calcCCBalance(acc, transactions);
      ccPayable += toINR(payable + outstanding, acc.currency || "INR", fxRates);

    } else if (investmentCatIds.has(acc.categoryId || acc.account_type)) {
      // ── Investment account ────────────────────────────────────────────────
      // Its "value" is represented by the holdings array below.
      // Do NOT add this account's calcBalance() here — that would double-count.
      // (The tradeBalanceEffects on this account reflect money moving in/out of
      //  the account, which equals the holdings invested amount.)

    } else {
      // Bank / cash / wallet / other — add real balance
      const bal = calcBalance(acc.id, transactions, accounts, eff);
      assets += toINR(bal, acc.currency || "INR", fxRates);
    }
  });

  // ── Holdings value (stocks + mutual funds) ─────────────────────────────
  // Counted once here. Investment account balances above are skipped.
  (holdings || []).forEach(h => {
    const qty   = h.quantity || h.units || 0;
    const value = h.investedAmount || qty * (h.avgPrice || h.nav || 0);
    assets += toINR(value, h.currency || "INR", fxRates);
  });

  // ── Active fixed deposits at principal ────────────────────────────────
  (fixedDeposits || []).filter(fd => fd.status !== "closed").forEach(fd => {
    assets += toINR(parseFloat(fd.amount) || 0, fd.currency || "INR", fxRates);
  });

  return assets - ccPayable;
}

// ─── CASHBACK ENGINE ──────────────────────────────────────────────────────────
// Sums expectedCashback on all CC expense transactions grouped by card + percentage.
function calcCashbackSummary(transactions, accounts) {
  // { cardId: { cardName: str, tiers: { "10%": { expected, limit } } } }
  const summary = {};
  transactions.forEach(tx => {
    if (tx.type !== "expense" || !tx.expectedCashbackPct) return;
    const acc = accounts.find(a => a.id === tx.accountId);
    if (!acc?.isCreditCard) return;
    if (!summary[acc.id]) summary[acc.id] = { cardName: acc.name, icon: acc.icon, tiers: {} };
    const pct = String(tx.expectedCashbackPct);
    if (!summary[acc.id].tiers[pct]) summary[acc.id].tiers[pct] = { expected: 0 };
    summary[acc.id].tiers[pct].expected += parseFloat(tx.expectedCashbackAmt)||0;
  });
  return summary;
}

// ─── FIFO INVESTMENT LOGIC ───────────────────────────────────────────────────
// rebuildHoldings(investmentTx, existingHoldings)
//   Returns: { holdings, realizedTrades }
//
// holdings: remaining open positions (net quantity after FIFO sells)
//   • Each holding quantity = sum of remaining lot quantities
//   • avgPrice = investedAmount / remaining quantity  (reflects only unsold cost)
//
// realizedTrades: one entry per FIFO lot-match on a sell
//   { id, symbol, name, type, currency,
//     sellTxId, sellDate, sellPrice,
//     buyDate, buyPrice,
//     qty, pnl, pnlPct }
//
// FIFO rule: oldest buy lot is consumed first on every sell.
// Partial sells split the oldest lot — remaining qty stays in the lot.
function rebuildHoldings(investmentTx, existingHoldings) {
  const map = {};          // key → holding work object
  const realized = [];     // accumulates realized P&L records

  // Sort chronologically so lots are added in order
  const sorted = [...investmentTx].sort((a,b) => new Date(a.date) - new Date(b.date));

  sorted.forEach(tx => {
    if (tx.invType === "fd") return; // FDs tracked separately
    const sym = (tx.symbol || "").trim() || tx.holdingId || "unknown";
    const key = `${sym}_${tx.accountId || ""}`;

    if (!map[key]) {
      const existing = existingHoldings.find(h => h.id === tx.holdingId);
      map[key] = {
        id:             tx.holdingId,
        symbol:         tx.symbol   || existing?.symbol || "?",
        name:           tx.name     || existing?.name   || tx.symbol || "?",
        type:           tx.invType  || existing?.type   || "stock",
        accountId:      tx.accountId,
        currency:       tx.currency || existing?.currency || "INR",
        lots:           [],   // remaining buy lots
        investedAmount: 0,    // cost basis of remaining lots only
      };
    }

    const h = map[key];

    if (tx.type === "buy") {
      const qty   = parseFloat(tx.quantity) || 0;
      const price = parseFloat(tx.price)    || 0;
      h.lots.push({ qty, price, date: tx.date, txId: tx.id });
      h.investedAmount += qty * price;

    } else if (tx.type === "sell") {
      let remaining  = parseFloat(tx.quantity) || 0;
      const sellPrice = parseFloat(tx.price)   || 0;

      for (let i = 0; i < h.lots.length && remaining > 0; i++) {
        const lot = h.lots[i];
        if (lot.qty <= 0) continue;

        const matchedQty = Math.min(lot.qty, remaining);
        const costBasis  = lot.price;
        const pnl        = (sellPrice - costBasis) * matchedQty;
        const pnlPct     = costBasis > 0 ? ((sellPrice - costBasis) / costBasis) * 100 : 0;

        // Record this FIFO lot-match as a realized trade
        realized.push({
          id:         `${tx.id}_${lot.txId || i}`,
          symbol:     h.symbol,
          name:       h.name,
          type:       h.type,
          currency:   h.currency,
          sellTxId:   tx.id,
          sellDate:   tx.date,
          sellPrice,
          buyDate:    lot.date,
          buyPrice:   costBasis,
          qty:        matchedQty,
          pnl,
          pnlPct,
        });

        // Reduce cost basis of remaining holding
        h.investedAmount -= matchedQty * costBasis;
        h.lots[i] = { ...lot, qty: lot.qty - matchedQty };
        remaining -= matchedQty;
      }
      // Remove fully consumed lots
      h.lots = h.lots.filter(l => l.qty > 0);
    }
  });

  // Build final holdings — only positions with remaining quantity
  const holdings = Object.values(map).map(h => {
    const totalQty = h.lots.reduce((s, l) => s + l.qty, 0);
    const invested  = Math.max(0, h.investedAmount);
    const avgPrice  = totalQty > 0 ? invested / totalQty : 0;
    return {
      ...h,
      quantity:       h.type !== "mf" ? totalQty : 0,
      units:          h.type === "mf" ? totalQty : 0,
      avgPrice,
      nav:            h.type === "mf" ? avgPrice : 0,
      investedAmount: invested,
    };
  }).filter(h => (h.quantity || 0) > 0 || (h.units || 0) > 0);

  return { holdings, realizedTrades: realized };
}

// Convenience: just holdings (used by ADD_INVESTMENT incremental path)
function rebuildHoldingsOnly(txList, existing) {
  return rebuildHoldings(txList, existing).holdings;
}

// Pure realized-trades builder (used by Profits tab + P&L report)
function buildRealizedTrades(investmentTx) {
  return rebuildHoldings(investmentTx, []).realizedTrades;
}

// ─── PRICE FETCH — Google Finance scrape (works from any origin) ─────────────
//
// Strategy: Scrape Google Finance HTML page for the price.
// Google Finance pages are publicly accessible and return structured HTML
// with the price embedded. We use two CORS proxy services in a waterfall.
//
// Symbol mapping → Google Finance format:
//   ITC          → NSE:ITC
//   NSE:ITC      → NSE:ITC  (passthrough)
//   MUTF_IN:xxx  → MUTF_IN:xxx (passthrough)
//   ITC.NS       → NSE:ITC
//
// CORS proxy waterfall (tested to work from localhost AND production):
//   1. allorigins.win  — most reliable, supports all origins
//   2. corsproxy.io    — good fallback
//   Timeout: 8s per proxy attempt
//
function toGoogleSymbol(raw) {
  if (!raw) return null;
  const s = raw.trim();
  // Already Google format with colon
  if (s.includes(":")) return s;
  // Yahoo-style suffix
  if (s.endsWith(".NS")) return "NSE:" + s.slice(0, -3);
  if (s.endsWith(".BO")) return "BSE:" + s.slice(0, -3);
  // Bare symbol — assume NSE
  return "NSE:" + s;
}

function toYahooSymbol(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (/\.[A-Z]{1,3}$/.test(s)) return s;
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const exchange = s.slice(0, colonIdx).toUpperCase();
    const ticker   = s.slice(colonIdx + 1);
    if (exchange === "MUTF_IN") return ticker + ".BO";
    if (exchange === "NSE")     return ticker + ".NS";
    if (exchange === "BSE")     return ticker + ".BO";
    return ticker + ".NS";
  }
  return s + ".NS";
}

// Parse price from Google Finance HTML
function parseGoogleFinancePrice(html) {
  if (!html) return null;
  // Google Finance embeds price in multiple formats; try each
  const patterns = [
    // JSON-LD / data attribute: "price":"450.25"
    /"price"\s*:\s*"?([\d,]+\.?\d*)"/,
    // The main price display div uses data-last-price
    /data-last-price="([\d.]+)"/,
    // Structured data price pattern
    /"regularMarketPrice"\s*:\s*([\d.]+)/,
    // Price in the page title or meta
    /content="[\w\s]+\s+([\d,]+\.?\d*)\s*(?:INR|₹)/,
    // YFinance-style embedded JSON
    /"currentPrice"\s*:\s*([\d.]+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 0) return val;
    }
  }
  return null;
}

async function _fetchViaProxy(url) {
  // Proxy 1: allorigins.win — wraps response in {contents:"..."}
  const proxies = [
    async (u) => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
      if (!r.ok) throw new Error("allorigins failed");
      const j = await r.json();
      return j.contents || "";
    },
    async (u) => {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
      if (!r.ok) throw new Error("corsproxy failed");
      return await r.text();
    },
  ];
  for (const proxy of proxies) {
    try {
      const text = await proxy(url);
      if (text && text.length > 100) return text;
    } catch {}
  }
  return null;
}

// Fetch price from Google Finance for one symbol
async function _fetchGooglePrice(googleSym) {
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(googleSym)}`;
  const html = await _fetchViaProxy(url);
  if (!html) return null;
  return parseGoogleFinancePrice(html);
}

// Fetch price from Yahoo Finance (more reliable numeric data)
async function _fetchYahooPrice(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  const raw = await _fetchViaProxy(url);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price && price > 0 ? parseFloat(price.toFixed(2)) : null;
  } catch { return null; }
}

async function fetchLivePrice(symbol) {
  if (!symbol) return null;
  // Try Yahoo Finance first (clean JSON, easy to parse)
  try {
    const yahooSym = toYahooSymbol(symbol);
    const yPrice = await _fetchYahooPrice(yahooSym);
    if (yPrice && yPrice > 0) return yPrice;
  } catch {}
  // Fall back to Google Finance HTML scraping
  try {
    const gSym = toGoogleSymbol(symbol);
    const gPrice = await _fetchGooglePrice(gSym);
    if (gPrice && gPrice > 0) return gPrice;
  } catch {}
  return null;
}

// Fetch prices for multiple symbols sequentially
async function fetchMultiplePrices(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const result = {};
  for (let i = 0; i < symbols.length; i++) {
    try {
      const price = await fetchLivePrice(symbols[i]);
      if (price && price > 0) result[symbols[i]] = price;
    } catch {}
    if (i < symbols.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  return result;
}

// ─── FD INTEREST CALCULATOR ──────────────────────────────────────────────────
function calcFDReturns(fd) {
  const principal = parseFloat(fd.amount)||0;
  const rate      = parseFloat(fd.interestRate)||0;
  const start     = new Date(fd.investedDate+"T00:00:00");
  const end       = new Date(fd.maturityDate+"T00:00:00");
  const years     = Math.max(0, (end - start) / (1000*60*60*24*365.25));
  const interest  = principal * (rate/100) * years;
  return { principal, interest: parseFloat(interest.toFixed(2)), maturityValue: parseFloat((principal+interest).toFixed(2)), years: parseFloat(years.toFixed(2)) };
}

// ─── BUILD TRADE BALANCE EFFECTS ──────────────────────────────────────────────
// Derives tradeBalanceEffects from full investmentTx array.
// Called when rebuilding from scratch (edit/delete trade).
// BUY: sign = -1 (deduct from source)
// SELL: sign = +1 (credit to source)
function buildTradeBalanceEffects(investmentTx, fixedDeposits) {
  // For each trade: TWO effects — source account and investment account
  const stockEffects = [];
  (investmentTx||[])
    .filter(itx => !itx.invType?.includes("fd"))
    .forEach(itx => {
      const amt = (parseFloat(itx.quantity)||0) * (parseFloat(itx.price)||0);
      if (amt <= 0) return;
      // Source/bank account: BUY deducts, SELL credits
      if (itx.sourceAccountId) {
        stockEffects.push({
          id:        "eff_src_" + itx.id,
          accountId: itx.sourceAccountId,
          amount:    amt,
          sign:      itx.type === "buy" ? -1 : 1,
          tradeId:   itx.id + "_src",
          date:      itx.date,
        });
      }
      // Investment account: BUY credits, SELL debits
      if (itx.accountId) {
        stockEffects.push({
          id:        "eff_inv_" + itx.id,
          accountId: itx.accountId,
          amount:    amt,
          sign:      itx.type === "buy" ? 1 : -1,
          tradeId:   itx.id + "_inv",
          date:      itx.date,
        });
      }
    });
  // FD effects: each FD deducts from its source account
  const fdEffects = (fixedDeposits||[])
    .filter(fd => fd.sourceAccountId && parseFloat(fd.amount) > 0)
    .map(fd => ({
      id:        "fdeff_" + fd.id,
      accountId: fd.sourceAccountId,
      amount:    parseFloat(fd.amount),
      sign:      -1,
      tradeId:   fd.id,
      date:      fd.investedDate || "",
      isFD:      true,
    }));
  return [...stockEffects, ...fdEffects];
}

// ─── REDUCER ─────────────────────────────────────────────────────────────────
function reducer(rawState, action) {
  const s = sanitize(rawState);
  switch (action.type) {
    case "SET":         return sanitize(action.payload);

    // ── Transactions ─────────────────────────────────────────────────────────
    // Transactions are INCOME or EXPENSE only (transfer preserved for UI compat).
    // is_refund flag marks refund-type income transactions.
    case "ADD_TX":      return { ...s, transactions: [...s.transactions, action.payload] };

    case "EDIT_TX":     return { ...s, transactions: s.transactions.map(t =>
                          t.id === action.payload.id ? action.payload : t) };

    case "DELETE_TX":   return { ...s, transactions: s.transactions.filter(t =>
                          t.id !== action.payload) };

    // Apply a refund: link income tx to expense tx, update refundedAmount
    case "APPLY_REFUND": {
      const { expenseId, refundAmt } = action.payload;
      return {
        ...s,
        transactions: s.transactions.map(t => {
          if (t.id !== expenseId) return t;
          const prev = parseFloat(t.refundedAmount)||0;
          const next = Math.min(prev + refundAmt, parseFloat(t.amount)||0);
          return {
            ...t,
            refundedAmount: next,
            is_refund: true,
            isRefunded: next >= (parseFloat(t.amount)||0),
          };
        }),
      };
    }

    // ── Accounts ─────────────────────────────────────────────────────────────
    case "ADD_ACCOUNT":  return { ...s, accounts: [...s.accounts, sanitizeAccount(action.payload)] };
    case "EDIT_ACCOUNT": return { ...s, accounts: s.accounts.map(a =>
                           a.id === action.payload.id ? sanitizeAccount(action.payload) : a) };

    // ── Account categories (fully CRUD) ──────────────────────────────────────
    case "ADD_ACC_CAT":  return { ...s, accountCategories: [...s.accountCategories, action.payload] };
    case "EDIT_ACC_CAT": return { ...s, accountCategories: s.accountCategories.map(c =>
                           c.id === action.payload.id ? action.payload : c) };
    case "DEL_ACC_CAT":  return { ...s, accountCategories: s.accountCategories.filter(c =>
                           c.id !== action.payload) };

    // ── Transaction categories (with subCategories[] support) ─────────────────
    case "ADD_EXP_CAT":  return { ...s, expenseCategories: [...s.expenseCategories, action.payload] };
    case "UPD_EXP_CAT":  return { ...s, expenseCategories: s.expenseCategories.map(c =>
                           c.id === action.payload.id ? action.payload : c) };
    case "DEL_EXP_CAT":  return { ...s, expenseCategories: s.expenseCategories.filter(c => c.id !== action.payload) };
    case "ADD_INC_CAT":  return { ...s, incomeCategories:  [...s.incomeCategories,  action.payload] };
    case "UPD_INC_CAT":  return { ...s, incomeCategories:  s.incomeCategories.map(c =>
                           c.id === action.payload.id ? action.payload : c) };
    case "DEL_INC_CAT":  return { ...s, incomeCategories:  s.incomeCategories.filter(c =>  c.id !== action.payload) };

    // ── FX ───────────────────────────────────────────────────────────────────
    case "SET_FX":       return { ...s, fxRates: action.payload };

    // ── Accounts – hard delete (only if no transactions touch it) ─────────────
    case "DELETE_ACCOUNT": return { ...s, accounts: s.accounts.filter(a => a.id !== action.payload) };

    // ── Stocks Master Table ────────────────────────────────────────────────────
    // ADD_STOCK: { id, symbol, name, type, exchange }
    case "ADD_STOCK":    return { ...s, stocks: [...(s.stocks||[]), action.payload] };
    case "EDIT_STOCK":   return { ...s, stocks: (s.stocks||[]).map(st => st.id===action.payload.id ? action.payload : st) };
    case "DELETE_STOCK": return { ...s, stocks: (s.stocks||[]).filter(st => st.id !== action.payload) };
    // RENAME_STOCK: rename symbol in stocks table + update all holdings + investmentTx
    case "RENAME_STOCK": {
      const { oldSymbol, newSymbol, newName } = action.payload;
      return {
        ...s,
        stocks: (s.stocks||[]).map(st => st.symbol===oldSymbol ? {...st, symbol:newSymbol, name:newName||st.name} : st),
        holdings: (s.holdings||[]).map(h => h.symbol===oldSymbol ? {...h, symbol:newSymbol, name:newName||h.name} : h),
        investmentTx: (s.investmentTx||[]).map(t => t.symbol===oldSymbol ? {...t, symbol:newSymbol} : t),
        marketPrices: (() => {
          const mp = {...(s.marketPrices||{})};
          if (mp[oldSymbol]) { mp[newSymbol]=mp[oldSymbol]; delete mp[oldSymbol]; }
          return mp;
        })(),
      };
    }

    // ── Market Prices ──────────────────────────────────────────────────────────
    // UPDATE_MARKET_PRICE: { symbol, current_price, last_updated }
    // Stores fetched prices separately from trade prices.
    case "UPDATE_MARKET_PRICE": {
      const { symbol, current_price, last_updated } = action.payload;
      return {
        ...s,
        marketPrices: {
          ...s.marketPrices,
          [symbol]: { current_price, last_updated: last_updated || new Date().toISOString() },
        },
      };
    }

    // ── Corporate Actions ──────────────────────────────────────────────────────
    // ADD_CORPORATE_ACTION: { id, symbol, action_type, ratio, date, note }
    // action_type: stock_split | bonus | reverse_split | dividend | stock_name_change
    // This stores the action AND updates affected holdings.
    case "ADD_CORPORATE_ACTION": {
      const ca  = action.payload;
      const newActions = [...s.corporateActions, ca];
      let holdings = [...s.holdings];

      if (ca.action_type === "stock_split" || ca.action_type === "bonus") {
        // qty * ratio; avgPrice / ratio
        holdings = holdings.map(h => {
          if (h.symbol !== ca.symbol) return h;
          const ratio = parseFloat(ca.ratio) || 1;
          const newQty = (h.quantity || h.units || 0) * ratio;
          const newAvg = (h.avgPrice || h.nav || 0) / ratio;
          return { ...h, quantity: h.type !== "mf" ? newQty : 0,
                         units: h.type === "mf" ? newQty : 0,
                         avgPrice: newAvg, nav: newAvg };
        });
      } else if (ca.action_type === "reverse_split") {
        // qty / ratio; avgPrice * ratio
        holdings = holdings.map(h => {
          if (h.symbol !== ca.symbol) return h;
          const ratio = parseFloat(ca.ratio) || 1;
          const newQty = (h.quantity || h.units || 0) / ratio;
          const newAvg = (h.avgPrice || h.nav || 0) * ratio;
          return { ...h, quantity: h.type !== "mf" ? newQty : 0,
                         units: h.type === "mf" ? newQty : 0,
                         avgPrice: newAvg, nav: newAvg };
        });
      } else if (ca.action_type === "stock_name_change") {
        // Update symbol and name on holdings
        const { new_symbol, new_name } = ca;
        holdings = holdings.map(h => {
          if (h.symbol !== ca.symbol) return h;
          return { ...h, symbol: new_symbol || h.symbol, name: new_name || h.name };
        });
      }
      // dividend: income only — create a transaction instead (handled in UI)
      return { ...s, corporateActions: newActions, holdings };
    }

    // ── Delete Corporate Action (reverses holdings effect) ───────────────────
    case "DELETE_CORPORATE_ACTION": {
      const caId = action.payload;
      const ca = (s.corporateActions||[]).find(c => c.id===caId);
      if (!ca) return s;
      const newActions = s.corporateActions.filter(c => c.id!==caId);
      let holdings = [...s.holdings];

      if (ca.action_type === "stock_split" || ca.action_type === "bonus") {
        const ratio = parseFloat(ca.ratio)||1;
        holdings = holdings.map(h => {
          if (h.symbol !== ca.symbol) return h;
          const newQty = (h.quantity||h.units||0) / ratio;
          const newAvg = (h.avgPrice||h.nav||0) * ratio;
          return { ...h, quantity: h.type!=="mf"?newQty:0, units: h.type==="mf"?newQty:0, avgPrice:newAvg, nav:newAvg };
        });
      } else if (ca.action_type === "reverse_split") {
        const ratio = parseFloat(ca.ratio)||1;
        holdings = holdings.map(h => {
          if (h.symbol !== ca.symbol) return h;
          const newQty = (h.quantity||h.units||0) * ratio;
          const newAvg = (h.avgPrice||h.nav||0) / ratio;
          return { ...h, quantity: h.type!=="mf"?newQty:0, units: h.type==="mf"?newQty:0, avgPrice:newAvg, nav:newAvg };
        });
      } else if (ca.action_type === "stock_name_change") {
        // Reverse: rename back to old symbol
        holdings = holdings.map(h => {
          if (h.symbol !== ca.new_symbol) return h;
          return { ...h, symbol: ca.symbol, name: ca.old_name||ca.symbol };
        });
      } else if (ca.action_type === "merger") {
        // Reverse merger: remove the merged-into stock holdings (simplistic)
        holdings = holdings.filter(h => h.symbol !== (ca.to_symbol||ca.symbol));
      } else if (ca.action_type === "demerger") {
        // Reverse demerger: remove the newly created split stocks
        const newSymbols = (ca.result_symbols||[]).filter(sym => sym !== ca.symbol);
        holdings = holdings.filter(h => !newSymbols.includes(h.symbol));
      }
      return { ...s, corporateActions: newActions, holdings };
    }

    // ── Bulk Delete Holdings ──────────────────────────────────────────────────
    case "BULK_DELETE_HOLDINGS": {
      const symbols = action.payload;
      const newTxs     = s.investmentTx.filter(t => !symbols.includes(t.symbol));
      const newActions = s.corporateActions.filter(ca => !symbols.includes(ca.symbol));
      const { holdings: newHoldings } = rebuildHoldings(newTxs, s.holdings);
      const newEffects = buildTradeBalanceEffects(newTxs, s.fixedDeposits);
      return { ...s, holdings: newHoldings, investmentTx: newTxs, corporateActions: newActions, tradeBalanceEffects: newEffects };
    }

    // ── Investments (full FIFO-aware) ─────────────────────────────────────────
    // ADD_INVESTMENT: { newHolding, itx }
    // BUY:  deducts trade value from sourceAccountId via tradeBalanceEffect
    // SELL: credits trade value to sourceAccountId via tradeBalanceEffect
    // Holdings are updated incrementally here (not rebuilt from scratch).
    case "ADD_INVESTMENT": {
      const { newHolding, itx } = action.payload;
      const tradeAmt = (parseFloat(itx.quantity)||0) * (parseFloat(itx.price)||0);

      // Trade balance effects:
      // BUY:  source account (bank) -tradeAmt, investment account +tradeAmt
      // SELL: investment account -tradeAmt, source account (bank) +tradeAmt
      const tradeEffects = [...s.tradeBalanceEffects];
      if (tradeAmt > 0) {
        if (itx.sourceAccountId) {
          tradeEffects.push({
            id:        uid(),
            accountId: itx.sourceAccountId,
            amount:    tradeAmt,
            sign:      itx.type === "buy" ? -1 : 1,
            tradeId:   itx.id + "_src",
            date:      itx.date,
          });
        }
        if (itx.accountId) {
          tradeEffects.push({
            id:        uid(),
            accountId: itx.accountId,
            amount:    tradeAmt,
            sign:      itx.type === "buy" ? 1 : -1,
            tradeId:   itx.id + "_inv",
            date:      itx.date,
          });
        }
      }

      // Incremental holdings update (FIFO for sells)
      let holdings = [...s.holdings];
      const existingIdx = holdings.findIndex(h =>
        h.id === (newHolding?.id || itx.holdingId) ||
        (h.symbol === itx.symbol && h.accountId === itx.accountId)
      );

      if (itx.type === "buy") {
        if (existingIdx >= 0) {
          // Update existing holding incrementally
          const h = holdings[existingIdx];
          const newQty = (h.quantity || h.units || 0) + (parseFloat(itx.quantity)||0);
          const newInvested = (h.investedAmount || 0) + tradeAmt;
          const newAvg = newQty > 0 ? newInvested / newQty : 0;
          const newLots = [...(h.lots||[]), { qty: parseFloat(itx.quantity)||0, price: parseFloat(itx.price)||0, date: itx.date, txId: itx.id }];
          holdings[existingIdx] = {
            ...h,
            lots: newLots,
            quantity: h.type !== "mf" ? newQty : 0,
            units:    h.type === "mf" ? newQty : 0,
            avgPrice: newAvg, nav: h.type === "mf" ? newAvg : h.nav,
            investedAmount: newInvested,
          };
        } else if (newHolding) {
          // Brand new holding
          const qty = parseFloat(itx.quantity)||0;
          holdings.push({
            ...newHolding,
            lots: [{ qty, price: parseFloat(itx.price)||0, date: itx.date, txId: itx.id }],
            quantity: newHolding.type !== "mf" ? qty : 0,
            units:    newHolding.type === "mf" ? qty : 0,
            avgPrice: parseFloat(itx.price)||0,
            investedAmount: tradeAmt,
          });
        }
      } else if (itx.type === "sell" && existingIdx >= 0) {
        // FIFO sell on existing holding
        const h = holdings[existingIdx];
        let lots = [...(h.lots||[])].sort((a,b) => new Date(a.date) - new Date(b.date));
        let remaining = parseFloat(itx.quantity)||0;
        let investedReduction = 0;
        for (let i = 0; i < lots.length && remaining > 0; i++) {
          if (lots[i].qty <= remaining) {
            investedReduction += lots[i].qty * lots[i].price;
            remaining -= lots[i].qty;
            lots[i] = { ...lots[i], qty: 0 };
          } else {
            investedReduction += remaining * lots[i].price;
            lots[i] = { ...lots[i], qty: lots[i].qty - remaining };
            remaining = 0;
          }
        }
        lots = lots.filter(l => l.qty > 0);
        const newQty = lots.reduce((s,l) => s + l.qty, 0);
        const newInvested = Math.max(0, (h.investedAmount||0) - investedReduction);
        const newAvg = newQty > 0 ? newInvested / newQty : 0;
        if (newQty <= 0) {
          holdings.splice(existingIdx, 1); // fully sold out
        } else {
          holdings[existingIdx] = {
            ...h, lots,
            quantity: h.type !== "mf" ? newQty : 0,
            units:    h.type === "mf" ? newQty : 0,
            avgPrice: newAvg, nav: h.type === "mf" ? newAvg : h.nav,
            investedAmount: newInvested,
          };
        }
      }

      return {
        ...s,
        holdings,
        investmentTx:        [...s.investmentTx, itx],
        tradeBalanceEffects: tradeEffects,
      };
    }

    case "EDIT_INVESTMENT_TX": {
      if (!action.payload?.id) return s;
      const newTxs = s.investmentTx.map(t => t.id===action.payload.id ? action.payload : t);
      const { holdings: rebuilt } = rebuildHoldings(newTxs, s.holdings);
      const stockEffects = buildTradeBalanceEffects(newTxs, []);
      const fdEffects = s.tradeBalanceEffects.filter(e => e.isFD);
      return { ...s, investmentTx: newTxs, holdings: rebuilt, tradeBalanceEffects: [...stockEffects, ...fdEffects] };
    }

    case "DELETE_INVESTMENT_TX": {
      const tid = action.payload;
      if (!tid) return s;
      const newTxs = s.investmentTx.filter(t => t.id !== tid);
      if (newTxs.length === s.investmentTx.length) return s;
      const { holdings: rebuilt } = rebuildHoldings(newTxs, s.holdings);
      const stockEffects = buildTradeBalanceEffects(newTxs, []);
      const fdEffects = s.tradeBalanceEffects.filter(e => e.isFD);
      return { ...s, investmentTx: newTxs, holdings: rebuilt, tradeBalanceEffects: [...stockEffects, ...fdEffects] };
    }

    // Bulk delete multiple trades at once (Trade History multi-select)
    case "BULK_DELETE_INVESTMENT_TXS": {
      const ids = new Set(action.payload || []);
      if (ids.size === 0) return s;
      const newTxs = s.investmentTx.filter(t => !ids.has(t.id));
      if (newTxs.length === s.investmentTx.length) return s;
      const { holdings: rebuilt } = rebuildHoldings(newTxs, s.holdings);
      const stockEffects = buildTradeBalanceEffects(newTxs, []);
      const fdEffects = s.tradeBalanceEffects.filter(e => e.isFD);
      return { ...s, investmentTx: newTxs, holdings: rebuilt, tradeBalanceEffects: [...stockEffects, ...fdEffects] };
    }

    // BULK_IMPORT_INVESTMENTS: atomically append many trades from a CSV import.
    // payload: { trades: itx[] }
    // Each itx must have accountId (investment) and sourceAccountId (bank).
    // Uses rebuildHoldings + buildTradeBalanceEffects — identical to delete/edit.
    // Single dispatch = single saveLocal = no stale-state or persistence issues.
    case "BULK_IMPORT_INVESTMENTS": {
      const { trades } = action.payload || {};
      if (!trades || trades.length === 0) return s;
      // Merge new trades with existing, preserving order by date
      const allTxs = [...s.investmentTx, ...trades].sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );
      // Rebuild holdings from scratch so FIFO is correct across old + new trades
      const { holdings: rebuilt } = rebuildHoldings(allTxs, []);
      // Rebuild all trade balance effects (stock effects only; FD effects preserved)
      const fdEffects    = s.tradeBalanceEffects.filter(e => e.isFD);
      const stockEffects = buildTradeBalanceEffects(allTxs, []);
      return {
        ...s,
        investmentTx:        allTxs,
        holdings:            rebuilt,
        tradeBalanceEffects: [...stockEffects, ...fdEffects],
      };
    }

    // ── Fixed Deposits ────────────────────────────────────────────────────────
    case "ADD_FD": {
      const fd = action.payload;
      // Sync: deduct principal from source account via tradeBalanceEffect
      const fdEffects = [...s.tradeBalanceEffects];
      if (fd.sourceAccountId && parseFloat(fd.amount) > 0) {
        fdEffects.push({
          id: "fdeff_" + fd.id,
          accountId: fd.sourceAccountId,
          amount: parseFloat(fd.amount),
          sign: -1, // deduct from source
          tradeId: fd.id,
          date: fd.investedDate || new Date().toISOString().slice(0,10),
          isFD: true,
        });
      }
      return { ...s, fixedDeposits: [...(s.fixedDeposits||[]), fd], tradeBalanceEffects: fdEffects };
    }
    case "EDIT_FD": {
      const updated = action.payload;
      const old = (s.fixedDeposits||[]).find(f => f.id === updated.id);
      // Rebuild FD effects: remove old, add new
      let effs = s.tradeBalanceEffects.filter(e => e.tradeId !== updated.id);
      if (updated.sourceAccountId && parseFloat(updated.amount) > 0) {
        effs.push({
          id: "fdeff_" + updated.id,
          accountId: updated.sourceAccountId,
          amount: parseFloat(updated.amount),
          sign: -1,
          tradeId: updated.id,
          date: updated.investedDate || new Date().toISOString().slice(0,10),
          isFD: true,
        });
      }
      return { ...s, fixedDeposits: (s.fixedDeposits||[]).map(f => f.id===updated.id ? updated : f), tradeBalanceEffects: effs };
    }
    case "DELETE_FD": {
      const fdId = action.payload;
      // Remove tradeBalanceEffect for this FD
      const effs = s.tradeBalanceEffects.filter(e => e.tradeId !== fdId);
      return { ...s, fixedDeposits: (s.fixedDeposits||[]).filter(f => f.id !== fdId), tradeBalanceEffects: effs };
    }
    // CLOSE_FD: credit principal to selected account + record interest as income tx
    // FD is kept with status=closed for undo support (not deleted)
    case "CLOSE_FD": {
      const { fdId, incomeAccId, interestAmt, closeDate } = action.payload;
      const fd = (s.fixedDeposits||[]).find(f => f.id === fdId);
      if (!fd) return s;

      const targetAccId = incomeAccId || fd.sourceAccountId;
      const principal   = parseFloat(fd.amount) || 0;
      const interest    = parseFloat(interestAmt) || 0;

      const closeEffId  = "fdclose_" + fdId;
      const incTxId     = "fdint_" + fdId;

      // Remove original deduction effect; add principal-return credit
      let effs = s.tradeBalanceEffects.filter(e => e.tradeId !== fdId && e.id !== closeEffId);
      if (targetAccId && principal > 0) {
        effs.push({
          id:        closeEffId,
          accountId: targetAccId,
          amount:    principal,
          sign:      +1,
          tradeId:   fdId + "_close",
          date:      closeDate,
          isFD:      true,
        });
      }

      // Interest as income transaction
      const incTx = interest > 0 ? {
        id:         incTxId,
        type:       "income",
        amount:     interest,
        accountId:  targetAccId,
        categoryId: "ic_int",
        date:       closeDate,
        note:       "FD interest: " + (fd.name || "Fixed Deposit"),
        currency:   fd.currency || "INR",
        fdId:       fdId,
      } : null;

      // Mark FD as closed (keep it for undo); store close metadata
      const closedFd = {
        ...fd,
        status:         "closed",
        closeDate,
        closedAccId:    targetAccId,
        closedInterest: interest,
        closeEffId,
        incTxId:        incTx ? incTxId : null,
      };

      return {
        ...s,
        fixedDeposits:       (s.fixedDeposits||[]).map(f => f.id === fdId ? closedFd : f),
        tradeBalanceEffects: effs,
        transactions:        incTx ? [...s.transactions, incTx] : s.transactions,
      };
    }

    // UNDO_CLOSE_FD: reverses a closed FD back to active
    case "UNDO_CLOSE_FD": {
      const fdId = action.payload;
      const fd   = (s.fixedDeposits||[]).find(f => f.id === fdId);
      if (!fd || fd.status !== "closed") return s;

      // Remove the close credit; restore original deduction
      let effs = s.tradeBalanceEffects.filter(e => e.id !== fd.closeEffId);
      if (fd.sourceAccountId && parseFloat(fd.amount) > 0) {
        effs.push({
          id:        "fdeff_" + fdId,
          accountId: fd.sourceAccountId,
          amount:    parseFloat(fd.amount),
          sign:      -1,
          tradeId:   fdId,
          date:      fd.investedDate || "",
          isFD:      true,
        });
      }

      // Remove the income transaction that was created for interest
      const newTxs = fd.incTxId
        ? s.transactions.filter(t => t.id !== fd.incTxId)
        : s.transactions;

      // Restore FD to active status — strip close metadata
      const { status, closeDate, closedAccId, closedInterest, closeEffId, incTxId, ...restoredFd } = fd;

      return {
        ...s,
        fixedDeposits:       (s.fixedDeposits||[]).map(f => f.id === fdId ? restoredFd : f),
        tradeBalanceEffects: effs,
        transactions:        newTxs,
      };
    }

    default: return s;
  }
}

// ─── TOAST CONTEXT ────────────────────────────────────────────────────────────
// Global toast system — components call window.__toast(msg, type)
function useToastSystem() {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type="success") => {
    const id = uid();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2500);
  }, []);

  // Expose globally so any component can call window.__toast(msg, type)
  useEffect(() => { window.__toast = addToast; }, [addToast]);

  return toasts;
}

// ─── TOAST RENDERER ──────────────────────────────────────────────────────────
function ToastContainer({ toasts }) {
  return (
    <div style={{
      position:"fixed", top:16, right:16, zIndex:9999,
      display:"flex", flexDirection:"column", gap:8,
      pointerEvents:"none",
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type==="error" ? "#FEF2F2" : "#F0FDF4",
          border: `1px solid ${t.type==="error" ? "#FECACA" : "#A7F3D0"}`,
          color: t.type==="error" ? "#B91C1C" : "#065F46",
          padding:"12px 18px", borderRadius:12, fontSize:14, fontWeight:600,
          boxShadow:"0 4px 20px rgba(0,0,0,0.12)",
          animation:"toastIn 0.25s ease",
          maxWidth:320, wordBreak:"break-word",
        }}>
          {t.type==="error" ? "⚠️" : "✅"} {t.message}
        </div>
      ))}
      <style>{`
        @keyframes toastIn {
          from { opacity:0; transform:translateY(-8px) scale(0.97); }
          to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const toast = (msg, type="success") => window.__toast?.(msg, type);

// ─── TINY COMPONENTS ─────────────────────────────────────────────────────────
function Card({ children, style={} }) {
  return <div style={{background:"#fff",borderRadius:16,padding:20,boxShadow:"0 2px 8px rgba(0,0,0,0.06)",...style}}>{children}</div>;
}

// Modal: renders as centered dialog on desktop, bottom sheet on mobile
function Modal({ title, onClose, children }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  return (
    <div
      onClick={e => e.target===e.currentTarget && onClose()}
      style={{
        position:"fixed", inset:0, zIndex:1000,
        background:"rgba(15,23,42,0.55)", backdropFilter:"blur(3px)",
        display:"flex", alignItems:"flex-end", justifyContent:"center",
      }}
    >
      <div style={{
        background:"#fff", borderRadius:"20px 20px 0 0",
        width:"100%", maxWidth:560,
        maxHeight:"92dvh", overflowY:"auto",
        boxShadow:"0 -8px 40px rgba(0,0,0,0.18)",
        paddingBottom:"env(safe-area-inset-bottom,12px)",
      }}>
        {/* Drag handle */}
        <div style={{display:"flex",justifyContent:"center",padding:"10px 0 4px"}}>
          <div style={{width:36,height:4,borderRadius:2,background:"#CBD5E1"}}/>
        </div>
        <div style={{padding:"4px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <h3 style={{margin:0,fontSize:17,fontWeight:700,color:"#0F172A"}}>{title}</h3>
          <button onClick={onClose} style={{
            border:"none", background:"#F1F5F9", borderRadius:8,
            width:40, height:40, cursor:"pointer", fontSize:20,
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
          }}>×</button>
        </div>
        <div style={{padding:"12px 20px 20px"}}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, note }) {
  return (
    <div style={{marginBottom:16}}>
      {label && <label style={{display:"block",fontSize:12,fontWeight:600,color:"#64748B",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>{label}</label>}
      {children}
      {note && <div style={{fontSize:11,color:"#94A3B8",marginTop:4}}>{note}</div>}
    </div>
  );
}

// inputStyle: font-size 16px prevents iOS zoom on focus
const inputStyle = {
  width:"100%", border:"1.5px solid #E2E8F0", borderRadius:10,
  padding:"11px 14px", fontSize:16, outline:"none",
  boxSizing:"border-box", fontFamily:"inherit", WebkitAppearance:"none",
};

function Inp({ label, note, ...props }) {
  return (
    <Field label={label} note={note}>
      <input {...props} style={{...inputStyle,...props.style}}
        onFocus={e=>e.target.style.borderColor="#6366F1"}
        onBlur={e=>e.target.style.borderColor="#E2E8F0"} />
    </Field>
  );
}

function Sel({ label, children, note, ...props }) {
  return (
    <Field label={label} note={note}>
      <select {...props} style={{...inputStyle,background:"#fff",cursor:"pointer",...props.style}}>{children}</select>
    </Field>
  );
}

// Toggle (boolean switch)
function Toggle({ label, checked, onChange, note }) {
  return (
    <Field label={label} note={note}>
      <button
        onClick={() => onChange(!checked)}
        style={{
          display:"flex", alignItems:"center", gap:10,
          background:"none", border:"none", cursor:"pointer", padding:0,
        }}
      >
        <div style={{
          width:44, height:26, borderRadius:13,
          background: checked ? "#6366F1" : "#CBD5E1",
          position:"relative", transition:"background 0.2s", flexShrink:0,
        }}>
          <div style={{
            position:"absolute", top:3, left: checked ? 21 : 3,
            width:20, height:20, borderRadius:"50%", background:"#fff",
            transition:"left 0.2s", boxShadow:"0 1px 4px rgba(0,0,0,0.2)",
          }}/>
        </div>
        <span style={{fontSize:14, color: checked ? "#6366F1" : "#64748B", fontWeight:600}}>
          {checked ? "Yes" : "No"}
        </span>
      </button>
    </Field>
  );
}

const btnVariants = {
  primary: d => ({background:d?"#C7D2FE":"linear-gradient(135deg,#6366F1,#8B5CF6)",color:"#fff",border:"none"}),
  ghost:   ()  => ({background:"#F8FAFC",color:"#475569",border:"1.5px solid #E2E8F0"}),
  danger:  ()  => ({background:"#FEF2F2",color:"#EF4444",border:"1.5px solid #FECACA"}),
  success: ()  => ({background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",border:"none"}),
  warning: ()  => ({background:"#FFFBEB",color:"#D97706",border:"1.5px solid #FDE68A"}),
};
const btnSizes = {
  sm: { padding:"9px 16px", fontSize:13 },
  md: { padding:"13px 20px", fontSize:14 },
};
function Btn({ children, onClick, variant="primary", size="md", disabled=false, style={} }) {
  return (
    <button onClick={disabled?undefined:onClick} disabled={disabled}
      style={{
        borderRadius:10, fontWeight:600, cursor:disabled?"not-allowed":"pointer",
        fontFamily:"inherit", transition:"all 0.15s",
        ...btnVariants[variant](disabled), ...btnSizes[size], ...style,
      }}>
      {children}
    </button>
  );
}

function Badge({ children, color, bg }) {
  return <span style={{background:bg,color,fontSize:11,padding:"2px 8px",borderRadius:20,fontWeight:600}}>{children}</span>;
}

// Two-column button row (full width on mobile)
function BtnRow({ children }) {
  return <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:10}}>{children}</div>;
}

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [mode,setMode]         = useState("login");
  const [email,setEmail]       = useState("");
  const [password,setPassword] = useState("");
  const [loading,setLoading]   = useState(false);
  const [err,setErr]           = useState("");
  const [msg,setMsg]           = useState("");

  async function submit() {
    if (!email||!password) { setErr("Fill in all fields."); return; }
    setLoading(true); setErr(""); setMsg("");
    try {
      if (mode==="signup") {
        const {error:e} = await supabase.auth.signUp({email,password});
        if (e) throw e;
        setMsg("✅ Account created! You can now log in.");
        setMode("login");
      } else {
        const {data,error:e} = await supabase.auth.signInWithPassword({email,password});
        if (e) throw e;
        onAuth(data.user);
      }
    } catch(e) { setErr(e.message||"Something went wrong."); }
    setLoading(false);
  }
  async function forgot() {
    if (!email) { setErr("Enter your email first."); return; }
    setLoading(true);
    const {error:e} = await supabase.auth.resetPasswordForEmail(email);
    if (e) setErr(e.message); else setMsg("✅ Reset email sent!");
    setLoading(false);
  }

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#1E1B4B,#312E81,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#fff",borderRadius:24,padding:36,width:"100%",maxWidth:400,boxShadow:"0 32px 80px rgba(0,0,0,0.3)"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:56,height:56,background:"linear-gradient(135deg,#6366F1,#8B5CF6)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 16px"}}>💎</div>
          <h1 style={{margin:0,fontSize:26,fontWeight:800,color:"#0F172A"}}>WealthMap</h1>
          <p style={{margin:"6px 0 0",color:"#64748B",fontSize:14}}>Your personal finance tracker</p>
        </div>
        <div style={{display:"flex",marginBottom:24,background:"#F1F5F9",borderRadius:12,padding:4}}>
          {["login","signup"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");setMsg("");}}
              style={{flex:1,padding:"8px",borderRadius:9,border:"none",background:mode===m?"#fff":"transparent",color:mode===m?"#0F172A":"#64748B",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit",boxShadow:mode===m?"0 1px 4px rgba(0,0,0,0.1)":"none"}}>
              {m==="login"?"Log In":"Sign Up"}
            </button>
          ))}
        </div>
        {err&&<div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#B91C1C"}}>{err}</div>}
        {msg&&<div style={{background:"#F0FDF4",border:"1px solid #A7F3D0",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#065F46"}}>{msg}</div>}
        <Inp label="Email"    type="email"    value={email}    onChange={e=>setEmail(e.target.value)}    placeholder="you@example.com" />
        {mode!=="forgot"&&<Inp label="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" />}
        <Btn onClick={submit} disabled={loading} style={{width:"100%",marginBottom:12}}>
          {loading?"Please wait…":mode==="login"?"Log In":"Create Account"}
        </Btn>
        {mode==="login"&&<button onClick={()=>{setMode("forgot");setErr("");}} style={{background:"none",border:"none",color:"#6366F1",fontSize:13,cursor:"pointer",fontFamily:"inherit",width:"100%",textAlign:"center"}}>Forgot password?</button>}
        {mode==="forgot"&&<>
          <Btn onClick={forgot} disabled={loading} variant="ghost" style={{width:"100%",marginBottom:8}}>Send Reset Email</Btn>
          <button onClick={()=>setMode("login")} style={{background:"none",border:"none",color:"#6366F1",fontSize:13,cursor:"pointer",fontFamily:"inherit",width:"100%",textAlign:"center"}}>Back to login</button>
        </>}
      </div>
    </div>
  );
}

// ─── CREDIT CARD SETTINGS MODAL ───────────────────────────────────────────────
// Separate modal for CC-specific settings (bill date, cashback tiers, etc.)
function CreditCardSettingsModal({ acc, onClose, onSave }) {
  const [billDay,     setBillDay]     = useState(acc.billDay     || 1);
  const [dueDay,      setDueDay]      = useState(acc.dueDay      || 20);
  const [cbTiming,    setCbTiming]    = useState(acc.cbTiming    || "before"); // before | after
  const [cbType,      setCbType]      = useState(acc.cbType      || "unlimited"); // unlimited | limited
  const [cbTiers,     setCbTiers]     = useState(acc.cbTiers     || [{ pct:"1", limit:"" }]);
  const [cbWalletId,  setCbWalletId]  = useState(acc.cbWalletId  || "");

  // Cashback wallet needed when timing=after
  const { accounts = [] } = acc._stateRef || {};
  const nonCCAccounts = accounts.filter(a => !a.isCreditCard && !a.disabled);

  function addTier()   { setCbTiers(t => [...t, { pct:"", limit:"" }]); }
  function delTier(i)  { setCbTiers(t => t.filter((_,j) => j!==i)); }
  function updTier(i, key, val) {
    setCbTiers(t => t.map((tier, j) => j===i ? {...tier,[key]:val} : tier));
  }

  function save() {
    const validTiers = cbTiers.filter(t => parseFloat(t.pct)>0).map(t => ({
      pct: parseFloat(t.pct),
      limit: cbType==="limited" ? parseFloat(t.limit)||0 : null,
    }));
    onSave({
      ...acc,
      isCreditCard: true,
      billDay: parseInt(billDay)||1,
      dueDay:  parseInt(dueDay) ||20,
      cbTiming,
      cbType,
      cbTiers: validTiers,
      cbWalletId: cbTiming==="after" ? cbWalletId : "",
    });
    toast("Credit card settings saved");
    onClose();
  }

  return (
    <Modal title="Credit Card Settings" onClose={onClose}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Inp label="Bill Generation Day" type="number" min={1} max={31}
             value={billDay} onChange={e=>setBillDay(e.target.value)} note="1–31" />
        <Inp label="Payment Due Day" type="number" min={1} max={31}
             value={dueDay} onChange={e=>setDueDay(e.target.value)} note="1–31" />
      </div>

      <Field label="Cashback Credit Timing">
        <div style={{display:"flex",gap:8}}>
          {[["before","Before Bill Date"],["after","After Bill Date"]].map(([v,l])=>(
            <button key={v} onClick={()=>setCbTiming(v)} style={{
              flex:1, padding:"10px 8px", borderRadius:10, cursor:"pointer",
              border:`2px solid ${cbTiming===v?"#6366F1":"#E2E8F0"}`,
              background:cbTiming===v?"#EEF2FF":"#fff",
              color:cbTiming===v?"#6366F1":"#64748B",
              fontWeight:600, fontSize:13, fontFamily:"inherit",
            }}>{l}</button>
          ))}
        </div>
      </Field>

      {cbTiming==="after" && nonCCAccounts.length>0 && (
        <Sel label="Cashback Credit Account" value={cbWalletId} onChange={e=>setCbWalletId(e.target.value)}
             note="Where cashback will be deposited after billing">
          <option value="">Select account…</option>
          {nonCCAccounts.map(a=><option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
        </Sel>
      )}

      <Field label="Cashback Type">
        <div style={{display:"flex",gap:8}}>
          {[["unlimited","Unlimited"],["limited","Limited (Cap)"]].map(([v,l])=>(
            <button key={v} onClick={()=>setCbType(v)} style={{
              flex:1, padding:"10px 8px", borderRadius:10, cursor:"pointer",
              border:`2px solid ${cbType===v?"#6366F1":"#E2E8F0"}`,
              background:cbType===v?"#EEF2FF":"#fff",
              color:cbType===v?"#6366F1":"#64748B",
              fontWeight:600, fontSize:13, fontFamily:"inherit",
            }}>{l}</button>
          ))}
        </div>
      </Field>

      <Field label="Cashback Tiers" note="Define percentage tiers for this card">
        {cbTiers.map((tier, i) => (
          <div key={i} style={{display:"grid",gridTemplateColumns:cbType==="limited"?"1fr 1fr 32px":"1fr 32px",gap:8,marginBottom:8,alignItems:"end"}}>
            <Inp label={i===0?"Percentage (%)":""} type="number" min={0} max={100} step="0.1"
                 value={tier.pct} onChange={e=>updTier(i,"pct",e.target.value)}
                 placeholder="e.g. 10" style={{marginBottom:0}} />
            {cbType==="limited"&&(
              <Inp label={i===0?"Cashback Limit (₹)":""} type="number" min={0}
                   value={tier.limit} onChange={e=>updTier(i,"limit",e.target.value)}
                   placeholder="e.g. 1500" style={{marginBottom:0}} />
            )}
            <button onClick={()=>delTier(i)} style={{
              width:32, height:42, borderRadius:8, border:"1.5px solid #FECACA",
              background:"#FEF2F2", color:"#EF4444", cursor:"pointer", fontSize:16,
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
            }}>×</button>
          </div>
        ))}
        <Btn variant="ghost" size="sm" onClick={addTier} style={{width:"100%",marginTop:4}}>+ Add Tier</Btn>
      </Field>

      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>Save Settings</Btn>
      </BtnRow>
    </Modal>
  );
}

// ─── ACCOUNT MODAL  (add + edit) ─────────────────────────────────────────────
function AccountModal({ state, onClose, onSave, editAcc }) {
  const isEdit    = !!editAcc;
  const cats      = state?.accountCategories || DEFAULT.accountCategories;
  const icons     = ["🏦","💵","💳","📱","📈","📊","💰","🏧","🪙","💼","🏠","✈️","🎮","🔐","💎"];

  const [name,          setName]          = useState(editAcc?.name          || "");
  const [catId,         setCatId]         = useState(editAcc?.categoryId    || cats[0]?.id||"");
  const [cur,           setCur]           = useState(editAcc?.currency       || "INR");
  const [icon,          setIcon]          = useState(editAcc?.icon           || "🏦");
  const [opening,       setOpening]       = useState(editAcc?.openingBalance != null ? String(editAcc.openingBalance) : "");
  const [inclNW,        setInclNW]        = useState(editAcc?.includeInNetWorth ?? true);
  const [showCCSettings,setShowCCSettings]= useState(false);

  // Determine if this account is CC type based on category's isCreditCardType flag
  const selCat    = cats.find(c => c.id===catId);
  const isCCCat   = !!selCat?.isCreditCardType;

  function save(ccOverrides={}) {
    if (!name.trim()) return;
    const cat = cats.find(c=>c.id===catId);
    const ob  = parseFloat(opening)||0;
    const base = {
      name:name.trim(), categoryId:catId, currency:cur, icon,
      color:cat?.color||"#6B7280", openingBalance:ob,
      includeInNetWorth:inclNW, disabled:false,
    };
    if (isEdit) {
      onSave({...editAcc, ...base, ...ccOverrides});
    } else {
      onSave({id:uid(), ...base, ...ccOverrides});
    }
    toast(isEdit ? "Account updated" : "Account added");
    onClose();
  }

  // If CC category, open CC settings and save from there
  function handleSave() {
    if (isCCCat || editAcc?.isCreditCard) {
      setShowCCSettings(true);
    } else {
      save({ isCreditCard:false });
    }
  }

  return (
    <>
      <Modal title={isEdit?"Edit Account":"Add Account"} onClose={onClose}>
        <Sel label="Account Type" value={catId} onChange={e=>setCatId(e.target.value)}>
          {cats.map(c=><option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </Sel>
        <Inp label="Account Name" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. SBI Savings, Zerodha…" />
        <Sel label="Currency" value={cur} onChange={e=>setCur(e.target.value)}>
          {CURRENCIES.map(c=><option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.name}</option>)}
        </Sel>
        <Inp label={`Opening Balance (${cur})`} type="number" value={opening}
             onChange={e=>setOpening(e.target.value)} placeholder="0.00" />
        <Toggle label="Include in Net Worth?" checked={inclNW} onChange={setInclNW}
                note={isCCCat ? "CC payable balance will be deducted from net worth" : "Asset balance counted toward net worth"} />
        <Field label="Icon">
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {icons.map(ic=>(
              <button key={ic} onClick={()=>setIcon(ic)}
                style={{width:40,height:40,borderRadius:10,border:`2px solid ${icon===ic?"#6366F1":"#E2E8F0"}`,background:icon===ic?"#EEF2FF":"#F8FAFC",fontSize:20,cursor:"pointer"}}>{ic}</button>
            ))}
          </div>
        </Field>
        <BtnRow>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSave}>{isEdit?"Save Changes":(isCCCat?"Next: CC Settings":"Add Account")}</Btn>
        </BtnRow>
      </Modal>

      {showCCSettings && (
        <CreditCardSettingsModal
          acc={{
            ...(editAcc || {}),
            name:name.trim(), categoryId:catId, currency:cur, icon,
            color:cats.find(c=>c.id===catId)?.color||"#EF4444",
            openingBalance:parseFloat(opening)||0,
            includeInNetWorth:inclNW,
            _stateRef:{ accounts: state?.accounts||[] },
          }}
          onClose={()=>setShowCCSettings(false)}
          onSave={ccAcc => {
            // Strip internal _stateRef before saving
            const { _stateRef, ...clean } = ccAcc;
            save(clean);
          }}
        />
      )}
    </>
  );
}

// ─── ACCOUNT TYPE MODAL ───────────────────────────────────────────────────────
// Thin wrapper around AccTypeInlineManager that displays it in a Modal.
// AccTypeInlineManager is the canonical implementation; this avoids duplication.
function AccTypeModal({ state, dispatch, onClose }) {
  return (
    <Modal title="Account Types" onClose={onClose}>
      <AccTypeInlineManager state={state} dispatch={dispatch} />
      <div style={{marginTop:12}}>
        <Btn variant="ghost" onClick={onClose} style={{width:"100%"}}>Close</Btn>
      </div>
    </Modal>
  );
}

// ─── TX CATEGORY MODAL ────────────────────────────────────────────────────────
// Supports: add/delete top-level categories + manage sub-categories per parent.
// subCategories[] stored on each category object; null-safe everywhere.
// onUpdate(category) patches parent with updated subCategories[].
function TxCatModal({ kind, categories, onClose, onAdd, onDelete, onUpdate }) {
  const icons = ["🏷️","🍽️","🚗","🛍️","⚡","🏥","🎬","📚","🤝","💼","💻","🏢","🏦","📊","🏠","↩️","✈️","🎮","💊","🐾","🎁","⛽","📱","🔧","🎵","🏋️","☕","🛒","🎓"];
  const [name,    setName]    = useState("");
  const [icon,    setIcon]    = useState("🏷️");
  const [subMgr,  setSubMgr]  = useState(null);   // parent category being edited for subs
  const [subName, setSubName] = useState("");
  const [subIcon, setSubIcon] = useState("🏷️");

  function addMain() {
    if (!name.trim()) return;
    onAdd({ id:uid(), name:name.trim(), icon, subCategories:[] });
    setName(""); setIcon("🏷️");
    toast("Category added");
  }
  function openSubs(cat) { setSubMgr(cat); setSubName(""); setSubIcon("🏷️"); }
  function closeSubs()   { setSubMgr(null); }

  function addSub() {
    if (!subName.trim()) return;
    const updated = { ...subMgr, subCategories:[...(subMgr.subCategories||[]), {id:uid(),name:subName.trim(),icon:subIcon}] };
    onUpdate(updated);
    setSubMgr(updated);   // keep modal open with live data
    setSubName(""); setSubIcon("🏷️");
    toast("Sub-category added");
  }
  function delSub(subId) {
    const updated = { ...subMgr, subCategories:(subMgr.subCategories||[]).filter(s=>s.id!==subId) };
    onUpdate(updated);
    setSubMgr(updated);
    toast("Sub-category removed");
  }

  // ── Sub-category manager view ──────────────────────────────────────────────
  if (subMgr) {
    // Re-read latest from categories (onUpdate may have updated it)
    const live = categories.find(c=>c.id===subMgr.id) || subMgr;
    return (
      <Modal title={`${live.icon} ${live.name} — Sub-categories`} onClose={onClose}>
        <button onClick={closeSubs}
          style={{background:"none",border:"none",color:"#6366F1",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:14,padding:0}}>
          ← Back
        </button>
        {(live.subCategories||[]).length===0&&(
          <div style={{fontSize:13,color:"#94A3B8",marginBottom:14}}>No sub-categories yet.</div>
        )}
        {(live.subCategories||[]).map(s=>(
          <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #F1F5F9"}}>
            <span style={{fontSize:14}}>{s.icon} <strong>{s.name}</strong></span>
            <button onClick={()=>delSub(s.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>
          </div>
        ))}
        <div style={{borderTop:"1px solid #F1F5F9",paddingTop:14,marginTop:4}}>
          <div style={{fontSize:12,fontWeight:600,color:"#64748B",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Add Sub-category</div>
          <Inp label="Name" value={subName} onChange={e=>setSubName(e.target.value)} placeholder="e.g. Breakfast, Metro, Streaming…" />
          <Field label="Icon">
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {icons.map(ic=><button key={ic} onClick={()=>setSubIcon(ic)} style={{width:34,height:34,borderRadius:8,border:`2px solid ${subIcon===ic?"#6366F1":"#E2E8F0"}`,background:subIcon===ic?"#EEF2FF":"#F8FAFC",fontSize:16,cursor:"pointer"}}>{ic}</button>)}
            </div>
          </Field>
          <Btn onClick={addSub} style={{width:"100%"}}>+ Add</Btn>
        </div>
      </Modal>
    );
  }

  // ── Main list view ─────────────────────────────────────────────────────────
  return (
    <Modal title={`${kind==="expense"?"Expense":"Income"} Categories`} onClose={onClose}>
      <div style={{marginBottom:16}}>
        {categories.length===0&&<div style={{fontSize:13,color:"#94A3B8",marginBottom:10}}>None yet.</div>}
        {categories.map(c=>(
          <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{width:34,height:34,borderRadius:9,background:"#F1F5F9",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{c.icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:14}}>{c.name}</div>
              {(c.subCategories||[]).length>0&&(
                <div style={{fontSize:11,color:"#94A3B8"}}>{(c.subCategories||[]).length} sub-categor{(c.subCategories||[]).length===1?"y":"ies"}</div>
              )}
            </div>
            <button onClick={()=>openSubs(c)}
              style={{fontSize:12,padding:"4px 10px",borderRadius:8,border:"1.5px solid #C7D2FE",background:"#EEF2FF",color:"#6366F1",cursor:"pointer",fontFamily:"inherit",fontWeight:600,flexShrink:0}}>
              Sub
            </button>
            <button onClick={()=>onDelete(c.id)}
              style={{fontSize:12,padding:"4px 8px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600,flexShrink:0}}>×</button>
          </div>
        ))}
      </div>
      <div style={{borderTop:"1px solid #F1F5F9",paddingTop:16}}>
        <div style={{fontSize:12,fontWeight:600,color:"#64748B",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Add Category</div>
        <Inp label="Name" value={name} onChange={e=>setName(e.target.value)} placeholder={kind==="expense"?"e.g. Gym, Travel…":"e.g. Bonus, Gift…"} />
        <Field label="Icon">
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {icons.map(ic=><button key={ic} onClick={()=>setIcon(ic)} style={{width:34,height:34,borderRadius:8,border:`2px solid ${icon===ic?"#6366F1":"#E2E8F0"}`,background:icon===ic?"#EEF2FF":"#F8FAFC",fontSize:16,cursor:"pointer"}}>{ic}</button>)}
          </div>
        </Field>
        <BtnRow>
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
          <Btn onClick={addMain}>Add</Btn>
        </BtnRow>
      </div>
    </Modal>
  );
}

// ─── FX RATES MODAL ───────────────────────────────────────────────────────────
function FxModal({ rates, onClose, onSave }) {
  const [local,setLocal] = useState({...rates});
  return (
    <Modal title="Exchange Rates → ₹ INR" onClose={onClose}>
      <div style={{background:"#EEF2FF",border:"1.5px solid #C7D2FE",borderRadius:10,padding:12,marginBottom:16,fontSize:13,color:"#3730A3"}}>
        💡 Set how much 1 unit of each currency equals in INR.
      </div>
      {CURRENCIES.filter(c=>c.code!=="INR").map(c=>(
        <div key={c.code} style={{display:"grid",gridTemplateColumns:"52px 1fr",gap:8,marginBottom:10,alignItems:"center"}}>
          <div style={{fontWeight:700,fontSize:13,color:"#475569"}}>{c.code}</div>
          <input type="number" inputMode="decimal"
            value={local[c.code]||""}
            onChange={e=>setLocal(p=>({...p,[c.code]:parseFloat(e.target.value)||0}))}
            style={{...inputStyle}} placeholder={`1 ${c.code} = ₹?`} />
        </div>
      ))}
      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={()=>{onSave(local);toast("Exchange rates saved");onClose();}}>Save Rates</Btn>
      </BtnRow>
    </Modal>
  );
}

// ─── TRANSACTION MODAL (unified, with dispatch for APPLY_REFUND) ─────────────
// Features:
//   - Two-step account selection for expense/income:
//       Step 1: choose Account Type (from user-defined accountCategories)
//       Step 2: choose Account filtered to that type
//   - Optional sub-category: appears only when selected category has subs
//   - subCategoryId stored on tx (null when not selected)
//   - CC cashback selector, refund linking, all v5 features preserved
function TxModalWithDispatch({ state, onClose, onSave, editTx, dispatch }) {
  const isEdit      = !!editTx;
  const accounts    = (state?.accounts||[]).filter(a=>!a.disabled);
  const accTypes    = state?.accountCategories || DEFAULT.accountCategories;
  const expCats     = state?.expenseCategories || DEFAULT.expenseCategories;
  const incCats     = state?.incomeCategories  || DEFAULT.incomeCategories;
  const allExpTx    = (state?.transactions||[]).filter(t=>t.type==="expense");

  // ── Derive initial accTypeId from editTx (look up account's categoryId) ───
  const editAccTypeId = editTx?.accountId
    ? accounts.find(a=>a.id===editTx.accountId)?.categoryId || accTypes[0]?.id||""
    : accTypes[0]?.id||"";
  const editFromTypeId = editTx?.fromAccountId
    ? accounts.find(a=>a.id===editTx.fromAccountId)?.categoryId || accTypes[0]?.id||""
    : accTypes[0]?.id||"";
  const editToTypeId = editTx?.toAccountId
    ? accounts.find(a=>a.id===editTx.toAccountId)?.categoryId || accTypes[0]?.id||""
    : accTypes[0]?.id||"";

  const [type,         setType]         = useState(editTx?.type          || "expense");
  const [amount,       setAmount]       = useState(editTx ? String(editTx.amount) : "");
  // Two-step: accTypeId → accId
  const [accTypeId,    setAccTypeId]    = useState(editAccTypeId);
  const [accId,        setAccId]        = useState(editTx?.accountId     || "");
  // Transfer: separate type pickers for from/to
  const [fromTypeId,   setFromTypeId]   = useState(editFromTypeId);
  const [fromId,       setFromId]       = useState(editTx?.fromAccountId || "");
  const [toTypeId,     setToTypeId]     = useState(editToTypeId);
  const [toId,         setToId]         = useState(editTx?.toAccountId   || "");
  // Category + sub-category
  const [catId,        setCatId]        = useState(editTx?.categoryId    || expCats[0]?.id||"");
  const [subCatId,     setSubCatId]     = useState(editTx?.subCategoryId || "");
  const [note,         setNote]         = useState(editTx?.note          || "");
  const [date,         setDate]         = useState(editTx?.date          || new Date().toISOString().split("T")[0]);
  const [cbPct,        setCbPct]        = useState(editTx?.expectedCashbackPct != null ? String(editTx.expectedCashbackPct) : "");
  const [isRefundMode, setIsRefundMode] = useState(!!editTx?.linkedExpenseId);
  const [linkedExpId,  setLinkedExpId]  = useState(editTx?.linkedExpenseId || "");
  const [refundAmt,    setRefundAmt]    = useState(editTx?.refundAmount    || "");

  // ── Derived values ─────────────────────────────────────────────────────────
  const isIncome = type==="income";
  const cats     = isIncome ? incCats : expCats;

  // Accounts filtered by selected type (Step 2)
  const accsOfType     = accounts.filter(a => a.categoryId===accTypeId);
  const accsFromType   = accounts.filter(a => a.categoryId===fromTypeId);
  const accsToType     = accounts.filter(a => a.categoryId===toTypeId);

  // Auto-select first account when type changes (only if current accId not in filtered list)
  const selAcc = accounts.find(a=>a.id===accId);
  const selFrom = accounts.find(a=>a.id===fromId);
  const selTo   = accounts.find(a=>a.id===toId);
  const isCCCard = selAcc?.isCreditCard;
  const ccTiers  = isCCCard ? (selAcc.cbTiers||[]) : [];
  const cur      = selAcc?.currency || accsOfType[0]?.currency || "INR";

  // Current category object + its sub-categories
  const selCat  = cats.find(c=>c.id===catId);
  const subCats = selCat?.subCategories||[];

  // Reset accId when type changes to a type that doesn't contain it
  const handleAccTypeChange = (newTypeId) => {
    setAccTypeId(newTypeId);
    const accs = accounts.filter(a=>a.categoryId===newTypeId);
    if (!accs.find(a=>a.id===accId)) setAccId(accs[0]?.id||"");
  };
  const handleFromTypeChange = (newTypeId) => {
    setFromTypeId(newTypeId);
    const accs = accounts.filter(a=>a.categoryId===newTypeId);
    if (!accs.find(a=>a.id===fromId)) setFromId(accs[0]?.id||"");
  };
  const handleToTypeChange = (newTypeId) => {
    setToTypeId(newTypeId);
    const accs = accounts.filter(a=>a.categoryId===newTypeId);
    if (!accs.find(a=>a.id===toId)) setToId(accs[0]?.id||"");
  };
  const handleCatChange = (newCatId) => {
    setCatId(newCatId);
    setSubCatId("");  // reset sub-cat on parent change
  };

  const refundableExpenses = allExpTx
    .filter(t => !t.isRefunded || (parseFloat(t.refundedAmount)||0) < (parseFloat(t.amount)||0))
    .sort((a,b) => new Date(b.date)-new Date(a.date))
    .slice(0,20);

  function save() {
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt)) { toast("Enter a valid amount","error"); return; }
    if (type!=="transfer" && !accId) { toast("Select an account","error"); return; }
    const base = { id:editTx?.id||uid(), type, amount:amt, currency:cur, note, date, tags:[] };

    if (type==="transfer") {
      if (!fromId||!toId) { toast("Select both accounts","error"); return; }
      onSave({...base, fromAccountId:fromId, toAccountId:toId});
    } else if (type==="expense") {
      const cbPctNum = parseFloat(cbPct)||0;
      const cbAmt    = cbPctNum>0 ? parseFloat((amt*cbPctNum/100).toFixed(2)) : 0;
      onSave({
        ...base, accountId:accId, categoryId:catId,
        subCategoryId:  subCatId||null,
        isRefunded:     editTx?.isRefunded     || false,
        refundedAmount: editTx?.refundedAmount || 0,
        expectedCashbackPct: cbPctNum||undefined,
        expectedCashbackAmt: cbAmt||undefined,
      });
    } else {
      const incTx = {
        ...base, accountId:accId, categoryId:catId,
        subCategoryId:   subCatId||null,
        isRefund:        isRefundMode,
        linkedExpenseId: isRefundMode ? linkedExpId : undefined,
        refundAmount:    isRefundMode ? (parseFloat(refundAmt)||amt) : undefined,
      };
      onSave(incTx);
      if (isRefundMode && linkedExpId) {
        dispatch({ type:"APPLY_REFUND", payload:{ expenseId:linkedExpId, refundAmt:parseFloat(refundAmt)||amt }});
      }
    }
    toast(isEdit ? "Transaction updated" : "Transaction added");
    onClose();
  }

  // ── Helper: two-step account picker ───────────────────────────────────────
  // Renders: [Account Type selector] then [Account selector] filtered to type
  function TwoStepAccPicker({ label, typeId, onTypeChange, accIdVal, onAccChange, accList }) {
    const noAccounts = accList.length===0;
    return (
      <>
        <Sel label={`${label} — Account Type`} value={typeId} onChange={e=>onTypeChange(e.target.value)}>
          {accTypes.map(t=><option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
        </Sel>
        {noAccounts ? (
          <div style={{fontSize:13,color:"#94A3B8",marginBottom:16,padding:"10px 14px",background:"#F8FAFC",borderRadius:10,border:"1.5px solid #E2E8F0"}}>
            No accounts of this type yet.
          </div>
        ) : (
          <Sel label={`${label} — Account`} value={accIdVal} onChange={e=>onAccChange(e.target.value)}>
            <option value="">Select account…</option>
            {accList.map(a=><option key={a.id} value={a.id}>{a.icon} {a.name} ({a.currency||"INR"})</option>)}
          </Sel>
        )}
      </>
    );
  }

  return (
    <Modal title={isEdit?"Edit Transaction":"Add Transaction"} onClose={onClose}>
      {/* Type selector pill row */}
      <div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {Object.entries(TX_TYPES).map(([k,v])=>(
          <button key={k} onClick={()=>{setType(k);setCatId((k==="income"?incCats:expCats)[0]?.id||"");setSubCatId("");}}
            style={{flexShrink:0,padding:"9px 14px",borderRadius:20,border:`2px solid ${type===k?v.color:"#E2E8F0"}`,background:type===k?v.bg:"#fff",color:type===k?v.color:"#64748B",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      {/* Account selection — two-step for expense/income, simple for transfer */}
      {type==="transfer" ? (
        <>
          <TwoStepAccPicker label="From" typeId={fromTypeId} onTypeChange={handleFromTypeChange}
            accIdVal={fromId} onAccChange={setFromId} accList={accsFromType} />
          <TwoStepAccPicker label="To"   typeId={toTypeId}   onTypeChange={handleToTypeChange}
            accIdVal={toId}   onAccChange={setToId}   accList={accsToType} />
        </>
      ) : (
        <TwoStepAccPicker label="Account" typeId={accTypeId} onTypeChange={handleAccTypeChange}
          accIdVal={accId} onAccChange={setAccId} accList={accsOfType} />
      )}

      {/* Category (expense/income only) */}
      {type!=="transfer" && (
        <>
          <Sel label="Category" value={catId} onChange={e=>handleCatChange(e.target.value)}>
            {cats.map(c=><option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </Sel>
          {/* Sub-category: only shown when parent has subs defined */}
          {subCats.length>0 && (
            <Sel label="Sub-category (optional)" value={subCatId} onChange={e=>setSubCatId(e.target.value)}>
              <option value="">— None —</option>
              {subCats.map(s=><option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}
            </Sel>
          )}
        </>
      )}

      <Inp label={`Amount (${cur})`} type="number" inputMode="decimal"
           value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" />

      {/* CC cashback tier selector */}
      {type==="expense" && isCCCard && ccTiers.length>0 && (
        <Sel label="Expected Cashback %" value={cbPct} onChange={e=>setCbPct(e.target.value)}
             note={cbPct&&amount ? `Expected: ₹${((parseFloat(amount)||0)*parseFloat(cbPct)/100).toFixed(2)}` : ""}>
          <option value="">— No cashback —</option>
          {ccTiers.map(t=>(
            <option key={t.pct} value={t.pct}>{t.pct}%{t.limit ? ` (cap ₹${t.limit})` : ""}</option>
          ))}
        </Sel>
      )}

      {/* Refund toggle (income only) */}
      {type==="income" && !isEdit && (
        <Toggle label="Is this a refund?" checked={isRefundMode} onChange={setIsRefundMode}
                note="Link this income to an original expense" />
      )}
      {type==="income" && isRefundMode && (
        <>
          <Sel label="Original Expense" value={linkedExpId} onChange={e=>setLinkedExpId(e.target.value)}>
            <option value="">Select expense…</option>
            {refundableExpenses.map(t=>{
              const cat=(state?.expenseCategories||[]).find(c=>c.id===t.categoryId);
              const already=parseFloat(t.refundedAmount)||0;
              const pending=parseFloat(t.amount)-already;
              return (
                <option key={t.id} value={t.id}>
                  {fmtDate(t.date)} · {t.note||cat?.name||"Expense"} · {fmtCur(t.amount,t.currency||"INR")}
                  {already>0?` (₹${already.toFixed(0)} refunded)`:""} — pending ₹{pending.toFixed(0)}
                </option>
              );
            })}
          </Sel>
          <Inp label="Refund Amount" type="number" inputMode="decimal"
               value={refundAmt} onChange={e=>setRefundAmt(e.target.value)}
               placeholder="Leave blank to use full amount" />
        </>
      )}

      <Inp label="Note" value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional note…" />
      <Inp label="Date" type="date" value={date} onChange={e=>setDate(e.target.value)} />

      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{isEdit?"Save Changes":"Save"}</Btn>
      </BtnRow>
    </Modal>
  );
}

// ─── TRANSACTION ROW ──────────────────────────────────────────────────────────
function TxRow({ tx, state, onDelete, onEdit }) {
  const [open,setOpen] = useState(false);
  const accounts = state?.accounts||[];
  const acc      = accounts.find(a=>a.id===tx.accountId);
  const fromAcc  = accounts.find(a=>a.id===tx.fromAccountId);
  const toAcc    = accounts.find(a=>a.id===tx.toAccountId);
  const meta     = TX_TYPES[tx.type]||TX_TYPES.expense;
  const allCats  = [...(state?.expenseCategories||[]),...(state?.incomeCategories||[])];
  const catObj   = allCats.find(c=>c.id===tx.categoryId);
  // Sub-category: look inside the parent category's subCategories[]
  const subCatObj = tx.subCategoryId
    ? (catObj?.subCategories||[]).find(s=>s.id===tx.subCategoryId)
    : null;
  const cur      = tx.currency||acc?.currency||"INR";
  const isCredit = tx.type==="income";

  // Show refund badge on expenses with partial/full refund
  const hasRefund = tx.type==="expense" && (parseFloat(tx.refundedAmount)||0)>0;
  const netAmt    = tx.type==="expense" ? (parseFloat(tx.amount)||0)-(parseFloat(tx.refundedAmount)||0) : parseFloat(tx.amount)||0;

  return (
    <div style={{borderBottom:"1px solid #F1F5F9"}}>
      <div onClick={()=>setOpen(!open)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0",cursor:"pointer"}}>
        <div style={{width:40,height:40,borderRadius:12,background:meta.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
          {catObj?.icon||meta.icon}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:600,fontSize:14,color:"#0F172A",marginBottom:2,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            {tx.note||catObj?.name||(tx.type==="transfer"?"Transfer":"Transaction")}
            {hasRefund&&(
              <span style={{fontSize:11,background:tx.isRefunded?"#D1FAE5":"#FEF3C7",color:tx.isRefunded?"#065F46":"#92400E",padding:"1px 6px",borderRadius:10,fontWeight:600}}>
                {tx.isRefunded?"Fully Refunded":"Partial Refund"}
              </span>
            )}
            {tx.isRefund&&(
              <span style={{fontSize:11,background:"#EEF2FF",color:"#6366F1",padding:"1px 6px",borderRadius:10,fontWeight:600}}>
                ↩️ Refund
              </span>
            )}
          </div>
          <div style={{fontSize:12,color:"#94A3B8"}}>
            {tx.type==="transfer"?`${fromAcc?.name||"?"}→${toAcc?.name||"?"}`:acc?.name}
            {" · "}{fmtDate(tx.date)}
            {catObj&&tx.type!=="transfer"&&` · ${catObj.icon} ${catObj.name}`}
            {subCatObj&&` › ${subCatObj.icon} ${subCatObj.name}`}
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontWeight:700,fontSize:15,color:isCredit?"#10B981":tx.type==="transfer"?"#6366F1":"#EF4444"}}>
            {isCredit?"+":(tx.type==="transfer"?"":"−")}{fmtCur(parseFloat(tx.amount),cur)}
          </div>
          {hasRefund&&(
            <div style={{fontSize:11,color:"#10B981",fontWeight:600}}>
              net {fmtCur(netAmt,cur)}
            </div>
          )}
        </div>
      </div>
      {open&&(
        <div style={{background:"#F8FAFC",borderRadius:12,padding:14,marginBottom:12}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
            {catObj&&<Badge color="#64748B" bg="#F1F5F9">{catObj.icon} {catObj.name}</Badge>}
            {subCatObj&&<Badge color="#475569" bg="#F1F5F9">{subCatObj.icon} {subCatObj.name}</Badge>}
            {cur!=="INR"&&<Badge color="#6366F1" bg="#EEF2FF">{cur}</Badge>}
            {(tx.expectedCashbackPct)&&<Badge color="#D97706" bg="#FFFBEB">💳 CB {tx.expectedCashbackPct}% → ₹{(tx.expectedCashbackAmt||0).toFixed(2)}</Badge>}
          </div>
          {hasRefund&&(
            <div style={{fontSize:12,color:"#64748B",marginBottom:8}}>
              Refunded: {fmtCur(parseFloat(tx.refundedAmount),cur)} of {fmtCur(parseFloat(tx.amount),cur)}
            </div>
          )}
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <Btn size="sm" variant="ghost" onClick={()=>{setOpen(false);onEdit(tx);}}>✏️ Edit</Btn>
            <Btn size="sm" variant="danger" onClick={()=>{onDelete(tx.id);toast("Transaction deleted");}}>Delete</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ACCOUNT CARD (compact — actions moved to category header edit mode) ──────
function AccountCard({ acc, transactions, accounts, fxRates, tradeBalanceEffects, editMode=false, onEdit, onToggle, onCCSettings, onDelete }) {
  const isCreditCard = !!acc.isCreditCard;
  const cur          = acc.currency||"INR";
  const isDisabled   = acc.is_active === false || !!acc.disabled;

  let displayBal, subLabel;
  if (isCreditCard && acc.billDay) {
    const { outstanding, payable } = calcCCBalance(acc, transactions);
    // CC: show only Outstanding Balance + Due Amount
    displayBal = outstanding + payable;
    subLabel   = null; // handled inline below
    return (
      <Card style={{padding:"10px 12px",borderLeft:`4px solid ${isDisabled?"#CBD5E1":"#EF4444"}`,opacity:isDisabled?0.65:1}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{fontSize:16,flexShrink:0}}>{acc.icon}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13,color:isDisabled?"#94A3B8":"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{acc.name}</div>
            <div style={{fontSize:9,color:"#EF4444",fontWeight:700}}>CREDIT CARD</div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginTop:4}}>
          <div style={{background:"#FEF2F2",borderRadius:7,padding:"5px 8px"}}>
            <div style={{fontSize:9,color:"#94A3B8",marginBottom:1}}>Outstanding</div>
            <div style={{fontWeight:800,fontSize:13,color:"#EF4444"}}>{fmtCur(outstanding,cur)}</div>
          </div>
          <div style={{background:"#FFF7ED",borderRadius:7,padding:"5px 8px"}}>
            <div style={{fontSize:9,color:"#94A3B8",marginBottom:1}}>Due</div>
            <div style={{fontWeight:800,fontSize:13,color:"#D97706"}}>{fmtCur(payable,cur)}</div>
          </div>
        </div>
        {editMode&&(
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:8}}>
            <button onClick={()=>onEdit(acc)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️ Edit</button>
            {onCCSettings&&<button onClick={()=>onCCSettings(acc)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #C7D2FE",background:"#EEF2FF",color:"#6366F1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>⚙️ CC</button>}
            {isDisabled
              ? <button onClick={()=>onToggle(acc,false)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #A7F3D0",background:"#F0FDF4",color:"#065F46",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✅ Enable</button>
              : <button onClick={()=>onToggle(acc,true)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🚫 Disable</button>}
            {onDelete&&<button onClick={()=>onDelete(acc)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FFF1F2",color:"#BE123C",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>}
          </div>
        )}
      </Card>
    );
  } else {
    displayBal = calcBalance(acc.id, transactions, accounts, tradeBalanceEffects||[]);
    subLabel   = null;
  }

  const inrEquiv = cur!=="INR" ? toINR(displayBal,cur,fxRates) : null;
  const balColor = isDisabled?"#94A3B8":displayBal>=0?"#0F172A":"#EF4444";

  return (
    <Card style={{padding:"10px 12px",borderLeft:`4px solid ${isDisabled?"#CBD5E1":acc.color||"#6B7280"}`,opacity:isDisabled?0.65:1}}>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:16,flexShrink:0}}>{acc.icon}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:13,color:isDisabled?"#94A3B8":"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{acc.name}</div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:1}}>
            {isDisabled&&<span style={{fontSize:9,background:"#F1F5F9",color:"#94A3B8",padding:"1px 5px",borderRadius:8,fontWeight:700}}>OFF</span>}
            <span style={{fontSize:9,background:"#F1F5F9",color:"#64748B",padding:"1px 5px",borderRadius:8,fontWeight:600}}>{cur}</span>
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:14,fontWeight:800,color:balColor}}>{fmtCur(Math.abs(displayBal),cur)}</div>
          {inrEquiv!==null&&<div style={{fontSize:10,color:"#94A3B8"}}>≈{fmtINR(Math.abs(inrEquiv))}</div>}
        </div>
      </div>
      {editMode&&(
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:8}}>
          <button onClick={()=>onEdit(acc)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️ Edit</button>
          {isDisabled
            ? <button onClick={()=>onToggle(acc,false)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #A7F3D0",background:"#F0FDF4",color:"#065F46",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✅ Enable</button>
            : <button onClick={()=>onToggle(acc,true)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🚫 Disable</button>}
          {onDelete&&<button onClick={()=>onDelete(acc)} style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FFF1F2",color:"#BE123C",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>}
        </div>
      )}
    </Card>
  );
}



// ─── NET WORTH BREAKDOWN MODAL ────────────────────────────────────────────────
function NetWorthBreakdownModal({ state, onClose }) {
  const accounts            = state?.accounts            ||[];
  const transactions        = state?.transactions        ||[];
  const holdings            = state?.holdings            ||[];
  const fxRates             = state?.fxRates             ||DEFAULT.fxRates;
  const fixedDeposits       = state?.fixedDeposits       ||[];
  const marketPrices        = state?.marketPrices        ||{};
  const tradeBalanceEffects = state?.tradeBalanceEffects ||[];
  const accountCategories   = state?.accountCategories   ||DEFAULT.accountCategories;

  const netWorth = calcNetWorth(accounts, transactions, fxRates, holdings, fixedDeposits, marketPrices, tradeBalanceEffects, accountCategories);

  // Bank accounts
  const bankCatIds = accountCategories.filter(c=>c.name==="Bank"||c.id==="cat_bank").map(c=>c.id);
  const bankAccs = accounts.filter(a=>!a.isCreditCard&&(bankCatIds.includes(a.account_type||a.categoryId)));
  const bankTotal = bankAccs.reduce((s,a)=>s+toINR(calcBalance(a.id,transactions,accounts,tradeBalanceEffects),a.currency||"INR",fxRates),0);

  // Cash + Wallet
  const cashCatIds = accountCategories.filter(c=>["Cash","Wallet / UPI"].includes(c.name)||["cat_cash","cat_wallet"].includes(c.id)).map(c=>c.id);
  const cashAccs = accounts.filter(a=>!a.isCreditCard&&cashCatIds.includes(a.account_type||a.categoryId));
  const cashTotal = cashAccs.reduce((s,a)=>s+toINR(calcBalance(a.id,transactions,accounts,tradeBalanceEffects),a.currency||"INR",fxRates),0);

  // Stocks
  const stocks = holdings.filter(h=>h.type==="stock");
  const stockTotal = stocks.reduce((s,h)=>{
    const mp=marketPrices[h.symbol]?.current_price;
    const qty=h.quantity||0;
    return s+toINR(mp?mp*qty:(h.investedAmount||qty*(h.avgPrice||0)),h.currency||"INR",fxRates);
  },0);

  // Mutual Funds
  const mfs = holdings.filter(h=>h.type==="mf");
  const mfTotal = mfs.reduce((s,h)=>{
    const mp=marketPrices[h.symbol]?.current_price;
    const qty=h.units||0;
    return s+toINR(mp?mp*qty:(h.investedAmount||qty*(h.nav||0)),h.currency||"INR",fxRates);
  },0);

  // Fixed Deposits — show invested amount only
  const fdTotal = fixedDeposits.reduce((s,fd)=>s+toINR(parseFloat(fd.amount)||0,fd.currency||"INR",fxRates),0);

  const rows = [
    { label:"🏦 Bank Accounts",  value:bankTotal,  color:"#3B82F6" },
    { label:"📊 Stocks",         value:stockTotal, color:"#6366F1" },
    { label:"📈 Mutual Funds",   value:mfTotal,    color:"#10B981" },
    { label:"🏦 Fixed Deposits", value:fdTotal,    color:"#F59E0B" },
    { label:"💵 Cash & Wallets", value:cashTotal,  color:"#06B6D4" },
  ];
  const positiveTotal = rows.reduce((s,r)=>s+Math.max(0,r.value),0)||1;

  return (
    <Modal title="Net Worth Breakdown" onClose={onClose}>
      <div style={{textAlign:"center",marginBottom:20,padding:"16px 0",background:"linear-gradient(135deg,#EEF2FF,#F5F3FF)",borderRadius:12}}>
        <div style={{fontSize:12,color:"#64748B",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Total Net Worth</div>
        <div style={{fontSize:32,fontWeight:800,color:netWorth>=0?"#6366F1":"#EF4444"}}>{fmtINR(netWorth)}</div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {rows.map(row=>(
          <div key={row.label} style={{background:"#F8FAFC",borderRadius:10,padding:"12px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <span style={{fontWeight:600,fontSize:14,color:"#0F172A"}}>{row.label}</span>
              <span style={{fontWeight:800,fontSize:15,color:row.color}}>{fmtINR(row.value)}</span>
            </div>
            <div style={{background:"#E2E8F0",borderRadius:20,height:6,overflow:"hidden"}}>
              <div style={{background:row.color,height:"100%",borderRadius:20,width:`${Math.min(100,Math.max(0,(row.value/positiveTotal)*100))}%`,transition:"width 0.4s"}}/>
            </div>
            <div style={{fontSize:11,color:"#94A3B8",marginTop:4}}>
              {positiveTotal>0?`${((Math.max(0,row.value)/positiveTotal)*100).toFixed(1)}% of assets`:""}
            </div>
          </div>
        ))}
      </div>
      <div style={{marginTop:16}}>
        <Btn variant="ghost" onClick={onClose} style={{width:"100%"}}>Close</Btn>
      </div>
    </Modal>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashboardView({ state }) {
  const transactions        = state?.transactions        ||[];
  const holdings            = state?.holdings            ||[];
  const accounts            = state?.accounts            ||[];
  const fxRates             = state?.fxRates             ||DEFAULT.fxRates;
  const fixedDeposits       = state?.fixedDeposits       ||[];
  const marketPrices        = state?.marketPrices        ||{};
  const tradeBalanceEffects = state?.tradeBalanceEffects ||[];
  const allCats      = [...(state?.expenseCategories||[]),...(state?.incomeCategories||[])];
  const [showNWBreakdown, setShowNWBreakdown] = useState(false);

  const now      = new Date();
  const monthTxs = transactions.filter(t=>{const d=new Date(t.date+"T00:00:00");return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});

  const monthIn = monthTxs.filter(t=>t.type==="income"&&!(t.isRefund||t.is_refund)).reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const monthGrossOut = monthTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const monthRefunded = monthTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(parseFloat(t.refundedAmount)||0,t.currency,fxRates),0);
  const monthNetOut   = monthGrossOut - monthRefunded;

  // ── Centralized net worth — single source of truth ──────────────────────
  const netWorth = calcNetWorth(accounts, transactions, fxRates, holdings, fixedDeposits, marketPrices, tradeBalanceEffects, accountCategories);
  const recentTx = [...transactions].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5);

  // Portfolio value at market price if available
  const portfolio = holdings.reduce((s,h)=>{
    const mp=marketPrices[h.symbol]?.current_price;
    const qty=h.quantity||h.units||0;
    return s+toINR(mp?mp*qty:(h.investedAmount||qty*(h.avgPrice||h.nav||0)),h.currency,fxRates);
  },0);

  const cbSummary = calcCashbackSummary(transactions, accounts);
  const totalCB   = Object.values(cbSummary).reduce((s,c)=>s+Object.values(c.tiers).reduce((a,t)=>a+t.expected,0),0);

  return (
    <div>
      {/* Hero banner — Net Worth as primary metric, no separate Balance card */}
      <div style={{background:"linear-gradient(135deg,#1E1B4B,#312E81,#4C1D95)",borderRadius:20,padding:"28px 24px",marginBottom:20,color:"#fff",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,borderRadius:"50%",background:"rgba(255,255,255,0.05)"}}/>
        <div style={{position:"absolute",bottom:-60,left:-30,width:180,height:180,borderRadius:"50%",background:"rgba(255,255,255,0.03)"}}/>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:600}}>Total Net Worth</div>
        <div style={{fontSize:36,fontWeight:800,letterSpacing:"-1px",marginBottom:8}}>{fmtINR(netWorth)}</div>
        <button onClick={()=>setShowNWBreakdown(true)}
          style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.25)",borderRadius:20,padding:"5px 14px",color:"#fff",fontSize:12,cursor:"pointer",fontFamily:"inherit",fontWeight:600,marginBottom:16,backdropFilter:"blur(4px)"}}>
          📊 View Breakdown ›
        </button>
        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Month In</div><div style={{fontSize:16,fontWeight:700,color:"#A7F3D0"}}>+{fmtINR(monthIn)}</div></div>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Month Out (net)</div><div style={{fontSize:16,fontWeight:700,color:"#FCA5A5"}}>{fmtINR(monthNetOut)}</div></div>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Portfolio</div><div style={{fontSize:16,fontWeight:700,color:"#C4B5FD"}}>{fmtINR(portfolio)}</div></div>
        </div>
      </div>

      {/* Stats grid — 2 col on mobile */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Month Income",  value:fmtINR(monthIn),    color:"#10B981",bg:"#F0FDF4",icon:"📥"},
          {label:"Net Expense",   value:fmtINR(monthNetOut), color:"#EF4444",bg:"#FEF2F2",icon:"📤"},
          {label:"Net Worth",     value:fmtINR(netWorth),    color:netWorth>=0?"#6366F1":"#EF4444",bg:"#EEF2FF",icon:"💎",clickable:true},
          {label:"Expected CB",   value:fmtINR(totalCB),     color:"#D97706",bg:"#FFFBEB",icon:"💳"},
        ].map(s=>(
          <Card key={s.label} style={{background:s.bg,padding:16,cursor:s.clickable?"pointer":"default"}} onClick={s.clickable?()=>setShowNWBreakdown(true):undefined}>
            <div style={{fontSize:20,marginBottom:6}}>{s.icon}</div>
            <div style={{fontSize:18,fontWeight:800,color:s.color,marginBottom:4}}>{s.value}</div>
            <div style={{fontSize:12,color:"#64748B",fontWeight:500}}>{s.label}{s.clickable&&<span style={{color:s.color,marginLeft:4,fontSize:11}}> ›</span>}</div>
          </Card>
        ))}
      </div>

      {showNWBreakdown&&<NetWorthBreakdownModal state={state} onClose={()=>setShowNWBreakdown(false)} />}

      {/* Cashback summary if any expected */}
      {Object.keys(cbSummary).length>0&&(
        <Card style={{marginBottom:20,background:"#FFFBEB",border:"1.5px solid #FDE68A"}}>
          <div style={{fontWeight:700,color:"#92400E",marginBottom:12}}>💳 Expected Cashback Summary</div>
          {Object.entries(cbSummary).map(([cardId,card])=>(
            <div key={cardId} style={{marginBottom:12}}>
              <div style={{fontWeight:600,fontSize:13,marginBottom:6}}>{card.icon} {card.cardName}</div>
              {Object.entries(card.tiers).map(([pct,tier])=>(
                <div key={pct} style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#78350F",padding:"3px 0"}}>
                  <span>{pct}% cashback</span>
                  <span style={{fontWeight:700}}>{fmtINR(tier.expected)}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={{borderTop:"1px solid #FDE68A",paddingTop:8,display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:14}}>
            <span>Total Expected</span>
            <span style={{color:"#D97706"}}>{fmtINR(totalCB)}</span>
          </div>
        </Card>
      )}

      {/* Recent transactions */}
      <Card>
        <div style={{fontWeight:700,fontSize:16,marginBottom:16,color:"#0F172A"}}>Recent Transactions</div>
        {recentTx.length===0?(
          <div style={{textAlign:"center",color:"#94A3B8",padding:32}}><div style={{fontSize:40}}>📭</div><div style={{marginTop:8}}>No transactions yet</div></div>
        ):recentTx.map(tx=>{
          const catObj=allCats.find(c=>c.id===tx.categoryId);
          const cur=tx.currency||(accounts.find(a=>a.id===tx.accountId))?.currency||"INR";
          const isCredit=tx.type==="income";
          const netAmt = tx.type==="expense" ? (parseFloat(tx.amount)||0)-(parseFloat(tx.refundedAmount)||0) : parseFloat(tx.amount)||0;
          return (
            <div key={tx.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid #F1F5F9"}}>
              <div style={{display:"flex",gap:10,alignItems:"center",minWidth:0}}>
                <div style={{width:36,height:36,borderRadius:10,background:TX_TYPES[tx.type]?.bg||"#F1F5F9",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{catObj?.icon||TX_TYPES[tx.type]?.icon}</div>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tx.note||catObj?.name||"Transfer"}</div>
                  <div style={{fontSize:12,color:"#94A3B8"}}>{fmtDate(tx.date)}</div>
                </div>
              </div>
              <div style={{fontWeight:700,color:isCredit?"#10B981":tx.type==="transfer"?"#6366F1":"#EF4444",flexShrink:0,marginLeft:8}}>
                {isCredit?"+":(tx.type==="transfer"?"":"−")}{fmtCur(netAmt,cur)}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}


// ─── ACCOUNTS VIEW ────────────────────────────────────────────────────────────
function AccountsView({ state, dispatch }) {
  const [showAdd,     setShowAdd]     = useState(false);
  const [showAccType, setShowAccType] = useState(false);

  // Listen for FAB event
  useEffect(()=>{
    const h = ()=>setShowAdd(true);
    document.addEventListener("wm:addAccount",h);
    return ()=>document.removeEventListener("wm:addAccount",h);
  },[]);
  const [showFx,      setShowFx]      = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [ccSettings,  setCCSettings]  = useState(null);
  // Per-category edit mode: { [catId]: boolean }
  const [catEditMode, setCatEditMode] = useState({});

  const accounts            = state?.accounts          ||[];
  const accCats             = state?.accountCategories  ||DEFAULT.accountCategories;
  const transactions        = state?.transactions       ||[];
  const fxRates             = state?.fxRates            ||DEFAULT.fxRates;
  const holdings            = state?.holdings            ||[];
  const fixedDeposits       = state?.fixedDeposits       ||[];
  const marketPrices        = state?.marketPrices        ||{};
  const tradeBalanceEffects = state?.tradeBalanceEffects ||[];
  const byCategory          = accCats.map(cat=>({...cat,accounts:accounts.filter(a=>a.categoryId===cat.id)}));

  function toggleDisable(acc, shouldDisable) {
    if (shouldDisable) {
      if (!window.confirm(`Disable "${acc.name}"? It will be hidden from new transactions but historical data is preserved.`)) return;
    }
    dispatch({type:"EDIT_ACCOUNT",payload:{...acc, disabled:shouldDisable, is_active:!shouldDisable}});
    toast(shouldDisable ? "Account disabled" : "Account enabled");
  }

  function deleteAccount(acc) {
    const hasTxns = transactions.some(t => t.accountId===acc.id || t.fromAccountId===acc.id || t.toAccountId===acc.id);
    if (hasTxns) { toast(`"${acc.name}" has transactions — disable instead`, "error"); return; }
    if (!window.confirm(`Permanently delete "${acc.name}"?`)) return;
    dispatch({type:"DELETE_ACCOUNT",payload:acc.id});
    toast("Account deleted");
  }

  const netWorth = calcNetWorth(accounts, transactions, fxRates, holdings, fixedDeposits, marketPrices, tradeBalanceEffects, accountCategories);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Accounts</h2>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn variant="ghost" size="sm" onClick={()=>setShowFx(true)}>💱 FX</Btn>
          <Btn variant="ghost" size="sm" onClick={()=>setShowAccType(true)}>⚙️ Types</Btn>
          <Btn size="sm" onClick={()=>setShowAdd(true)}>+ Account</Btn>
        </div>
      </div>

      {/* Net Worth card */}
      <Card style={{background:"linear-gradient(135deg,#F0FDF4,#ECFDF5)",border:"1.5px solid #A7F3D0",marginBottom:20,padding:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:12,color:"#065F46",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Net Worth</div>
            <div style={{fontSize:28,fontWeight:800,color:netWorth>=0?"#065F46":"#EF4444"}}>{fmtINR(netWorth)}</div>
          </div>
          <div style={{fontSize:40}}>💎</div>
        </div>
        <div style={{fontSize:12,color:"#94A3B8",marginTop:6}}>Assets minus CC liabilities (accounts marked NW)</div>
      </Card>

      {accounts.length===0&&(
        <Card style={{textAlign:"center",padding:48}}>
          <div style={{fontSize:48}}>🏦</div>
          <div style={{marginTop:12,fontWeight:700,fontSize:16,color:"#475569"}}>No accounts yet</div>
          <div style={{marginTop:6,fontSize:14,color:"#94A3B8"}}>Add your first account to get started</div>
          <div style={{marginTop:20}}><Btn onClick={()=>setShowAdd(true)}>+ Add Account</Btn></div>
        </Card>
      )}
      {byCategory.map(cat=>cat.accounts.length>0&&(
        <div key={cat.id} style={{marginBottom:24}}>
          {/* Category heading with Edit toggle */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:18}}>{cat.icon}</span>
            <span style={{fontWeight:700,color:"#475569",fontSize:14,textTransform:"uppercase",letterSpacing:"0.05em",flex:1}}>{cat.name}</span>
            {catEditMode[cat.id] ? (
              <button onClick={()=>setCatEditMode(p=>({...p,[cat.id]:false}))}
                style={{fontSize:12,padding:"3px 10px",borderRadius:7,border:"1.5px solid #A7F3D0",background:"#F0FDF4",color:"#065F46",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>✓ Done</button>
            ) : (
              <button onClick={()=>setCatEditMode(p=>({...p,[cat.id]:true}))}
                style={{fontSize:12,padding:"3px 10px",borderRadius:7,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️ Edit</button>
            )}
          </div>
          {/* Compact 2-col grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(min(100%,180px),1fr))",gap:8}}>
            {cat.accounts.map(acc=>(
              <AccountCard key={acc.id} acc={acc} transactions={transactions} accounts={accounts} fxRates={fxRates}
                tradeBalanceEffects={tradeBalanceEffects}
                editMode={!!catEditMode[cat.id]}
                onEdit={a=>setEditing(a)}
                onToggle={toggleDisable}
                onDelete={deleteAccount}
                onCCSettings={a=>setCCSettings(a)}
              />
            ))}
          </div>
        </div>
      ))}

      {showAdd&&<AccountModal state={state} onClose={()=>setShowAdd(false)} onSave={a=>{dispatch({type:"ADD_ACCOUNT",payload:a});}} />}
      {editing&&<AccountModal state={state} editAcc={editing} onClose={()=>setEditing(null)} onSave={a=>{dispatch({type:"EDIT_ACCOUNT",payload:a});setEditing(null);}} />}
      {showAccType&&<AccTypeModal state={state} dispatch={dispatch} onClose={()=>setShowAccType(false)} />}
      {showFx&&<FxModal rates={fxRates} onClose={()=>setShowFx(false)} onSave={r=>dispatch({type:"SET_FX",payload:r})} />}
      {ccSettings&&(
        <CreditCardSettingsModal
          acc={{...ccSettings, _stateRef:{accounts}}}
          onClose={()=>setCCSettings(null)}
          onSave={updated=>{const{_stateRef,...clean}=updated;dispatch({type:"EDIT_ACCOUNT",payload:clean});setCCSettings(null);}}
        />
      )}
    </div>
  );
}

// ─── TRANSACTIONS VIEW ────────────────────────────────────────────────────────
function TransactionsView({ state, dispatch }) {
  const [showAdd,    setShowAdd]    = useState(false);
  const [editTx,     setEditTx]     = useState(null);
  const [showExpCat, setShowExpCat] = useState(false);
  const [showIncCat, setShowIncCat] = useState(false);
  const [filter,     setFilter]     = useState("all");
  const [search,     setSearch]     = useState("");
  const [month,      setMonth]      = useState("");

  const transactions = state?.transactions     ||[];
  const expCats      = state?.expenseCategories||DEFAULT.expenseCategories;
  const incCats      = state?.incomeCategories  ||DEFAULT.incomeCategories;

  const filtered = useMemo(()=>transactions.filter(t=>{
    if (filter!=="all"&&t.type!==filter) return false;
    if (search) {
      const allC=[...expCats,...incCats];
      const catN=allC.find(c=>c.id===t.categoryId)?.name||"";
      if (!`${t.note||""} ${catN}`.toLowerCase().includes(search.toLowerCase())) return false;
    }
    if (month){const d=new Date(t.date+"T00:00:00");if(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`!==month)return false;}
    return true;
  }).sort((a,b)=>new Date(b.date)-new Date(a.date)),[transactions,filter,search,month,expCats,incCats]);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Transactions</h2>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn variant="ghost" size="sm" onClick={()=>setShowExpCat(true)}>🏷️ Expense</Btn>
          <Btn variant="ghost" size="sm" onClick={()=>setShowIncCat(true)}>🏷️ Income</Btn>
          <Btn onClick={()=>setShowAdd(true)}>+ Add</Btn>
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search…"
          style={{flex:1,minWidth:140,border:"1.5px solid #E2E8F0",borderRadius:10,padding:"10px 14px",fontSize:16,outline:"none",fontFamily:"inherit"}} />
        <input type="month" value={month} onChange={e=>setMonth(e.target.value)}
          style={{border:"1.5px solid #E2E8F0",borderRadius:10,padding:"10px 12px",fontSize:16,outline:"none",fontFamily:"inherit"}} />
      </div>

      {/* Filter pills: scrollable row on mobile */}
      <div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {[["all","All"],...Object.entries(TX_TYPES).map(([k,v])=>[k,v.label])].map(([k,l])=>(
          <button key={k} onClick={()=>setFilter(k)}
            style={{flexShrink:0,padding:"7px 14px",borderRadius:20,border:`1.5px solid ${filter===k?"#6366F1":"#E2E8F0"}`,background:filter===k?"#EEF2FF":"#fff",color:filter===k?"#6366F1":"#64748B",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>{l}</button>
        ))}
      </div>

      <Card style={{padding:"0 16px"}}>
        {filtered.length===0?(
          <div style={{textAlign:"center",color:"#94A3B8",padding:48}}><div style={{fontSize:40}}>📭</div><div style={{marginTop:8}}>No transactions found</div></div>
        ):filtered.map(tx=>(
          <TxRow key={tx.id} tx={tx} state={state}
            onDelete={id=>dispatch({type:"DELETE_TX",payload:id})}
            onEdit={t=>setEditTx(t)} />
        ))}
      </Card>

      {showAdd&&<TxModalWithDispatch state={state} dispatch={dispatch} onClose={()=>setShowAdd(false)} onSave={tx=>dispatch({type:"ADD_TX",payload:tx})} />}
      {editTx&&<TxModalWithDispatch state={state} dispatch={dispatch} editTx={editTx} onClose={()=>setEditTx(null)} onSave={tx=>{dispatch({type:"EDIT_TX",payload:tx});setEditTx(null);}} />}
      {showExpCat&&<TxCatModal kind="expense" categories={expCats} onClose={()=>setShowExpCat(false)} onAdd={c=>dispatch({type:"ADD_EXP_CAT",payload:c})} onDelete={id=>dispatch({type:"DEL_EXP_CAT",payload:id})} onUpdate={c=>dispatch({type:"UPD_EXP_CAT",payload:c})} />}
      {showIncCat&&<TxCatModal kind="income"  categories={incCats} onClose={()=>setShowIncCat(false)} onAdd={c=>dispatch({type:"ADD_INC_CAT",payload:c})} onDelete={id=>dispatch({type:"DEL_INC_CAT",payload:id})} onUpdate={c=>dispatch({type:"UPD_INC_CAT",payload:c})} />}
    </div>
  );
}


// ─── SYMBOL SEARCH via Yahoo Finance autocomplete ────────────────────────────
// Uses Yahoo Finance's autocomplete endpoint via allorigins proxy.
// Works from localhost and production alike.
async function searchGoogleFinance(query) {
  if (!query || query.length < 1) return [];
  try {
    const yUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`;
    const raw = await _fetchViaProxy(yUrl);
    if (!raw) return [];
    let data;
    try { data = JSON.parse(raw); } catch { return []; }
    return (data?.quotes || [])
      .filter(q => q.symbol && (q.exchange || q.exchDisp))
      .map(q => ({
        symbol:   q.symbol,
        name:     q.longname || q.shortname || q.symbol,
        exchange: q.exchDisp || q.exchange || "",
        type:     (q.quoteType || "").toLowerCase().includes("fund") ||
                  (q.quoteType || "").toLowerCase().includes("etf")  ? "mf" : "stock",
      }));
  } catch { return []; }
}

// ─── STOCKS MASTER MODAL ─────────────────────────────────────────────────────
// Manages the Stocks Master Table. Shows all stocks, allows search-add, edit name, delete.
function StocksMasterModal({ state, dispatch, onClose }) {
  const stocks = state?.stocks || [];
  const [search, setSearch] = useState("");
  const [query,  setQuery]  = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualType, setManualType] = useState("stock");
  const [editStock, setEditStock] = useState(null);
  const [editName,  setEditName]  = useState("");

  const searchTimer = useRef(null);

  function onQueryChange(val) {
    setQuery(val);
    setSearchFailed(false);
    setSuggestions([]);
    clearTimeout(searchTimer.current);
    if (val.length < 1) return;
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const results = await searchGoogleFinance(val);
      setSuggestions(results);
      setSearching(false);
      if (results.length === 0) setSearchFailed(true);
    }, 400);
  }

  function addManualStock() {
    const sym = query.trim().toUpperCase();
    const nm  = manualName.trim() || sym;
    if (!sym) { toast("Enter a symbol", "error"); return; }
    if (stocks.find(st => st.symbol === sym)) { toast(`${sym} already in master`, "error"); return; }
    dispatch({ type:"ADD_STOCK", payload:{ id:uid(), symbol:sym, name:nm, type:manualType, exchange:"" } });
    toast(`${sym} added to Stocks Master`);
    setQuery(""); setManualName(""); setSuggestions([]); setSearchFailed(false);
  }

  function addStock(s) {
    if (stocks.find(st => st.symbol === s.symbol)) { toast(`${s.symbol} already in master`, "error"); return; }
    dispatch({ type:"ADD_STOCK", payload:{ id:uid(), symbol:s.symbol, name:s.name, type:s.type||"stock", exchange:s.exchange } });
    toast(`${s.symbol} added to Stocks Master`);
    setQuery(""); setSuggestions([]);
  }

  function deleteStock(st) {
    const inUse = (state?.investmentTx||[]).some(t => t.symbol===st.symbol);
    if (inUse) { toast(`${st.symbol} has trades — cannot delete`, "error"); return; }
    if (!window.confirm(`Remove ${st.symbol} from Stocks Master?`)) return;
    dispatch({ type:"DELETE_STOCK", payload: st.id });
    toast(`${st.symbol} removed`);
  }

  function startEditName(st) { setEditStock(st); setEditName(st.name); }

  function saveEditName() {
    if (!editName.trim()) return;
    dispatch({ type:"EDIT_STOCK", payload:{...editStock, name:editName.trim()} });
    // Also update holdings name
    (state?.holdings||[]).filter(h=>h.symbol===editStock.symbol).forEach(h=>{
      dispatch({ type:"RENAME_STOCK", payload:{oldSymbol:editStock.symbol, newSymbol:editStock.symbol, newName:editName.trim()} });
    });
    toast("Name updated"); setEditStock(null);
  }

  const filtered = stocks.filter(st =>
    !search || st.symbol.toLowerCase().includes(search.toLowerCase()) || st.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal title="📚 Stocks Master" onClose={onClose}>
      {/* Search to add new */}
      <div style={{position:"relative",marginBottom:16}}>
        <label style={{display:"block",fontSize:12,fontWeight:600,color:"#64748B",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Search &amp; Add Symbol</label>
        <input value={query} onChange={e=>onQueryChange(e.target.value)}
          placeholder="Type NSE:ITBEES, TCS, ICICI…"
          style={{...inputStyle,paddingRight:40}}
          onFocus={e=>e.target.style.borderColor="#6366F1"}
          onBlur={e=>e.target.style.borderColor="#E2E8F0"} />
        {searching && <div style={{position:"absolute",right:12,top:38,fontSize:12,color:"#94A3B8"}}>🔍…</div>}
        {suggestions.length>0 && (
          <div style={{position:"absolute",left:0,right:0,top:"100%",background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:10,zIndex:500,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",maxHeight:240,overflowY:"auto"}}>
            {suggestions.map((s,i)=>(
              <button key={i} onClick={()=>addStock(s)}
                style={{display:"block",width:"100%",textAlign:"left",padding:"10px 14px",border:"none",background:"none",cursor:"pointer",borderBottom:i<suggestions.length-1?"1px solid #F1F5F9":"none",fontFamily:"inherit"}}>
                <div style={{fontWeight:700,fontSize:13,color:"#0F172A"}}>{s.exchange?`${s.exchange}:${s.symbol}`:s.symbol}</div>
                <div style={{fontSize:11,color:"#64748B"}}>{s.name} · {s.type==="mf"?"Mutual Fund":"Stock"}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Manual add fallback when search returns nothing */}
      {searchFailed && query.length>=2 && (
        <div style={{background:"#F8FAFC",border:"1.5px solid #E2E8F0",borderRadius:10,padding:12,marginBottom:12}}>
          <div style={{fontSize:12,color:"#64748B",marginBottom:8}}>⚠️ Online search unavailable — add manually:</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{flex:"1 1 140px"}}>
              <div style={{fontSize:11,color:"#94A3B8",marginBottom:3}}>Symbol (from search box)</div>
              <div style={{fontWeight:700,fontSize:13,color:"#0F172A",padding:"6px 10px",background:"#EEF2FF",borderRadius:7}}>{query.toUpperCase()}</div>
            </div>
            <div style={{flex:"2 1 180px"}}>
              <div style={{fontSize:11,color:"#94A3B8",marginBottom:3}}>Name</div>
              <input value={manualName} onChange={e=>setManualName(e.target.value)} placeholder="e.g. Tata Consultancy Services"
                style={{...inputStyle,padding:"6px 10px",fontSize:13}}
                onFocus={e=>e.target.style.borderColor="#6366F1"} onBlur={e=>e.target.style.borderColor="#E2E8F0"} />
            </div>
            <div style={{flex:"1 1 100px"}}>
              <div style={{fontSize:11,color:"#94A3B8",marginBottom:3}}>Type</div>
              <select value={manualType} onChange={e=>setManualType(e.target.value)}
                style={{...inputStyle,padding:"6px 10px",fontSize:13}}>
                <option value="stock">Stock</option>
                <option value="mf">Mutual Fund</option>
              </select>
            </div>
            <button onClick={addManualStock}
              style={{alignSelf:"flex-end",padding:"7px 14px",borderRadius:8,border:"none",background:"#6366F1",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
              + Add
            </button>
          </div>
        </div>
      )}

      {/* Filter existing */}
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Filter master list…"
        style={{...inputStyle,marginBottom:12}}
        onFocus={e=>e.target.style.borderColor="#6366F1"}
        onBlur={e=>e.target.style.borderColor="#E2E8F0"} />

      {filtered.length===0 ? (
        <div style={{textAlign:"center",padding:32,color:"#94A3B8"}}>
          <div style={{fontSize:36}}>📚</div>
          <div style={{marginTop:8}}>No stocks in master yet</div>
          <div style={{fontSize:12,marginTop:4}}>Search above to add stocks (or add manually if offline)</div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:0}}>
          {filtered.map(st=>(
            <div key={st.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid #F1F5F9"}}>
              <div style={{flex:1,minWidth:0}}>
                {editStock?.id===st.id ? (
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <input value={editName} onChange={e=>setEditName(e.target.value)}
                      style={{...inputStyle,padding:"6px 10px",fontSize:13,flex:1}}
                      onFocus={e=>e.target.style.borderColor="#6366F1"}
                      onBlur={e=>e.target.style.borderColor="#E2E8F0"} />
                    <button onClick={saveEditName} style={{padding:"5px 10px",borderRadius:7,border:"none",background:"#6366F1",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:12}}>✓</button>
                    <button onClick={()=>setEditStock(null)} style={{padding:"5px 10px",borderRadius:7,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#64748B",cursor:"pointer",fontSize:12}}>✕</button>
                  </div>
                ) : (
                  <>
                    <div style={{fontWeight:700,fontSize:13,color:"#0F172A"}}>{st.symbol}</div>
                    <div style={{fontSize:11,color:"#64748B"}}>{st.name} · {st.exchange||""} · {st.type==="mf"?"MF":"Stock"}</div>
                  </>
                )}
              </div>
              {editStock?.id!==st.id && (
                <>
                  <button onClick={()=>startEditName(st)}
                    style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️</button>
                  <button onClick={()=>deleteStock(st)}
                    style={{fontSize:11,padding:"3px 8px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{marginTop:16}}>
        <Btn variant="ghost" onClick={onClose} style={{width:"100%"}}>Close</Btn>
      </div>
    </Modal>
  );
}

// ─── INVESTMENT MODAL (Trade Entry) ──────────────────────────────────────────
// Features: stock/MF/FD, money-source account, symbol search via Google Finance,
//           stocks master enforcement, NAV label for MF, edit mode
function InvestModal({ state, onClose, onSave, editTx }) {
  const isEdit   = !!editTx;
  const allAccs  = (state?.accounts||[]).filter(a=>!a.disabled);
  const accTypes = state?.accountCategories || DEFAULT.accountCategories;
  const investType = accTypes.find(t => t.isInvestmentType);
  const investAccs  = investType ? allAccs.filter(a=>a.categoryId===investType.id) : allAccs;
  const sourceAccs  = investType ? allAccs.filter(a=>a.categoryId!==investType.id) : allAccs;
  const masterStocks = state?.stocks || [];

  const [txType,  setTxType]  = useState(editTx?.type       || "buy");
  const [invType, setInvType] = useState(editTx?.invType     || "stock");
  const [symbol,  setSymbol]  = useState(editTx?.symbol      || "");
  const [name,    setName]    = useState(editTx?.name        || "");
  const [qty,     setQty]     = useState(editTx ? String(editTx.quantity) : "");
  const [price,   setPrice]   = useState(editTx ? String(editTx.price)    : "");
  const [cur,     setCur]     = useState(editTx?.currency    || "INR");
  const [date,    setDate]    = useState(editTx?.date        || new Date().toISOString().split("T")[0]);
  const [invAccId,setInvAccId]= useState(editTx?.accountId   || investAccs[0]?.id||"");
  const [srcAccId,setSrcAccId]= useState(editTx?.sourceAccountId || sourceAccs[0]?.id||"");
  const [brok,    setBrok]    = useState(editTx ? String(editTx.brokerage||0) : "0");
  const [note,    setNote]    = useState(editTx?.note        || "");
  const [fetching,setFetching]= useState(false);
  const [priceHint,setPriceHint]=useState("");
  const [symQuery,  setSymQuery]    = useState(editTx?.symbol||"");
  const [symSugg,   setSymSugg]     = useState([]);
  const [showSugg, setShowSugg]     = useState(false);

  const [fdAmount,   setFdAmount]    = useState(editTx?.fdAmount||"");
  const [fdInvDate,  setFdInvDate]   = useState(editTx?.investedDate||date);
  const [fdMatDate,  setFdMatDate]   = useState(editTx?.maturityDate||"");
  const [fdRate,     setFdRate]      = useState(editTx?.interestRate||"");

  const isFD  = invType==="fd";
  const isMF  = invType==="mf";
  const total = isFD ? parseFloat(fdAmount)||0 : (parseFloat(qty)||0)*(parseFloat(price)||0);
  const curObj= CURRENCIES.find(c=>c.code===cur)||CURRENCIES[0];
  const existingHolding = (state?.holdings||[]).find(h=>
    h.symbol===symbol && h.accountId===invAccId && h.type===invType);

  // Build unique stock names from existing trades for autocomplete
  const existingStocks = useMemo(() => {
    const seen = {};
    (state?.investmentTx||[]).forEach(t=>{
      if(t.symbol && !seen[t.symbol]) seen[t.symbol] = t.name||t.symbol;
    });
    (state?.holdings||[]).forEach(h=>{
      if(h.symbol && !seen[h.symbol]) seen[h.symbol] = h.name||h.symbol;
    });
    return Object.entries(seen).map(([symbol,name])=>({symbol,name}));
  }, [state?.investmentTx, state?.holdings]);

  function onSymQueryChange(val) {
    setSymQuery(val);
    setSymbol(val.toUpperCase());
    if (val.length < 1) { setSymSugg([]); setShowSugg(false); return; }
    // Autocomplete from existing trades
    const lower = val.toLowerCase();
    const matches = existingStocks.filter(st=>
      st.symbol.toLowerCase().includes(lower) ||
      st.name.toLowerCase().includes(lower)
    );
    setSymSugg(matches);
    setShowSugg(matches.length > 0);
  }

  function selectSymbol(s) {
    const sym = (s.symbol||"").toUpperCase();
    setSymbol(sym); setSymQuery(sym);
    if (s.name) setName(s.name);
    setShowSugg(false); setSymSugg([]);
  }

  function lookupPrice() {
    setPriceHint("Live price unavailable — enter price manually");
  }

  function save() {
    if (isFD) {
      if (!fdAmount||!fdInvDate||!fdMatDate||!fdRate) { toast("Fill all FD fields","error"); return; }
      const fd = {
        id:editTx?.id||uid(), type:"fd", invType:"fd",
        name:name||symbol||"Fixed Deposit", symbol:symbol||"FD",
        amount:parseFloat(fdAmount), investedDate:fdInvDate, maturityDate:fdMatDate,
        interestRate:parseFloat(fdRate), accountId:invAccId, sourceAccountId:srcAccId,
        currency:cur, date:fdInvDate, note,
      };
      onSave({fd,isFD:true}); toast(isEdit?"FD updated":"FD added"); onClose(); return;
    }
    if (!symbol||!qty||!price) { toast("Fill symbol, qty, price","error"); return; }
    // No stocks master enforcement — any symbol is allowed
    const q=parseFloat(qty), p=parseFloat(price), b=parseFloat(brok)||0;
    const holdingId = existingHolding?.id || editTx?.holdingId || uid();
    const itx = {
      id:editTx?.id||uid(), holdingId, type:txType,
      invType, symbol, name:name||symbol,
      quantity:q, price:p, currency:cur, date, accountId:invAccId,
      sourceAccountId:srcAccId, brokerage:b, note,
    };
    const newHolding = (!existingHolding && txType==="buy") ? {
      id:holdingId, symbol, name:name||symbol,
      type:invType, accountId:invAccId, currency:cur,
      lots:[], quantity:0, units:0, avgPrice:0, investedAmount:0,
    } : null;
    onSave({itx,newHolding,isFD:false});
    toast(isEdit?"Trade updated":txType==="buy"?"Buy recorded":"Sell recorded");
    onClose();
  }

  return (
    <Modal title={isEdit?"Edit Trade":"Add Trade / Investment"} onClose={onClose}>
      <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",paddingBottom:2}}>
        {[["stock","📊 Stock"],["mf","📈 Mutual Fund"],["fd","🏦 Fixed Deposit"]].map(([v,l])=>(
          <button key={v} onClick={()=>setInvType(v)}
            style={{flexShrink:0,padding:"7px 14px",borderRadius:18,border:`2px solid ${invType===v?"#6366F1":"#E2E8F0"}`,background:invType===v?"#EEF2FF":"#fff",color:invType===v?"#6366F1":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>
      {!isFD&&(
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {[["buy","📥 Buy","#10B981","#F0FDF4"],["sell","📤 Sell","#EF4444","#FEF2F2"]].map(([v,l,col,bg])=>(
            <button key={v} onClick={()=>setTxType(v)}
              style={{flex:1,padding:"9px",borderRadius:10,border:`2px solid ${txType===v?col:"#E2E8F0"}`,background:txType===v?bg:"#fff",color:txType===v?col:"#64748B",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
          ))}
        </div>
      )}
      {!isFD && (investAccs.length>0
        ? <Sel label="Investment Account (Broker)" value={invAccId} onChange={e=>setInvAccId(e.target.value)}>
            {investAccs.map(a=><option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
          </Sel>
        : <div style={{background:"#FFFBEB",border:"1.5px solid #FDE68A",borderRadius:10,padding:10,marginBottom:14,fontSize:13,color:"#92400E"}}>
            ⚠️ No investment accounts yet — create one under Accounts → Account Types → Investment
          </div>
      )}
      {(txType==="buy"||isFD)&&(
        <Sel label={isFD ? "Source Account (Bank / Wallet)" : "Money Source Account"} value={srcAccId} onChange={e=>setSrcAccId(e.target.value)}>
          <option value="">— None / Unknown —</option>
          {(isFD ? allAccs : sourceAccs).map(a=><option key={a.id} value={a.id}>{a.icon} {a.name} ({a.currency||"INR"})</option>)}
        </Sel>
      )}
      {isFD ? (
        <>
          <Inp label="FD Name / Bank" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. SBI FD 2024" />
          <Inp label="Invested Amount" type="number" value={fdAmount} onChange={e=>setFdAmount(e.target.value)} placeholder="0.00" />
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Inp label="Invested Date" type="date" value={fdInvDate} onChange={e=>setFdInvDate(e.target.value)} />
            <Inp label="Maturity Date" type="date" value={fdMatDate} onChange={e=>setFdMatDate(e.target.value)} />
          </div>
          <Inp label="Interest Rate (% p.a.)" type="number" value={fdRate} onChange={e=>setFdRate(e.target.value)} placeholder="e.g. 7.5" />
          {fdAmount&&fdRate&&fdInvDate&&fdMatDate&&(()=>{
            const r=calcFDReturns({amount:fdAmount,interestRate:fdRate,investedDate:fdInvDate,maturityDate:fdMatDate});
            return <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:10,padding:12,marginBottom:14,fontSize:13}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#64748B"}}>Interest (at maturity)</span><strong style={{color:"#10B981"}}>+{fmtCur(r.interest,cur)}</strong></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#64748B"}}>Maturity Value</span><strong>{fmtCur(r.maturityValue,cur)}</strong></div>
              <div style={{fontSize:11,color:"#94A3B8",marginTop:6}}>FD shows invested amount only. Add interest as income on maturity.</div>
            </div>;
          })()}
        </>
      ) : (
        <>
          <div style={{position:"relative",marginBottom:14}}>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"#64748B",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>
              {isMF?"Fund Code / NAV Symbol":"Symbol (e.g. NSE:ITBEES, TCS)"}
            </label>
            <div style={{display:"flex",gap:6}}>
              <div style={{flex:1,position:"relative"}}>
                <input value={symQuery} onChange={e=>onSymQueryChange(e.target.value)}
                  onFocus={()=>symSugg.length>0&&setShowSugg(true)}
                  onBlur={()=>setTimeout(()=>setShowSugg(false),200)}
                  placeholder={isMF?"MUTF_IN:ICIC_PRUN, Mirae…":"NSE:ITBEES, TCS, RELIANCE…"}
                  style={{...inputStyle}} />

                {showSugg&&symSugg.length>0&&(
                  <div style={{position:"absolute",left:0,right:0,top:"100%",background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:10,zIndex:600,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",maxHeight:200,overflowY:"auto"}}>
                    {symSugg.map((s,i)=>(
                      <button key={i} onMouseDown={()=>selectSymbol(s)}
                        style={{display:"block",width:"100%",textAlign:"left",padding:"9px 12px",border:"none",background:"#F8FAFC",cursor:"pointer",borderBottom:i<symSugg.length-1?"1px solid #F1F5F9":"none",fontFamily:"inherit"}}>
                        <div style={{fontWeight:700,fontSize:13,color:"#0F172A"}}>{s.symbol}</div>
                        <div style={{fontSize:11,color:"#64748B"}}>{s.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

            </div>
            {symbol&&symSugg.length===0&&symbol.length>0&&(
              <div style={{fontSize:11,color:"#6366F1",marginTop:3}}>✅ {symbol} — type name below or leave blank</div>
            )}
          </div>
          <Inp label="Full Name (optional)" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Tata Consultancy Services" />
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Inp label={isMF?"Units":"Shares"} type="number" inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} />
            <Inp label={isMF?`NAV (${cur})`:`Price (${cur})`} type="number" inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} />
          </div>
          {total>0&&(
            <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:10,padding:10,marginBottom:14,fontSize:13,color:"#065F46"}}>
              Total: <strong>{curObj.symbol}{fmtNum(total)}</strong>
              {cur!=="INR"&&state?.fxRates?.[cur]?` ≈ ${fmtINR(total*state.fxRates[cur])}`:""} 
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Inp label={`Brokerage (${cur})`} type="number" inputMode="decimal" value={brok} onChange={e=>setBrok(e.target.value)} />
            <Inp label="Trade Date" type="date" value={date} onChange={e=>setDate(e.target.value)} />
          </div>
        </>
      )}
      <Sel label="Currency" value={cur} onChange={e=>setCur(e.target.value)}>
        {CURRENCIES.map(c=><option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.name}</option>)}
      </Sel>
      <Inp label="Note" value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional…" />
      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant={txType==="sell"?"danger":"success"} onClick={save}>{isEdit?"Save Changes":isFD?"Add FD":txType==="buy"?"Buy":"Sell"}</Btn>
      </BtnRow>
    </Modal>
  );
}

// ─── TRADE HISTORY MODAL (per-symbol) ────────────────────────────────────────
// Opens from HoldingRow "View Trade History" button or from global history tab.
function TradeHistoryModal({ symbol, holding, investmentTx, accounts, state, dispatch, onClose }) {
  const [editTrade, setEditTrade] = useState(null);
  // Fix: filter by symbol OR holdingId to catch all trades for this stock
  const trades = (investmentTx||[])
    .filter(t => {
      if (holding) return t.holdingId===holding.id || t.symbol===holding.symbol;
      return t.symbol===symbol;
    })
    .sort((a,b)=>new Date(b.date)-new Date(a.date));

  function deleteTrade(t) {
    if (!window.confirm("Delete this trade? Holdings and balances will be recalculated.")) return;
    dispatch({type:"DELETE_INVESTMENT_TX", payload:t.id});
    toast("Trade deleted — holdings recalculated");
  }

  return (
    <Modal title={`Trade History${symbol?` · ${symbol}`:""}`} onClose={onClose}>
      {trades.length===0?(
        <div style={{textAlign:"center",padding:32,color:"#94A3B8"}}>
          <div style={{fontSize:40}}>📭</div>
          <div style={{marginTop:8,fontWeight:600}}>No trades yet</div>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:0}}>
          {trades.map(t=>{
            const srcAcc = (accounts||[]).find(a=>a.id===t.sourceAccountId);
            const total  = (parseFloat(t.quantity)||0)*(parseFloat(t.price)||0);
            const cur    = t.currency||"INR";
            return (
              <div key={t.id} style={{padding:"12px 0",borderBottom:"1px solid #F1F5F9"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                  <span style={{fontSize:11,background:t.type==="buy"?"#F0FDF4":"#FEF2F2",color:t.type==="buy"?"#10B981":"#EF4444",padding:"3px 8px",borderRadius:10,fontWeight:700,flexShrink:0,marginTop:2}}>{t.type.toUpperCase()}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:"#0F172A"}}>{fmtNum(t.quantity)} × {fmtCur(t.price,cur)}</div>
                    <div style={{fontSize:12,color:"#64748B",marginTop:2}}>{fmtDate(t.date)}{srcAcc?` · ${srcAcc.name}`:""}{t.note?` · ${t.note}`:""}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:t.type==="buy"?"#EF4444":"#10B981"}}>
                      {t.type==="buy"?"−":"+"}{ fmtCur(total,cur)}
                    </div>
                    <div style={{fontSize:10,color:"#94A3B8",marginTop:2}}>total</div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={()=>setEditTrade(t)}
                    style={{flex:1,fontSize:12,padding:"7px 0",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                    ✏️ Edit
                  </button>
                  <button onClick={()=>deleteTrade(t)}
                    style={{flex:1,fontSize:12,padding:"7px 0",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                    🗑️ Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{marginTop:16}}>
        <Btn variant="ghost" onClick={onClose} style={{width:"100%"}}>Close</Btn>
      </div>
      {editTrade&&(
        <InvestModal
          state={state}
          editTx={editTrade}
          onClose={()=>setEditTrade(null)}
          onSave={({itx})=>{
            dispatch({type:"EDIT_INVESTMENT_TX",payload:itx});
            setEditTrade(null);
            toast("Trade updated — holdings recalculated");
          }}
        />
      )}
    </Modal>
  );
}

// ─── HOLDINGS ROW (expandable — View Trade History, no inline Edit) ───────────
function HoldingRow({ holding, investmentTx, accounts, state, dispatch, openId, onToggle, bulkSelectMode=false, isSelected=false, onBulkSelect }) {
  const isOpen = openId===holding.id;
  const [showHistory, setShowHistory] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [renameSymbol, setRenameSymbol] = useState(holding.symbol);
  const [renameName,   setRenameName]   = useState(holding.name||"");

  const cur         = holding.currency||"INR";
  const qty         = holding.quantity||holding.units||0;
  const avgPrice    = holding.avgPrice||holding.nav||0;
  const investedAmt = holding.investedAmount || qty*avgPrice;
  // Current value = invested amount (trade prices only — no market price)
  const currentVal  = investedAmt;
  const totalDiff   = 0;
  const pctDiff     = 0;
  const fxRates     = state?.fxRates||DEFAULT.fxRates;
  const broker      = accounts.find(a=>a.id===holding.accountId);
  const tradeCount  = (investmentTx||[]).filter(t=>t.holdingId===holding.id || t.symbol===holding.symbol).length;

  function deleteSingleHolding() {
    const count = (investmentTx||[]).filter(t=>t.symbol===holding.symbol).length;
    if (!window.confirm(
      `⚠️ Delete ENTIRE holding: ${holding.symbol}?\n\n` +
      `This will permanently remove:\n` +
      `• All ${count} trade(s) for this stock\n` +
      `• The holding entry\n` +
      `• Related corporate actions\n\n` +
      `To delete a single trade, use "Trade History" instead.\n` +
      `This action cannot be undone.`
    )) return;
    dispatch({ type:"BULK_DELETE_HOLDINGS", payload:[holding.symbol] });
    toast(`${holding.symbol} and all its trades deleted`);
  }

  function doRename() {
    if (!renameSymbol.trim()) return;
    const newSym = renameSymbol.trim().toUpperCase();
    dispatch({ type:"RENAME_STOCK", payload:{ oldSymbol:holding.symbol, newSymbol:newSym, newName:renameName||holding.name } });
    toast(`Renamed ${holding.symbol} → ${newSym}`);
    setShowRename(false);
  }

  return (
    <div style={{borderBottom:"1px solid #F1F5F9"}}>
      {/* Main row — clickable to expand, or checkbox in bulk mode */}
      <div
        onClick={bulkSelectMode ? onBulkSelect : ()=>{ onToggle(holding.id); }}
        style={{display:"flex",alignItems:"center",gap:10,padding:"13px 14px",cursor:"pointer",background:isSelected?"#EEF2FF":isOpen?"#F8FAFC":"transparent"}}>
        {bulkSelectMode && (
          <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${isSelected?"#6366F1":"#CBD5E1"}`,background:isSelected?"#6366F1":"#fff",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff"}}>
            {isSelected&&"✓"}
          </div>
        )}
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
            <span style={{fontWeight:800,color:"#6366F1",fontSize:14}}>{holding.symbol}</span>
            <span style={{fontSize:11,color:"#94A3B8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{holding.name}</span>
          </div>
          <div style={{fontSize:12,color:"#64748B"}}>
            {fmtNum(qty)} {holding.type==="mf"?"units":"shares"} · Avg {fmtCur(avgPrice,cur)}
            {broker&&<span style={{marginLeft:6}}>· {broker.name}</span>}
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontWeight:700,fontSize:14}}>{fmtCur(investedAmt,cur)}</div>
          <div style={{fontSize:11,color:"#94A3B8"}}>invested</div>
        </div>
        <span style={{color:"#94A3B8",fontSize:12,flexShrink:0}}>{isOpen?"▲":"▼"}</span>
      </div>

      {/* Expanded section — P&L stats + View Trade History button */}
      {isOpen&&(
        <div style={{background:"#F8FAFC",borderTop:"1px solid #F1F5F9",padding:"12px 14px"}}>
          {/* P&L panel */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
            {[
              {label:"Invested",  val:fmtCur(investedAmt,cur), color:"#475569"},
              {label:"Avg Price", val:fmtCur(avgPrice,cur),    color:"#475569"},
              {label:"Qty/Units", val:fmtNum(qty),             color:"#475569"},
            ].map(x=>(
              <div key={x.label} style={{background:"#fff",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                <div style={{fontSize:12,fontWeight:700,color:x.color}}>{x.val}</div>
                <div style={{fontSize:10,color:"#94A3B8",marginTop:2}}>{x.label}</div>
              </div>
            ))}
          </div>

          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <button onClick={e=>{e.stopPropagation();setShowHistory(true);}}
              style={{fontSize:12,padding:"7px 14px",borderRadius:8,border:"1.5px solid #C7D2FE",background:"#fff",color:"#6366F1",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>
              📋 Trade History ({tradeCount})
            </button>
            <button onClick={e=>{e.stopPropagation();setShowRename(p=>!p);setRenameSymbol(holding.symbol);setRenameName(holding.name||"");}}
              style={{fontSize:12,padding:"7px 14px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
              ✏️ Rename
            </button>
            <button onClick={e=>{e.stopPropagation();deleteSingleHolding();}}
              style={{fontSize:12,padding:"7px 14px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600,marginLeft:"auto"}}>
              🗑️ Delete All Trades
            </button>
          </div>
          {showRename&&(
            <div style={{marginTop:10,background:"#F8FAFC",borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:12,fontWeight:600,color:"#64748B",marginBottom:8}}>Rename Symbol</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <input value={renameSymbol} onChange={e=>setRenameSymbol(e.target.value.toUpperCase())}
                  placeholder="New Symbol"
                  style={{...inputStyle,padding:"8px 10px",fontSize:13}}
                  onClick={e=>e.stopPropagation()} />
                <input value={renameName} onChange={e=>setRenameName(e.target.value)}
                  placeholder="New Name (optional)"
                  style={{...inputStyle,padding:"8px 10px",fontSize:13}}
                  onClick={e=>e.stopPropagation()} />
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={e=>{e.stopPropagation();doRename();}}
                  style={{padding:"6px 14px",borderRadius:8,border:"none",background:"#6366F1",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>✓ Save</button>
                <button onClick={e=>{e.stopPropagation();setShowRename(false);}}
                  style={{padding:"6px 14px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#fff",color:"#64748B",cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {showHistory&&(
        <TradeHistoryModal
          symbol={holding.symbol}
          holding={holding}
          investmentTx={investmentTx}
          accounts={accounts}
          state={state}
          dispatch={dispatch}
          onClose={()=>setShowHistory(false)}
        />
      )}
    </div>
  );
}

// ─── FD CARD ──────────────────────────────────────────────────────────────────
function FDCard({ fd, accounts, dispatch, state }) {
  const r = calcFDReturns(fd);
  const broker = accounts.find(a=>a.id===fd.accountId);
  const [editing,   setEditing]   = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [closeDate, setCloseDate] = useState(new Date().toISOString().slice(0,10));
  const [closeAccId, setCloseAccId] = useState(fd.sourceAccountId||"");
  const [overrideInterest, setOverrideInterest] = useState("");
  const today = new Date();
  const matDate = new Date(fd.maturityDate+"T00:00:00");
  const isMatured = matDate <= today;
  const daysLeft = Math.max(0, Math.ceil((matDate-today)/(1000*60*60*24)));
  const nonInvAccounts = accounts.filter(a => !a.disabled && !a.isInvestmentType);
  const isClosed = fd.status === "closed";

  function closeFD() {
    const interest = parseFloat(overrideInterest) || r.interest;
    if (!closeAccId) { toast("Select an account to receive the FD amount","error"); return; }
    if (!window.confirm("Close FD?\n\u2022 Principal will be transferred to selected account\n\u2022 Interest will be recorded as income transaction")) return;
    dispatch({ type:"CLOSE_FD", payload:{ fdId:fd.id, incomeAccId:closeAccId, interestAmt:interest, closeDate } });
    toast("FD closed. Principal transferred + interest logged as income.");
    setShowClose(false);
  }

  function undoClose() {
    if (!window.confirm("Undo closing this FD?\nThis will:\n\u2022 Reverse the principal transfer\n\u2022 Remove the interest income transaction\n\u2022 Restore the FD to active status")) return;
    dispatch({ type:"UNDO_CLOSE_FD", payload: fd.id });
    toast("FD close reversed — restored to active.");
  }

  if (isClosed) {
    return (
      <Card style={{padding:"12px 14px",borderLeft:"4px solid #94A3B8",marginBottom:10,background:"#F8FAFC",opacity:0.85}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:"#475569"}}>{fd.name||"Fixed Deposit"}</div>
            <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>{broker?.name||""} · {fd.interestRate}% p.a.</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontWeight:800,fontSize:15,color:"#94A3B8"}}>{fmtCur(r.principal,fd.currency||"INR")}</div>
            <div style={{fontSize:10,color:"#94A3B8"}}>Original principal</div>
          </div>
        </div>
        <div style={{background:"#F1F5F9",borderRadius:8,padding:"8px 10px",marginBottom:8,fontSize:12,color:"#64748B"}}>
          <div>✅ Closed on {fd.closeDate ? fmtDate(fd.closeDate) : "—"}</div>
          <div style={{marginTop:2}}>Principal transferred: {fmtCur(r.principal,fd.currency||"INR")} · Interest: {fmtCur(fd.closedInterest||0,fd.currency||"INR")}</div>
        </div>
        <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:10,background:"#F1F5F9",color:"#94A3B8",padding:"2px 7px",borderRadius:8,fontWeight:600}}>Closed</span>
          <button onClick={undoClose}
            style={{fontSize:11,padding:"3px 10px",borderRadius:6,border:"1.5px solid #FDE68A",background:"#FFFBEB",color:"#92400E",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>↩️ Undo Close</button>
          <button onClick={()=>{if(window.confirm("Delete this FD record permanently?"))dispatch({type:"DELETE_FD",payload:fd.id});}}
            style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️ Delete</button>
        </div>
      </Card>
    );
  }

  return (
    <Card style={{padding:"12px 14px",borderLeft:"4px solid #0EA5E9",marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:"#0F172A"}}>{fd.name||"Fixed Deposit"}</div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>{broker?.name||""} · {fd.interestRate}% p.a.</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontWeight:800,fontSize:15,color:"#0EA5E9"}}>{fmtCur(r.principal,fd.currency||"INR")}</div>
          <div style={{fontSize:10,color:"#94A3B8"}}>Invested amt</div>
          <div style={{fontSize:10,color:"#10B981",fontWeight:600,marginTop:2}}>+{fmtCur(r.interest,fd.currency||"INR")} at maturity</div>
        </div>
      </div>
      <div style={{display:"flex",gap:12,fontSize:11,color:"#64748B",marginBottom:8}}>
        <span>{fmtDate(fd.investedDate)} → {fmtDate(fd.maturityDate)}</span>
      </div>
      {isMatured&&!showClose&&(
        <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:8,padding:"7px 10px",marginBottom:8,fontSize:12,color:"#065F46",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>✅ Matured! Close to return principal + log interest.</span>
          <button onClick={()=>setShowClose(true)} style={{fontSize:11,padding:"4px 10px",borderRadius:7,border:"none",background:"#10B981",color:"#fff",cursor:"pointer",fontWeight:700,fontFamily:"inherit",flexShrink:0,marginLeft:8}}>Close FD</button>
        </div>
      )}
      {showClose&&(
        <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:10,padding:"12px",marginBottom:10}}>
          <div style={{fontSize:13,fontWeight:700,color:"#065F46",marginBottom:10}}>🏦 Close Fixed Deposit</div>
          <div style={{background:"#ECFDF5",borderRadius:8,padding:"8px 10px",marginBottom:10,fontSize:12,color:"#065F46"}}>
            <div>💰 Principal <strong>{fmtCur(r.principal, fd.currency||"INR")}</strong> → transferred to account below</div>
            <div style={{marginTop:3}}>📈 Interest → recorded as income transaction</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            <div>
              <div style={{fontSize:11,color:"#64748B",marginBottom:4}}>Close Date</div>
              <input type="date" value={closeDate} onChange={e=>setCloseDate(e.target.value)}
                style={{...inputStyle,padding:"7px 10px",fontSize:13}} />
            </div>
            <div>
              <div style={{fontSize:11,color:"#64748B",marginBottom:4}}>Interest Amount (₹)</div>
              <input type="number" value={overrideInterest} onChange={e=>setOverrideInterest(e.target.value)}
                placeholder={String(r.interest.toFixed(2))}
                style={{...inputStyle,padding:"7px 10px",fontSize:13}} />
            </div>
          </div>
          <div style={{marginBottom:8}}>
            <div style={{fontSize:11,color:"#64748B",marginBottom:4}}>Transfer principal to account</div>
            <select value={closeAccId} onChange={e=>setCloseAccId(e.target.value)} style={{...inputStyle,padding:"7px 10px",fontSize:13,background:"#fff"}}>
              <option value="">— Select account —</option>
              {nonInvAccounts.map(a=><option key={a.id} value={a.id}>{a.icon||""} {a.name}</option>)}
            </select>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={closeFD} style={{flex:1,padding:"8px",borderRadius:8,border:"none",background:"#10B981",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>✓ Confirm Close</button>
            <button onClick={()=>setShowClose(false)} style={{padding:"8px 14px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#fff",color:"#64748B",cursor:"pointer",fontSize:13,fontFamily:"inherit"}}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
        {!isMatured&&<span style={{fontSize:10,background:"#EFF6FF",color:"#3B82F6",padding:"2px 7px",borderRadius:8,fontWeight:600}}>{daysLeft}d left</span>}
        {isMatured&&!showClose&&<span style={{fontSize:10,background:"#F0FDF4",color:"#10B981",padding:"2px 7px",borderRadius:8,fontWeight:600}}>Matured</span>}
        <button onClick={()=>setEditing(true)} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️ Edit</button>
        <button onClick={()=>{if(window.confirm("Delete this FD?"))dispatch({type:"DELETE_FD",payload:fd.id});}} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>
        {!showClose&&<button onClick={()=>setShowClose(true)} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1.5px solid #A7F3D0",background:"#F0FDF4",color:"#065F46",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🔒 Close FD</button>}
      </div>
      {editing&&(
        <InvestModal state={state||{accounts,accountCategories:DEFAULT.accountCategories}} editTx={{...fd,invType:"fd",fdAmount:fd.amount,fdRate:fd.interestRate,fdInvDate:fd.investedDate,fdMatDate:fd.maturityDate}} onClose={()=>setEditing(false)}
          onSave={({fd:updated})=>{dispatch({type:"EDIT_FD",payload:{...fd,...updated}});setEditing(false);toast("FD updated");}} />
      )}
    </Card>
  );
}
// ─── IMPORT MODAL ─────────────────────────────────────────────────────────────
// Supports CSV + XLSX import for trades, expenses, income.
// Validates columns; shows errors; dispatches bulk on confirm.
function ImportModal({ state, dispatch, onClose }) {
  const [importType,   setImportType]   = useState("expense");
  const [rows,         setRows]         = useState([]);
  const [errors,       setErrors]       = useState([]);
  const [fileName,     setFileName]     = useState("");
  const [loading,      setLoading]      = useState(false);
  const [importResult, setImportResult] = useState(null); // { total, imported, skipped, errors } after import

  // ── Account selection for trade / broker imports ──────────────────────────
  // Set to the first plausible account when a file is loaded; user can override.
  const [selInvAccId, setSelInvAccId]  = useState(""); // investment account (e.g. Zerodha)
  const [selSrcAccId, setSelSrcAccId]  = useState(""); // source / bank account

  // Derive account lists once
  const allAccounts    = state?.accounts || [];
  const accTypes       = state?.accountCategories || DEFAULT.accountCategories;
  const investType     = accTypes.find(t => t.isInvestmentType);
  const investAccounts = investType
    ? allAccounts.filter(a => a.categoryId === investType.id && !a.disabled)
    : [];
  const bankAccounts   = allAccounts.filter(a =>
    !a.disabled && (!investType || a.categoryId !== investType.id)
  );

  const fileRef = useRef(null);

  // Whether this import type needs account selection
  const needsAccounts = (t) => t === "trade" || (TEMPLATES[t] && TEMPLATES[t].brokerFormat);

  // When import type changes, reset account selectors to best defaults
  function resetAccSelectors(type) {
    const inv = investAccounts[0]?.id || allAccounts[0]?.id || "";
    const src = bankAccounts[0]?.id   || allAccounts[0]?.id || "";
    setSelInvAccId(inv);
    setSelSrcAccId(src);
  }

  // ── IMPORT TEMPLATE REGISTRY ─────────────────────────────────────────────
  // Standard templates: expense, income, trade (WealthMap native format)
  // Broker templates:   zerodha_v2 (ZERODHA_TRADEBOOK_V2)
  //
  // Broker templates have a `brokerFormat: true` flag and define:
  //   • cols          — required CSV column headers (used for validation)
  //   • colMap        — maps CSV column → internal field name
  //   • ignoredCols   — columns to silently ignore
  //   • externalIdCol — CSV column to use as unique external trade ID for dedup
  //   • sample        — one example row (for download template)
  // ─────────────────────────────────────────────────────────────────────────
  const TEMPLATES = {
    expense: {
      cols:   ["Date","Amount","Category","Account","Note"],
      sample: [["2024-01-15","1500","Food & Dining","SBI Savings","Lunch"],
               ["2024-01-16","500","Transport","SBI Savings","Auto"]],
    },
    income: {
      cols:   ["Date","Amount","Category","Account","Note"],
      sample: [["2024-01-01","50000","Salary","SBI Savings","Jan salary"]],
    },
    trade: {
      cols:   ["Date","Symbol","Type","Quantity","Price","InvestmentAccount","SourceAccount","Note"],
      sample: [["2024-01-10","TCS","buy","10","3500","Zerodha","SBI Savings","Q4 buy"]],
    },

    // ── ZERODHA_TRADEBOOK_V2 ──────────────────────────────────────────────
    // Broker CSV export format from Zerodha Console → Tradebook.
    // Columns: symbol,isin,trade_date,exchange,segment,series,trade_type,
    //          auction,quantity,price,trade_id,order_id,order_execution_time
    zerodha_v2: {
      brokerFormat:  true,
      label:         "🟠 Zerodha Tradebook",
      cols:          ["symbol","isin","trade_date","exchange","segment","series",
                      "trade_type","auction","quantity","price","trade_id",
                      "order_id","order_execution_time"],
      // Maps CSV column name → internal field used when building the trade object
      colMap: {
        symbol:     "stock_name",
        trade_date: "trade_date",
        trade_type: "trade_type",
        quantity:   "quantity",
        price:      "price",
        exchange:   "exchange",
        trade_id:   "external_trade_id",
      },
      // Columns to silently ignore — never validated, never used
      ignoredCols: ["isin","segment","series","auction","order_id","order_execution_time"],
      // CSV column whose value is used as the unique dedup key
      externalIdCol: "trade_id",
      // Sample row matching the Zerodha format exactly
      sample: [["IRCTC","INE335Y01020","2022-02-09","NSE","EQ","EQ",
                "buy","false","1.000000","853.000000",
                "26518313","1100000005897931","2022-02-09T10:20:43"]],
    },
  };

  // Detect if a template is a broker format
  const isBrokerTemplate = (type) => TEMPLATES[type]?.brokerFormat === true;

  // Auto-detect template from uploaded CSV headers
  function detectBrokerTemplate(headers) {
    const lower = headers.map(h => h.toLowerCase().trim());
    // ZERODHA_TRADEBOOK_V2 signature: has trade_date + trade_type + trade_id
    if (lower.includes("trade_date") && lower.includes("trade_type") && lower.includes("trade_id")) {
      return "zerodha_v2";
    }
    return null;
  }

  function downloadTemplate(type) {
    const t = TEMPLATES[type];
    const csv = [t.cols.join(","), ...t.sample.map(r=>r.join(","))].join("\n");
    const blob = new Blob([csv], {type:"text/csv"});
    const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
    // Use a descriptive filename for broker templates
    const filename = type === "zerodha_v2"
      ? "zerodha_tradebook_v2_sample.csv"
      : `wealthmap_${type}_template.csv`;
    a.download = filename; a.click();
    toast("Template downloaded");
  }

  async function handleFile(file) {
    if (!file) return;
    setFileName(file.name); setLoading(true); setRows([]); setErrors([]); setImportResult(null);
    resetAccSelectors(importType);
    try {
      let csvText = "";
      if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
        csvText = await file.text();
      } else if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
        const buf = await file.arrayBuffer();
        const XLSX = window.XLSX;
        if (!XLSX) { setErrors(["XLSX support requires SheetJS. Please use CSV format."]); setLoading(false); return; }
        const wb = XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        csvText = XLSX.utils.sheet_to_csv(ws);
      } else {
        setErrors(["Unsupported file type. Use .csv, .xlsx, or .xls"]);
        setLoading(false); return;
      }
      // Auto-detect broker template from headers before parsing
      const firstLine = csvText.trim().split(/\r?\n/)[0];
      const headers   = firstLine.split(",").map(h => h.trim().replace(/^["']|["']$/g,""));
      const detected  = detectBrokerTemplate(headers);
      if (detected && importType !== detected) {
        setImportType(detected);
        // Parse with the detected type (parseCSV reads importType via closure, so
        // we pass the override explicitly)
        parseCSV(csvText, detected);
      } else {
        parseCSV(csvText, importType);
      }
    } catch(e) {
      setErrors(["Failed to read file: " + e.message]);
    }
    setLoading(false);
  }

  // parseCSV: parse raw CSV text and validate rows.
  // activeType: the importType to use (passed explicitly to handle auto-detection).
  function parseCSV(text, activeType) {
    const type  = activeType || importType;
    const tmpl  = TEMPLATES[type];
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { setErrors(["File is empty or has only headers"]); return; }

    const headers = lines[0].split(",").map(h => h.trim().replace(/^["']|["']$/g,""));

    if (tmpl.brokerFormat) {
      // ── Broker template validation ────────────────────────────────────────
      // Only validate that the mapped (non-ignored) source columns exist.
      const mappedCsvCols = Object.keys(tmpl.colMap);
      const missing = mappedCsvCols.filter(
        col => !headers.some(h => h.toLowerCase() === col.toLowerCase())
      );
      if (missing.length > 0) {
        setErrors([`Missing required columns for ${tmpl.label}: ${missing.join(", ")}`]);
        return;
      }

      const errs = []; const parsed = [];
      lines.slice(1).forEach((line, i) => {
        const vals = line.split(",").map(v => v.trim().replace(/^["']|["']$/g,""));
        const raw  = {};
        headers.forEach((h, j) => { raw[h.toLowerCase().trim()] = vals[j] || ""; });

        // Map CSV columns → internal field names via colMap
        const row = { _brokerType: type };
        Object.entries(tmpl.colMap).forEach(([csvCol, internalField]) => {
          row[internalField] = raw[csvCol.toLowerCase()] || "";
        });
        // Always store the external trade_id raw value for dedup
        if (tmpl.externalIdCol) {
          row._externalId = raw[tmpl.externalIdCol.toLowerCase()] || "";
        }

        // Validate required broker fields
        const tradeDate = row.trade_date || "";
        const tradeType = (row.trade_type || "").toLowerCase();
        const qty       = parseFloat(row.quantity);
        const price     = parseFloat(row.price);

        if (!tradeDate || isNaN(Date.parse(tradeDate)))
          errs.push('Row ' + (i+2) + ': invalid trade_date "' + tradeDate + '"');
        if (!["buy","sell"].includes(tradeType))
          errs.push('Row ' + (i+2) + ': trade_type must be buy or sell, got "' + row.trade_type + '"');
        if (isNaN(qty) || qty <= 0)
          errs.push('Row ' + (i+2) + ': invalid quantity "' + row.quantity + '"');
        if (isNaN(price) || price <= 0)
          errs.push('Row ' + (i+2) + ': invalid price "' + row.price + '"');
        if (!row.stock_name)
          errs.push("Row " + (i+2) + ": missing symbol");

        parsed.push(row);
      });
      setErrors(errs);
      setRows(parsed);

    } else {
      // ── Standard (native) template validation ─────────────────────────────
      const expected = tmpl.cols;
      const missing  = expected.filter(
        col => !headers.some(h => h.toLowerCase() === col.toLowerCase())
      );
      if (missing.length > 0) { setErrors(["Missing columns: " + missing.join(", ")]); return; }

      const errs = []; const parsed = [];
      lines.slice(1).forEach((line, i) => {
        const vals = line.split(",").map(v => v.trim().replace(/^["']|["']$/g,""));
        const row  = {};
        headers.forEach((h, j) => row[h.toLowerCase()] = vals[j] || "");
        if (!row.date || isNaN(Date.parse(row.date)))
          errs.push('Row ' + (i+2) + ': invalid date "' + row.date + '"');
        if (type !== "trade") {
          if (!row.amount || isNaN(parseFloat(row.amount)))
            errs.push('Row ' + (i+2) + ': invalid amount "' + row.amount + '"');
        } else {
          if (!row.quantity || isNaN(parseFloat(row.quantity)))
            errs.push("Row " + (i+2) + ": invalid quantity");
          if (!row.price || isNaN(parseFloat(row.price)))
            errs.push("Row " + (i+2) + ": invalid price");
          if (!["buy","sell"].includes((row.type||"").toLowerCase()))
            errs.push("Row " + (i+2) + ": type must be buy or sell");
        }
        parsed.push(row);
      });
      setErrors(errs);
      setRows(parsed);
    }
  }

  function doImport() {
    // ── Validate account selection for trade / broker imports ───────────────
    if (needsAccounts(importType)) {
      if (!selInvAccId) { toast("Please select an Investment Account before importing", "error"); return; }
      if (!selSrcAccId) { toast("Please select a Source Account before importing",      "error"); return; }
    }

    const expCats  = state?.expenseCategories || DEFAULT.expenseCategories;
    const incCats  = state?.incomeCategories  || DEFAULT.incomeCategories;
    let imported=0, skipped=0, errCount=0;
    const total = rows.length;

    // ── Dedup sets ───────────────────────────────────────────────────────────
    const existingTxFP = new Set(
      (state?.transactions||[]).map(t =>
        t.type+"|"+t.date+"|"+t.amount+"|"+t.accountId+"|"+t.categoryId
      )
    );
    const existingTradeFP = new Set(
      (state?.investmentTx||[]).map(t =>
        t.type+"|"+t.date+"|"+(t.symbol||"").toUpperCase()+"|"+t.quantity+"|"+t.price+"|"+t.accountId
      )
    );
    const existingExtIds = new Set(
      (state?.investmentTx||[])
        .filter(t => t.externalTradeId)
        .map(t => String(t.externalTradeId))
    );

    // ── Collect all valid trade objects (broker + native trade) ─────────────
    // These will be dispatched in ONE atomic action.
    const tradesToImport = [];

    rows.forEach(row => {

      // ══════════════════════════════════════════════════════════════════════
      // BROKER FORMAT (e.g. zerodha_v2)
      // ══════════════════════════════════════════════════════════════════════
      if (row._brokerType && TEMPLATES[row._brokerType]?.brokerFormat) {
        try {
          const sym       = (row.stock_name || "").toUpperCase().trim();
          const tradeType = (row.trade_type || "").toLowerCase().trim();
          const qty       = parseFloat(row.quantity);
          const price     = parseFloat(row.price);
          const tradeDate = row.trade_date || "";
          const extId     = row._externalId || "";

          if (!sym || !tradeDate || isNaN(qty) || isNaN(price) || !["buy","sell"].includes(tradeType)) {
            errCount++; return;
          }
          // Dedup by external trade_id
          if (extId && existingExtIds.has(extId)) { skipped++; return; }

          // Resolve currency from selected investment account
          const invAcc = allAccounts.find(a => a.id === selInvAccId);
          const currency = invAcc?.currency || "INR";

          const itx = {
            id:              uid(),
            holdingId:       uid(),   // used to match holding during rebuild
            type:            tradeType,
            invType:         "stock",
            symbol:          sym,
            name:            sym,
            quantity:        qty,
            price,
            currency,
            date:            tradeDate,
            accountId:       selInvAccId,     // investment account (user-selected)
            sourceAccountId: selSrcAccId,     // bank / source account (user-selected)
            brokerage:       0,
            note:            row.exchange ? "Exchange: " + row.exchange : "",
            externalTradeId: extId,
          };

          tradesToImport.push(itx);
          if (extId) existingExtIds.add(extId);   // intra-batch dedup
          imported++;

        } catch(e) {
          console.warn("Broker import row error:", e);
          errCount++;
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // STANDARD FORMAT: expense, income
      // ══════════════════════════════════════════════════════════════════════
      if (importType === "expense" || importType === "income") {
        try {
          const cats   = importType === "expense" ? expCats : incCats;
          const catObj = cats.find(c => c.name.toLowerCase() === row.category?.toLowerCase());
          const acc    = allAccounts.find(a => a.name.toLowerCase() === row.account?.toLowerCase());
          const fp     = importType+"|"+row.date+"|"+(parseFloat(row.amount)||0)+"|"+(acc?.id||"")+"|"+(catObj?.id||"");
          if (existingTxFP.has(fp)) { skipped++; return; }
          const tx = {
            id:         uid(),
            type:       importType,
            amount:     parseFloat(row.amount) || 0,
            currency:   acc?.currency || "INR",
            categoryId: catObj?.id || cats[0]?.id || "",
            accountId:  acc?.id    || allAccounts[0]?.id || "",
            note:       row.note || "",
            date:       row.date,
            tags:       [],
            isRefunded: false, refundedAmount: 0,
          };
          dispatch({ type:"ADD_TX", payload:tx });
          existingTxFP.add(fp);
          imported++;
        } catch(e) {
          console.warn("Import tx error:", e);
          errCount++;
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // STANDARD FORMAT: native trade (Date/Symbol/Type/Qty/Price/…)
      // Uses user-selected accounts (selInvAccId / selSrcAccId)
      // ══════════════════════════════════════════════════════════════════════
      if (importType === "trade") {
        try {
          const sym       = (row.symbol || "").toUpperCase();
          const tradeType = (row.type || "buy").toLowerCase();
          const qty       = parseFloat(row.quantity) || 0;
          const price     = parseFloat(row.price)    || 0;
          const fp        = tradeType+"|"+row.date+"|"+sym+"|"+qty+"|"+price+"|"+selInvAccId;
          if (existingTradeFP.has(fp)) { skipped++; return; }

          const invAcc   = allAccounts.find(a => a.id === selInvAccId);
          const currency = invAcc?.currency || "INR";

          const itx = {
            id:              uid(),
            holdingId:       uid(),
            type:            tradeType,
            invType:         "stock",
            symbol:          sym,
            name:            sym,
            quantity:        qty,
            price,
            currency,
            date:            row.date,
            accountId:       selInvAccId,
            sourceAccountId: selSrcAccId,
            brokerage:       0,
            note:            row.note || "",
          };

          tradesToImport.push(itx);
          existingTradeFP.add(fp);
          imported++;
        } catch(e) {
          console.warn("Import trade error:", e);
          errCount++;
        }
      }
    });

    // ── Dispatch all trades in one atomic action ──────────────────────────
    // This rebuilds holdings + balance effects in one go and triggers a
    // single saveLocal call → data survives refresh and screen changes.
    if (tradesToImport.length > 0) {
      dispatch({ type:"BULK_IMPORT_INVESTMENTS", payload:{ trades: tradesToImport } });
    }

    // ── Result summary ────────────────────────────────────────────────────
    setImportResult({ total, imported, skipped, errors: errCount });
    const parts = [
      imported + " trade(s) imported",
      skipped  > 0 ? skipped  + " duplicate(s) skipped" : null,
      errCount > 0 ? errCount + " error(s)" : null,
    ].filter(Boolean);
    toast(parts.join(" · "), errCount > 0 ? "error" : "success");
  }

  return (
    <Modal title="Import Data" onClose={onClose}>
      {/* Type selector */}
      <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",paddingBottom:2}}>
        {[["expense","📤 Expenses"],["income","📥 Income"],["trade","📊 Trades"]].map(([v,l])=>(
          <button key={v} onClick={()=>{setImportType(v);setRows([]);setErrors([]);setFileName("");setImportResult(null);resetAccSelectors(v);}}
            style={{flexShrink:0,padding:"7px 14px",borderRadius:18,border:`2px solid ${importType===v?"#6366F1":"#E2E8F0"}`,background:importType===v?"#EEF2FF":"#fff",color:importType===v?"#6366F1":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
        {/* Broker format templates */}
        <div style={{width:"1px",background:"#E2E8F0",flexShrink:0,margin:"0 2px"}} />
        {[["zerodha_v2","🟠 Zerodha"]].map(([v,l])=>(
          <button key={v} onClick={()=>{setImportType(v);setRows([]);setErrors([]);setFileName("");setImportResult(null);resetAccSelectors(v);}}
            style={{flexShrink:0,padding:"7px 14px",borderRadius:18,border:`2px solid ${importType===v?"#F59E0B":"#E2E8F0"}`,background:importType===v?"#FFFBEB":"#fff",color:importType===v?"#92400E":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>

      {/* Template info box — adapts for broker formats */}
      {isBrokerTemplate(importType) ? (
        <div style={{background:"#FFFBEB",border:"1.5px solid #FDE68A",borderRadius:10,padding:12,marginBottom:16,fontSize:13}}>
          <div style={{fontWeight:700,color:"#92400E",marginBottom:4}}>
            🟠 {TEMPLATES[importType].label} — Broker CSV Format
          </div>
          <div style={{fontSize:11,color:"#78350F",marginBottom:6}}>
            Auto-detected when you upload a Zerodha tradebook CSV.
            Upload your file directly — no column renaming needed.
          </div>
          <div style={{fontWeight:600,color:"#92400E",marginBottom:4}}>Mapped columns:</div>
          <div style={{color:"#78350F",fontFamily:"monospace",fontSize:11,marginBottom:8,lineHeight:1.8}}>
            {Object.entries(TEMPLATES[importType].colMap).map(([csv,internal])=>(
              <span key={csv} style={{display:"inline-block",marginRight:12}}>
                <span style={{color:"#0F172A"}}>{csv}</span>
                <span style={{color:"#94A3B8"}}> → </span>
                <span style={{color:"#6366F1"}}>{internal}</span>
              </span>
            ))}
          </div>
          <div style={{fontSize:11,color:"#94A3B8",marginBottom:8}}>
            Ignored: {TEMPLATES[importType].ignoredCols.join(", ")}
          </div>
          <button onClick={()=>downloadTemplate(importType)}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #FDE68A",background:"#fff",color:"#92400E",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
            ⬇️ Download Sample CSV
          </button>
        </div>
      ) : (
        <div style={{background:"#EEF2FF",border:"1.5px solid #C7D2FE",borderRadius:10,padding:12,marginBottom:16,fontSize:13}}>
          <div style={{fontWeight:600,color:"#4338CA",marginBottom:6}}>📋 Required columns:</div>
          <div style={{color:"#475569",fontFamily:"monospace",fontSize:12,marginBottom:8}}>
            {TEMPLATES[importType].cols.join(" | ")}
          </div>
          <button onClick={()=>downloadTemplate(importType)}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #C7D2FE",background:"#fff",color:"#6366F1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
            ⬇️ Download Template
          </button>
        </div>
      )}

      {/* File upload */}
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}}
        onChange={e=>handleFile(e.target.files[0])} />
      <button onClick={()=>fileRef.current?.click()}
        style={{width:"100%",padding:"12px",borderRadius:10,border:"2px dashed #C7D2FE",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600,fontSize:14,marginBottom:12}}>
        {loading?"⏳ Reading…":fileName?`📄 ${fileName}`:"📂 Click to Upload CSV / XLSX"}
      </button>

      {/* ── Account Selection — shown for trade & broker imports once file is loaded ── */}
      {needsAccounts(importType) && rows.length > 0 && errors.length === 0 && !importResult && (
        <div style={{background:"#F0F9FF",border:"1.5px solid #BAE6FD",borderRadius:10,padding:14,marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:13,color:"#0369A1",marginBottom:10}}>
            🏦 Assign Accounts for Imported Trades
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {/* Investment Account */}
            <div>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>
                Investment Account <span style={{color:"#EF4444"}}>*</span>
              </label>
              <select
                value={selInvAccId}
                onChange={e => setSelInvAccId(e.target.value)}
                style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"1.5px solid #BAE6FD",fontSize:13,fontFamily:"inherit",background:"#fff",color:"#0F172A"}}
              >
                <option value="">— select —</option>
                {allAccounts.filter(a=>!a.disabled).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <div style={{fontSize:11,color:"#64748B",marginTop:3}}>
                e.g. Zerodha, Groww — holdings go here
              </div>
            </div>
            {/* Source / Bank Account */}
            <div>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>
                Source Account <span style={{color:"#EF4444"}}>*</span>
              </label>
              <select
                value={selSrcAccId}
                onChange={e => setSelSrcAccId(e.target.value)}
                style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"1.5px solid #BAE6FD",fontSize:13,fontFamily:"inherit",background:"#fff",color:"#0F172A"}}
              >
                <option value="">— select —</option>
                {allAccounts.filter(a=>!a.disabled).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <div style={{fontSize:11,color:"#64748B",marginTop:3}}>
                e.g. Bank account used to fund purchases
              </div>
            </div>
          </div>
          <div style={{marginTop:10,padding:"8px 10px",background:"#E0F2FE",borderRadius:7,fontSize:11,color:"#0369A1",lineHeight:1.6}}>
            <strong>BUY:</strong> Source ↓ decreases · Investment ↑ increases<br/>
            <strong>SELL:</strong> Investment ↓ decreases · Source ↑ increases
          </div>
        </div>
      )}

      {/* Errors */}
      {errors.length>0&&(
        <div style={{background:"#FEF2F2",border:"1.5px solid #FECACA",borderRadius:10,padding:12,marginBottom:12}}>
          <div style={{fontWeight:600,color:"#EF4444",marginBottom:6}}>⚠️ Validation Errors</div>
          {errors.map((e,i)=><div key={i} style={{fontSize:12,color:"#991B1B",padding:"2px 0"}}>• {e}</div>)}
        </div>
      )}

      {/* Preview — shows before import */}
      {rows.length>0&&errors.length===0&&!importResult&&(()=>{
        // Pre-calculate duplicate count for preview
        const existingTxFP = new Set(
          (state?.transactions||[]).map(t=>t.type+"|"+t.date+"|"+t.amount+"|"+t.accountId+"|"+t.categoryId)
        );
        const existingTradeFP = new Set(
          (state?.investmentTx||[]).map(t=>t.type+"|"+t.date+"|"+(t.symbol||"").toUpperCase()+"|"+t.quantity+"|"+t.price+"|"+t.accountId)
        );
        const existingExtIds = new Set(
          (state?.investmentTx||[]).filter(t=>t.externalTradeId).map(t=>String(t.externalTradeId))
        );
        const accts    = state?.accounts||[];
        const expCats  = state?.expenseCategories||DEFAULT.expenseCategories;
        const incCats  = state?.incomeCategories||DEFAULT.incomeCategories;
        let dupCount   = 0;

        rows.forEach(row => {
          if (row._brokerType && TEMPLATES[row._brokerType]?.brokerFormat) {
            // Broker dedup: by external trade_id
            if (row._externalId && existingExtIds.has(row._externalId)) dupCount++;
          } else if (importType==="expense"||importType==="income") {
            const cats   = importType==="expense"?expCats:incCats;
            const catObj = cats.find(c=>c.name.toLowerCase()===row.category?.toLowerCase());
            const acc    = accts.find(a=>a.name.toLowerCase()===row.account?.toLowerCase());
            const fp     = importType+"|"+row.date+"|"+(parseFloat(row.amount)||0)+"|"+(acc?.id||"")+"|"+(catObj?.id||"");
            if (existingTxFP.has(fp)) dupCount++;
          } else if (importType==="trade") {
            const invAcc = accts.find(a=>a.name.toLowerCase()===(row.investmentaccount||"").toLowerCase());
            const sym    = (row.symbol||"").toUpperCase();
            const fp     = (row.type?.toLowerCase()||"buy")+"|"+row.date+"|"+sym+"|"+(parseFloat(row.quantity)||0)+"|"+(parseFloat(row.price)||0)+"|"+(invAcc?.id||"");
            if (existingTradeFP.has(fp)) dupCount++;
          }
        });

        const newCount = rows.length - dupCount;

        // For broker rows, show mapped fields; for native, show raw values
        const previewRows = rows.slice(0, 5).map((r, i) => {
          if (r._brokerType) {
            const sym   = (r.stock_name||"—").toUpperCase();
            const type  = (r.trade_type||"").toUpperCase();
            const qty   = parseFloat(r.quantity)||0;
            const price = parseFloat(r.price)||0;
            const date  = r.trade_date||"";
            const extId = r._externalId||"";
            return sym + "  " + type + "  " + qty + " @ ₹" + price + "  " + date + "  [id:" + extId + "]";
          }
          return Object.entries(r).filter(([k])=>!k.startsWith("_")).map(([,v])=>v).join(" | ");
        });

        return (
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:13,color:"#10B981"}}>✅ {newCount} new record(s) ready</div>
              {dupCount>0&&<div style={{fontWeight:600,fontSize:13,color:"#F59E0B"}}>⚠️ {dupCount} duplicate(s) will be skipped</div>}
            </div>
            <div style={{maxHeight:160,overflowY:"auto",fontSize:11,background:"#F8FAFC",borderRadius:8,padding:8}}>
              {previewRows.map((line,i)=>(
                <div key={i} style={{color:"#475569",padding:"2px 0",fontFamily:"monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{line}</div>
              ))}
              {rows.length>5&&<div style={{color:"#94A3B8",fontSize:11,marginTop:4}}>…and {rows.length-5} more rows</div>}
            </div>
          </div>
        );
      })()}

      {/* Import Result Summary — shows after import */}
      {importResult&&(
        <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:10,padding:14,marginBottom:12}}>
          <div style={{fontWeight:700,fontSize:14,color:"#065F46",marginBottom:10}}>✅ Import Complete</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
            {[
              {label:"Total Rows",    val:importResult.total,    color:"#0F172A",  bg:"#F8FAFC"},
              {label:"Imported",      val:importResult.imported, color:"#10B981",  bg:"#ECFDF5"},
              {label:"Skipped (dup)", val:importResult.skipped,  color:"#F59E0B",  bg:"#FFFBEB"},
              {label:"Errors",        val:importResult.errors,   color:importResult.errors>0?"#EF4444":"#94A3B8", bg:importResult.errors>0?"#FEF2F2":"#F8FAFC"},
            ].map(s=>(
              <div key={s.label} style={{background:s.bg,borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                <div style={{fontWeight:800,fontSize:22,color:s.color}}>{s.val}</div>
                <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{s.label}</div>
              </div>
            ))}
          </div>
          {importResult.errors>0&&(
            <div style={{marginTop:8,fontSize:12,color:"#92400E"}}>
              ⚠️ {importResult.errors} row(s) had errors and were skipped. Check the console for details.
            </div>
          )}
        </div>
      )}

      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>{importResult ? "Close" : "Cancel"}</Btn>
        {!importResult && (
          <Btn
            onClick={doImport}
            disabled={
              rows.length === 0 ||
              errors.length > 0 ||
              (needsAccounts(importType) && (!selInvAccId || !selSrcAccId))
            }
          >
            Import {rows.length > 0 ? rows.length + " Records" : ""}
          </Btn>
        )}
        {importResult && importResult.imported > 0 && (
          <Btn variant="success" onClick={onClose}>✅ Done</Btn>
        )}
      </BtnRow>
    </Modal>
  );
}

// ─── CORPORATE ACTION MODAL ──────────────────────────────────────────────────
// Supported: stock_split, reverse_split, bonus, dividend, stock_name_change,
//            merger, demerger. All actions have delete option.
function CorporateActionModal({ state, dispatch, onClose }) {
  const holdings   = state?.holdings   ||[];
  const accounts   = state?.accounts   ||[];
  const stocks     = state?.stocks     ||[];
  const incCats    = state?.incomeCategories||DEFAULT.incomeCategories;
  const corpActions= state?.corporateActions||[];

  const symbols    = [...new Set(holdings.map(h=>h.symbol))];
  const allSymbols = [...new Set([...symbols, ...stocks.map(s=>s.symbol)])];

  const [tab,        setTab]       = useState("add");
  const [actionType, setActionType]= useState("stock_split");
  const [symbol,     setSymbol]    = useState(symbols[0]||"");
  const [ratio,      setRatio]     = useState("");
  const [date,       setDate]      = useState(new Date().toISOString().slice(0,10));
  const [note,       setNote]      = useState("");
  const [divAmount,  setDivAmount] = useState("");
  const [divAccId,   setDivAccId]  = useState(accounts[0]?.id||"");
  const [newSymbol,  setNewSymbol] = useState("");
  const [newName,    setNewName]   = useState("");
  // Merger fields
  const [toSymbol,   setToSymbol]  = useState("");
  const [toName,     setToName]    = useState("");
  // Demerger fields
  const [demergerResults, setDemergerResults] = useState([{symbol:"",name:"",ratio:"1"}]);

  const ACTION_TYPES = [
    { value:"stock_split",       label:"📈 Stock Split",         desc:"1→2: qty doubles, price halves" },
    { value:"reverse_split",     label:"📉 Reverse Split/Merge", desc:"2→1: qty halves, price doubles" },
    { value:"bonus",             label:"🎁 Bonus Issue",          desc:"Extra shares, invested value unchanged" },
    { value:"dividend",          label:"💰 Dividend",             desc:"Cash payout credited to account" },
    { value:"stock_name_change", label:"✏️ Name/Symbol Change",  desc:"Rename symbol, keep trade history" },
    { value:"merger",            label:"🔀 Merger",               desc:"Stock A merges into B" },
    { value:"demerger",          label:"🪢 Demerger",             desc:"Stock splits into multiple stocks" },
  ];

  const bankAccs = accounts.filter(a=>!a.isCreditCard&&!(a.is_active===false)&&!a.disabled);

  function addDemergerResult()   { setDemergerResults(r=>[...r,{symbol:"",name:"",ratio:"1"}]); }
  function delDemergerResult(i)  { setDemergerResults(r=>r.filter((_,j)=>j!==i)); }
  function updDemergerResult(i,k,v) { setDemergerResults(r=>r.map((x,j)=>j===i?{...x,[k]:v}:x)); }

  function save() {
    if (!symbol) { alert("Select a symbol"); return; }
    if (!date)   { alert("Enter a date"); return; }

    if (actionType==="stock_name_change") {
      if (!newSymbol) { alert("Enter new symbol"); return; }
      const ca = {id:uid(),symbol,action_type:"stock_name_change",new_symbol:newSymbol.toUpperCase(),new_name:newName||newSymbol.toUpperCase(),old_name:holdings.find(h=>h.symbol===symbol)?.name||symbol,date,note};
      dispatch({type:"ADD_CORPORATE_ACTION",payload:ca});
      toast(`Symbol changed: ${symbol} → ${newSymbol.toUpperCase()}`);
      onClose(); return;
    }

    if (actionType==="dividend") {
      if (!divAmount||parseFloat(divAmount)<=0) { alert("Enter dividend amount"); return; }
      if (!divAccId) { alert("Select account"); return; }
      const holding = holdings.find(h=>h.symbol===symbol);
      const divTx = {
        id:uid(), type:"income", date,
        amount:parseFloat(divAmount), currency:holding?.currency||"INR",
        accountId:divAccId, categoryId:incCats.find(c=>c.id==="ic_div")?.id||incCats[0]?.id,
        note:`Dividend: ${symbol}${note?` · ${note}`:""}`,
      };
      dispatch({type:"ADD_TX",payload:divTx});
      const ca = {id:uid(),symbol,action_type:"dividend",amount:parseFloat(divAmount),date,note};
      dispatch({type:"ADD_CORPORATE_ACTION",payload:ca});
      toast(`Dividend ₹${divAmount} credited as income`);
      onClose(); return;
    }

    if (actionType==="merger") {
      if (!toSymbol) { alert("Enter target symbol (stock merging into)"); return; }
      const targetSym = toSymbol.toUpperCase();
      // Auto-create target stock in master if not exists
      if (!stocks.find(s=>s.symbol===targetSym)) {
        dispatch({type:"ADD_STOCK",payload:{id:uid(),symbol:targetSym,name:toName||targetSym,type:"stock",exchange:""}});
      }
      // Get current holding qty
      const sourceHolding = holdings.find(h=>h.symbol===symbol);
      const sourceQty = sourceHolding?.quantity||sourceHolding?.units||0;
      // Add merger corporate action
      const ca = {id:uid(),symbol,action_type:"merger",to_symbol:targetSym,to_name:toName||targetSym,ratio:parseFloat(ratio)||1,date,note};
      dispatch({type:"ADD_CORPORATE_ACTION",payload:ca});
      toast(`Merger: ${symbol} → ${targetSym} applied`);
      onClose(); return;
    }

    if (actionType==="demerger") {
      const valid = demergerResults.filter(r=>r.symbol.trim());
      if (valid.length===0) { alert("Add at least one resulting stock"); return; }
      const r = parseFloat(ratio)||1;
      // Auto-add new stocks to master
      valid.forEach(res=>{
        const sym = res.symbol.toUpperCase();
        if (!stocks.find(s=>s.symbol===sym)) {
          dispatch({type:"ADD_STOCK",payload:{id:uid(),symbol:sym,name:res.name||sym,type:"stock",exchange:""}});
        }
      });
      const ca = {id:uid(),symbol,action_type:"demerger",ratio:r,result_symbols:valid.map(r=>r.toUpperCase?r.toUpperCase():r.symbol.toUpperCase()),result_stocks:valid.map(r=>({symbol:r.symbol.toUpperCase(),name:r.name||r.symbol,ratio:parseFloat(r.ratio)||1})),date,note};
      dispatch({type:"ADD_CORPORATE_ACTION",payload:ca});
      toast(`Demerger applied: ${symbol} → ${valid.map(r=>r.symbol.toUpperCase()).join(", ")}`);
      onClose(); return;
    }

    // stock_split / reverse_split / bonus
    const r = parseFloat(ratio);
    if (!r||r<=0) { alert("Enter a valid ratio"); return; }
    const ca = {id:uid(),symbol,action_type:actionType,ratio:r,date,note};
    dispatch({type:"ADD_CORPORATE_ACTION",payload:ca});
    const labels = {stock_split:`Split: ${symbol} ×${r}`,reverse_split:`Reverse split: ${symbol} ÷${r}`,bonus:`Bonus: ${symbol} ×${r}`};
    toast(labels[actionType]||"Applied");
    onClose();
  }

  function deleteAction(ca) {
    if (!window.confirm(`Delete this ${ca.action_type} action? Holdings will be reversed.`)) return;
    dispatch({type:"DELETE_CORPORATE_ACTION",payload:ca.id});
    toast("Corporate action deleted — holdings reversed");
  }

  return (
    <Modal title="Corporate Action" onClose={onClose}>
      {/* Tab: Add / History */}
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {[["add","➕ Add Action"],["history","📋 History"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)}
            style={{flex:1,padding:"8px",borderRadius:10,border:`2px solid ${tab===k?"#6366F1":"#E2E8F0"}`,background:tab===k?"#EEF2FF":"#fff",color:tab===k?"#6366F1":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>

      {tab==="history" && (
        <div>
          {corpActions.length===0 ? (
            <div style={{textAlign:"center",padding:32,color:"#94A3B8"}}>
              <div style={{fontSize:36}}>📋</div>
              <div style={{marginTop:8}}>No corporate actions yet</div>
            </div>
          ) : [...corpActions].reverse().map(ca=>(
            <div key={ca.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"12px 0",borderBottom:"1px solid #F1F5F9"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,color:"#0F172A"}}>{ca.symbol} · {ca.action_type.replace(/_/g," ")}</div>
                <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{fmtDate(ca.date)}{ca.ratio?` · ×${ca.ratio}`:""}{ca.new_symbol?` → ${ca.new_symbol}`:""}{ca.to_symbol?` → ${ca.to_symbol}`:""}{ca.note?` · ${ca.note}`:""}</div>
              </div>
              <button onClick={()=>deleteAction(ca)}
                style={{fontSize:11,padding:"4px 10px",borderRadius:7,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600,flexShrink:0}}>🗑️ Delete</button>
            </div>
          ))}
          <Btn variant="ghost" onClick={onClose} style={{width:"100%",marginTop:16}}>Close</Btn>
        </div>
      )}

      {tab==="add" && (
        <>
          <Field label="Action Type">
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {ACTION_TYPES.map(at=>(
                <button key={at.value} onClick={()=>setActionType(at.value)}
                  style={{padding:"9px 14px",borderRadius:10,border:`2px solid ${actionType===at.value?"#6366F1":"#E2E8F0"}`,background:actionType===at.value?"#EEF2FF":"#fff",color:actionType===at.value?"#6366F1":"#475569",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                  <div>{at.label}</div>
                  <div style={{fontSize:11,color:"#94A3B8",marginTop:1,fontWeight:400}}>{at.desc}</div>
                </button>
              ))}
            </div>
          </Field>

          {allSymbols.length>0
            ? <Sel label="Stock Symbol" value={symbol} onChange={e=>setSymbol(e.target.value)}>
                {allSymbols.map(s=><option key={s} value={s}>{s}</option>)}
              </Sel>
            : <Inp label="Stock Symbol" value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="e.g. RELIANCE" />
          }

          <Inp label="Action Date" type="date" value={date} onChange={e=>setDate(e.target.value)} />

          {(actionType==="stock_split"||actionType==="reverse_split"||actionType==="bonus")&&(
            <Inp label={
              actionType==="stock_split"?"Split Ratio (e.g. 2 for 1→2)":
              actionType==="reverse_split"?"Merge Ratio (e.g. 10 for 10→1)":
              "Bonus Ratio (e.g. 0.2 for 1 bonus per 5)"
            } type="number" inputMode="decimal" value={ratio} onChange={e=>setRatio(e.target.value)}
              placeholder={actionType==="bonus"?"e.g. 0.2":"e.g. 2"} />
          )}

          {actionType==="dividend"&&(
            <>
              <Inp label="Total Dividend Amount (₹)" type="number" inputMode="decimal" value={divAmount} onChange={e=>setDivAmount(e.target.value)} placeholder="e.g. 5000" />
              <Sel label="Credit to Account" value={divAccId} onChange={e=>setDivAccId(e.target.value)}>
                <option value="">Select account…</option>
                {bankAccs.map(a=><option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
              </Sel>
            </>
          )}

          {actionType==="stock_name_change"&&(
            <>
              <Inp label="New Symbol" value={newSymbol} onChange={e=>setNewSymbol(e.target.value.toUpperCase())} placeholder="e.g. NEWTCS" />
              <Inp label="New Name (optional)" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. New Company Name" />
            </>
          )}

          {actionType==="merger"&&(
            <>
              <Inp label="Merging Into Symbol (Target)" value={toSymbol} onChange={e=>setToSymbol(e.target.value.toUpperCase())} placeholder="e.g. HDFC" note="If not in Stocks Master, it will be auto-created" />
              <Inp label="Target Stock Name" value={toName} onChange={e=>setToName(e.target.value)} placeholder="e.g. HDFC Bank" />
              <Inp label="Exchange Ratio (optional)" type="number" value={ratio} onChange={e=>setRatio(e.target.value)} placeholder="e.g. 1 (1:1 swap)" />
            </>
          )}

          {actionType==="demerger"&&(
            <>
              <Field label="Resulting Stocks">
                {demergerResults.map((r,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 60px 28px",gap:6,marginBottom:6,alignItems:"end"}}>
                    <Inp label={i===0?"Symbol":""} value={r.symbol} onChange={e=>updDemergerResult(i,"symbol",e.target.value.toUpperCase())} placeholder="Symbol" style={{marginBottom:0}} />
                    <Inp label={i===0?"Name":""} value={r.name} onChange={e=>updDemergerResult(i,"name",e.target.value)} placeholder="Name" style={{marginBottom:0}} />
                    <Inp label={i===0?"Ratio":""} type="number" value={r.ratio} onChange={e=>updDemergerResult(i,"ratio",e.target.value)} placeholder="1" style={{marginBottom:0}} />
                    <button onClick={()=>delDemergerResult(i)} style={{width:28,height:42,borderRadius:7,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>×</button>
                  </div>
                ))}
                <Btn variant="ghost" size="sm" onClick={addDemergerResult} style={{width:"100%",marginTop:4}}>+ Add Stock</Btn>
              </Field>
            </>
          )}

          <Inp label="Note (optional)" value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional…" />
          <BtnRow>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn onClick={save}>Apply Action</Btn>
          </BtnRow>
        </>
      )}
    </Modal>
  );
}

// ─── INVESTMENTS VIEW ─────────────────────────────────────────────────────────
function InvestmentsView({ state, dispatch }) {
  const [showAdd,          setShowAdd]          = useState(false);
  const [showImport,       setShowImport]       = useState(false);
  const [showCorpAction,   setShowCorpAction]   = useState(false);
  const [showStocksMaster, setShowStocksMaster] = useState(false);
  const [tab,              setTab]              = useState("holdings");
  const [openHoldingId,    setOpenHoldingId]    = useState(null);
  const [editHistoryTrade, setEditHistoryTrade] = useState(null);
  const [bulkSelectMode,   setBulkSelectMode]   = useState(false);
  const [selectedSymbols,  setSelectedSymbols]  = useState([]);
  const [selectedTrades,   setSelectedTrades]   = useState(new Set()); // for bulk delete in history tab

  // Listen for FAB event from App
  useEffect(()=>{
    const h = ()=>setShowAdd(true);
    document.addEventListener("wm:addTrade",h);
    return ()=>document.removeEventListener("wm:addTrade",h);
  },[]);

  const accounts     = state?.accounts    ||[];
  const investmentTx = state?.investmentTx||[];
  const fixedDeposits= state?.fixedDeposits||[];
  const fxRates      = state?.fxRates     ||DEFAULT.fxRates;
  const marketPrices = state?.marketPrices ||{};

  const holdings = state?.holdings||[];

  const stocks = holdings.filter(h=>h.type==="stock");
  const mfs    = holdings.filter(h=>h.type==="mf");
  const holdingCurrentVal = h => h.investedAmount||(h.quantity||h.units||0)*(h.avgPrice||h.nav||0)||0;
  const stockVal = stocks.reduce((s,h)=>s+toINR(holdingCurrentVal(h),h.currency,fxRates),0);
  const mfVal    = mfs.reduce(  (s,h)=>s+toINR(holdingCurrentVal(h),h.currency,fxRates),0);
  const fdVal    = fixedDeposits.filter(fd=>fd.status!=="closed").reduce((s,fd)=>s+toINR(parseFloat(fd.amount)||0,fd.currency||"INR",fxRates),0);
  const sortedTx = [...investmentTx].sort((a,b)=>new Date(b.date)-new Date(a.date));

  function toggleHolding(id) {
    setOpenHoldingId(prev => prev===id ? null : id);
  }

  function toggleBulkSelect(sym) {
    setSelectedSymbols(prev => prev.includes(sym) ? prev.filter(s=>s!==sym) : [...prev,sym]);
  }

  function bulkDelete() {
    if (selectedSymbols.length===0) return;
    if (!window.confirm(`Delete ALL trades and holdings for: ${selectedSymbols.join(", ")}?\nThis cannot be undone.`)) return;
    dispatch({type:"BULK_DELETE_HOLDINGS", payload:selectedSymbols});
    setSelectedSymbols([]); setBulkSelectMode(false);
    toast(`Deleted ${selectedSymbols.length} holding(s)`);
  }


  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Investments</h2>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <Btn variant="ghost" size="sm" onClick={()=>setShowStocksMaster(true)}>📚 Master</Btn>
          <Btn variant="ghost" size="sm" onClick={()=>setShowImport(true)}>⬆️ Import</Btn>
          <Btn variant="warning" size="sm" onClick={()=>setShowCorpAction(true)}>⚡ Corp.</Btn>

          <Btn size="sm" onClick={()=>setShowAdd(true)}>+ Trade</Btn>
        </div>
      </div>

      {/* Bulk delete toolbar */}
      {tab==="holdings" && holdings.length>0 && (
        <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",flexWrap:"wrap"}}>
          <button onClick={()=>{setBulkSelectMode(p=>!p);setSelectedSymbols([]);}}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #E2E8F0",background:bulkSelectMode?"#EEF2FF":"#F8FAFC",color:bulkSelectMode?"#6366F1":"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
            {bulkSelectMode?"✕ Cancel":"☑️ Bulk Select"}
          </button>
          {bulkSelectMode && (() => {
            const allSyms = [...new Set((state?.holdings||[]).map(h=>h.symbol))];
            const allSelected = allSyms.length > 0 && allSyms.every(s=>selectedSymbols.includes(s));
            return (
              <button onClick={()=>setSelectedSymbols(allSelected ? [] : allSyms)}
                style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                {allSelected ? "☐ Deselect All" : "☑ Select All"}
              </button>
            );
          })()}
          {bulkSelectMode && selectedSymbols.length>0 && (
            <button onClick={bulkDelete}
              style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>
              🗑️ Delete {selectedSymbols.length} Selected
            </button>
          )}
          {bulkSelectMode && <span style={{fontSize:11,color:"#94A3B8"}}>Tap a holding to select · delete removes all trades</span>}
        </div>
      )}

      {/* ── Portfolio Summary Bar (7): total invested, current value, P&L ── */}
      {(stocks.length>0||mfs.length>0)&&(()=>{
        const totalInvested = [...stocks,...mfs].reduce((s,h)=>s+toINR(h.investedAmount||0,h.currency,fxRates),0);
        const totalCurrent  = [...stocks,...mfs].reduce((s,h)=>s+toINR(holdingCurrentVal(h),h.currency,fxRates),0);
        const pnl           = totalCurrent - totalInvested;
        const pnlPct        = totalInvested>0?(pnl/totalInvested)*100:0;
        const isGain        = pnl>=0;
        return (
          <Card style={{marginBottom:16,background:"linear-gradient(135deg,#0F172A,#1E293B)",color:"#fff",padding:"16px 18px"}}>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Portfolio Summary</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:12}}>
              <div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:3}}>Total Invested</div>
                <div style={{fontSize:20,fontWeight:800,color:"#fff"}}>{fmtINR(totalInvested)}</div>
              </div>
              <div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:3}}>Current Value</div>
                <div style={{fontSize:20,fontWeight:800,color:"#A7F3D0"}}>{fmtINR(totalCurrent)}</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,0.08)",borderRadius:10,padding:"10px 14px"}}>
              <div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Total P&L</div>
                <div style={{fontSize:17,fontWeight:800,color:isGain?"#6EE7B7":"#FCA5A5"}}>
                  {isGain?"+":"−"}{fmtINR(Math.abs(pnl))}
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Returns</div>
                <div style={{fontSize:20,fontWeight:800,color:isGain?"#6EE7B7":"#FCA5A5"}}>
                  {isGain?"+":""}{pnlPct.toFixed(2)}%
                </div>
              </div>
            </div>
          </Card>
        );
      })()}

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(min(100%,140px),1fr))",gap:10,marginBottom:20}}>
        {[
          {label:"Portfolio",        value:fmtINR(stockVal+mfVal+fdVal), color:"#6366F1", bg:"#EEF2FF", icon:"📊"},
          {label:`Stocks (${stocks.length})`,  value:fmtINR(stockVal),  color:"#0EA5E9", bg:"#F0F9FF", icon:"📈"},
          {label:`MF (${mfs.length})`,         value:fmtINR(mfVal),     color:"#10B981", bg:"#F0FDF4", icon:"📉"},
          {label:`FD (${fixedDeposits.filter(f=>f.status!=="closed").length})`,value:fmtINR(fdVal),    color:"#F59E0B", bg:"#FFFBEB", icon:"🏦"},
        ].map(s=>(
          <Card key={s.label} style={{background:s.bg,padding:12,textAlign:"center"}}>
            <div style={{fontSize:18,marginBottom:4}}>{s.icon}</div>
            <div style={{fontSize:13,fontWeight:800,color:s.color}}>{s.value}</div>
            <div style={{fontSize:10,color:"#64748B",marginTop:2}}>{s.label}</div>
          </Card>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {[["holdings","Holdings"],["fd","Fixed Deposits"],["history","Trade History"],["profits","Profits"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)}
            style={{flexShrink:0,padding:"8px 18px",borderRadius:20,border:`2px solid ${tab===k?"#6366F1":"#E2E8F0"}`,background:tab===k?"#EEF2FF":"#fff",color:tab===k?"#6366F1":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>

      {/* ── Holdings tab ── */}
      {tab==="holdings"&&(
        <div>
          {holdings.length===0&&(
            <Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}>
              <div style={{fontSize:48}}>📊</div>
              <div style={{marginTop:8,fontWeight:600}}>No holdings yet</div>
              <div style={{fontSize:13,marginTop:4}}>Add a trade to get started</div>
            </Card>
          )}
          {stocks.length>0&&(
            <div style={{marginBottom:20}}>
              <div style={{fontWeight:700,fontSize:13,color:"#475569",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>📊 Stocks</div>
              <Card style={{padding:0}}>
                {stocks.map(h=>(
                  <HoldingRow key={h.id} holding={h} investmentTx={investmentTx}
                    accounts={accounts} state={state} dispatch={dispatch}
                    openId={openHoldingId} onToggle={toggleHolding}
                    bulkSelectMode={bulkSelectMode}
                    isSelected={selectedSymbols.includes(h.symbol)}
                    onBulkSelect={()=>toggleBulkSelect(h.symbol)} />
                ))}
              </Card>
            </div>
          )}
          {mfs.length>0&&(
            <div>
              <div style={{fontWeight:700,fontSize:13,color:"#475569",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>📈 Mutual Funds</div>
              <Card style={{padding:0}}>
                {mfs.map(h=>(
                  <HoldingRow key={h.id} holding={h} investmentTx={investmentTx}
                    accounts={accounts} state={state} dispatch={dispatch}
                    openId={openHoldingId} onToggle={toggleHolding}
                    bulkSelectMode={bulkSelectMode}
                    isSelected={selectedSymbols.includes(h.symbol)}
                    onBulkSelect={()=>toggleBulkSelect(h.symbol)} />
                ))}
              </Card>
            </div>
          )}
        </div>
      )}

      {/* ── Fixed Deposits tab ── */}
      {tab==="fd"&&(
        <div>
          {fixedDeposits.length===0&&(
            <Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}>
              <div style={{fontSize:40}}>🏦</div>
              <div style={{marginTop:8,fontWeight:600}}>No fixed deposits</div>
              <div style={{fontSize:13,marginTop:4}}>Add a trade → select Fixed Deposit</div>
            </Card>
          )}
          {fixedDeposits.map(fd=>(
            <FDCard key={fd.id} fd={fd} accounts={accounts} dispatch={dispatch} state={state} />
          ))}
        </div>
      )}

      {/* ── Trade History tab ── */}
      {tab==="history"&&(
        <div>
          {/* Bulk-select toolbar */}
          {sortedTx.length>0&&(
            <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",flexWrap:"wrap"}}>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,fontWeight:600,color:"#475569",cursor:"pointer",userSelect:"none"}}>
                <input type="checkbox"
                  checked={selectedTrades.size===sortedTx.length && sortedTx.length>0}
                  onChange={e=>setSelectedTrades(e.target.checked ? new Set(sortedTx.map(t=>t.id)) : new Set())}
                  style={{width:16,height:16,cursor:"pointer"}} />
                Select All
              </label>
              {selectedTrades.size>0&&(
                <button onClick={()=>{
                  if(!window.confirm(`Delete ${selectedTrades.size} selected trade(s)? Holdings and balances will be recalculated.`))return;
                  dispatch({type:"BULK_DELETE_INVESTMENT_TXS", payload:[...selectedTrades]});
                  setSelectedTrades(new Set());
                  toast(`${selectedTrades.size} trade(s) deleted — holdings recalculated`);
                }} style={{fontSize:12,padding:"5px 14px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>
                  🗑️ Delete {selectedTrades.size} Selected
                </button>
              )}
              {selectedTrades.size>0&&(
                <button onClick={()=>setSelectedTrades(new Set())}
                  style={{fontSize:12,padding:"5px 10px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#64748B",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                  ✕ Clear
                </button>
              )}
            </div>
          )}
          {sortedTx.length===0
            ? <Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}><div style={{fontSize:40}}>📭</div><div style={{marginTop:8}}>No trades yet</div></Card>
            : <div style={{display:"flex",flexDirection:"column",gap:0}}>
                {sortedTx.map(itx=>{
                  const h=holdings.find(h=>h.id===itx.holdingId);
                  const cur=itx.currency||"INR";
                  const total=(parseFloat(itx.quantity)||0)*(parseFloat(itx.price)||0);
                  const srcAcc=accounts.find(a=>a.id===itx.sourceAccountId);
                  const isChecked=selectedTrades.has(itx.id);
                  return (
                    <Card key={itx.id} style={{borderRadius:0,boxShadow:"none",borderBottom:"1px solid #F1F5F9",padding:"12px 14px",background:isChecked?"#FEF2F2":"#fff"}}>
                      <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                        <input type="checkbox" checked={isChecked}
                          onChange={e=>{
                            const s=new Set(selectedTrades);
                            e.target.checked ? s.add(itx.id) : s.delete(itx.id);
                            setSelectedTrades(s);
                          }}
                          style={{width:16,height:16,marginTop:3,cursor:"pointer",flexShrink:0}} />
                        <span style={{fontSize:11,background:itx.type==="buy"?"#F0FDF4":"#FEF2F2",color:itx.type==="buy"?"#10B981":"#EF4444",padding:"3px 8px",borderRadius:10,fontWeight:700,flexShrink:0,marginTop:2}}>{itx.type.toUpperCase()}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                            <span style={{fontWeight:800,color:"#6366F1",fontSize:14}}>{itx.symbol||h?.symbol||"—"}</span>
                            <span style={{fontSize:12,color:"#0F172A",fontWeight:600}}>{fmtNum(itx.quantity)} × {fmtCur(itx.price,cur)}</span>
                          </div>
                          <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>
                            {fmtDate(itx.date)}{srcAcc?` · ${srcAcc.name}`:""}{itx.note?` · ${itx.note}`:""}
                          </div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontWeight:800,fontSize:14,color:itx.type==="buy"?"#EF4444":"#10B981"}}>
                            {itx.type==="buy"?"−":"+"}{fmtINR(toINR(total,cur,fxRates))}
                          </div>
                          <div style={{fontSize:10,color:"#94A3B8"}}>{cur!=="INR"?fmtCur(total,cur):""}</div>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:10,marginLeft:26}}>
                        <button onClick={()=>setEditHistoryTrade(itx)}
                          style={{flex:1,fontSize:12,padding:"6px 0",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                          ✏️ Edit
                        </button>
                        <button onClick={()=>{
                          if(!window.confirm("Delete this trade? Holdings and balances will be recalculated."))return;
                          dispatch({type:"DELETE_INVESTMENT_TX",payload:itx.id});
                          toast("Trade deleted — holdings recalculated");
                        }} style={{flex:1,fontSize:12,padding:"6px 0",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                          🗑️ Delete
                        </button>
                      </div>
                    </Card>
                  );
                })}
              </div>
          }
          {editHistoryTrade&&(
            <InvestModal
              state={state}
              editTx={editHistoryTrade}
              onClose={()=>setEditHistoryTrade(null)}
              onSave={({itx})=>{
                dispatch({type:"EDIT_INVESTMENT_TX",payload:itx});
                setEditHistoryTrade(null);
                toast("Trade updated — holdings recalculated");
              }}
            />
          )}
        </div>
      )}

      {/* ── Profits tab — per-stock summary only ── */}
      {tab==="profits"&&(()=>{
        const realized = buildRealizedTrades(investmentTx);
        const netPnl   = realized.reduce((s,r)=>s+r.pnl,0);

        // Aggregate by symbol
        const bySymbol = {};
        realized.forEach(r=>{
          if(!bySymbol[r.symbol]) bySymbol[r.symbol]={symbol:r.symbol,name:r.name,totalQty:0,totalPnl:0};
          bySymbol[r.symbol].totalQty += r.qty;
          bySymbol[r.symbol].totalPnl += r.pnl;
        });
        const summaries = Object.values(bySymbol).sort((a,b)=>Math.abs(b.totalPnl)-Math.abs(a.totalPnl));

        return (
          <div>
            {/* Summary banner */}
            <Card style={{background:netPnl>=0?"#F0FDF4":"#FEF2F2",border:`1.5px solid ${netPnl>=0?"#A7F3D0":"#FECACA"}`,marginBottom:16,padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{fontSize:11,color:"#64748B",marginBottom:2}}>Net Realized P&L</div>
                  <div style={{fontSize:26,fontWeight:800,color:netPnl>=0?"#10B981":"#EF4444"}}>
                    {netPnl>=0?"+":""}{fmtINR(netPnl)}
                  </div>
                </div>
                <div style={{display:"flex",gap:12}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#10B981"}}>{summaries.filter(s=>s.totalPnl>0).length}</div>
                    <div style={{fontSize:10,color:"#64748B"}}>Winning</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#EF4444"}}>{summaries.filter(s=>s.totalPnl<0).length}</div>
                    <div style={{fontSize:10,color:"#64748B"}}>Losing</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#6366F1"}}>{summaries.length}</div>
                    <div style={{fontSize:10,color:"#64748B"}}>Stocks</div>
                  </div>
                </div>
              </div>
            </Card>

            {summaries.length===0&&(
              <Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}>
                <div style={{fontSize:40}}>📊</div>
                <div style={{marginTop:8,fontWeight:600}}>No closed trades yet</div>
                <div style={{fontSize:13,marginTop:4}}>Sell a holding to see realized P&L here</div>
              </Card>
            )}

            {/* Per-stock summary cards */}
            {summaries.length>0&&(
              <Card style={{padding:0}}>
                <div style={{padding:"10px 14px",borderBottom:"1px solid #F1F5F9",display:"flex",justifyContent:"space-between",fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.05em"}}>
                  <span>Stock</span>
                  <span style={{display:"flex",gap:40}}><span>Shares Sold</span><span>Net P&L</span></span>
                </div>
                {summaries.map((s,i)=>(
                  <div key={s.symbol} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",borderBottom:i<summaries.length-1?"1px solid #F1F5F9":"none",background:s.totalPnl>=0?"#FAFFFE":"#FFFAFA"}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:14,color:"#0F172A"}}>{s.symbol}</div>
                      <div style={{fontSize:11,color:"#94A3B8",marginTop:1}}>{s.name}</div>
                    </div>
                    <div style={{display:"flex",gap:32,alignItems:"center"}}>
                      <div style={{textAlign:"center"}}>
                        <div style={{fontWeight:700,fontSize:14,color:"#475569"}}>{fmtNum(s.totalQty)}</div>
                        <div style={{fontSize:10,color:"#94A3B8"}}>shares sold</div>
                      </div>
                      <div style={{textAlign:"right",minWidth:90}}>
                        <div style={{fontWeight:800,fontSize:15,color:s.totalPnl>=0?"#10B981":"#EF4444"}}>
                          {s.totalPnl>=0?"+":""}{fmtINR(s.totalPnl)}
                        </div>
                        <div style={{fontSize:10,color:s.totalPnl>=0?"#10B981":"#EF4444",fontWeight:600}}>
                          {s.totalPnl>=0?"Net Profit":"Net Loss"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </div>
        );
      })()}
      {showAdd&&(
        <InvestModal state={state} onClose={()=>setShowAdd(false)}
          onSave={({itx,newHolding,fd,isFD})=>{
            if(isFD){
              dispatch({type:"ADD_FD",payload:fd});
            } else {
              dispatch({type:"ADD_INVESTMENT",payload:{itx,newHolding}});
            }
          }}
        />
      )}
      {showStocksMaster&&<StocksMasterModal state={state} dispatch={dispatch} onClose={()=>setShowStocksMaster(false)} />}
      {showImport&&<ImportModal state={state} dispatch={dispatch} onClose={()=>setShowImport(false)} />}
      {showCorpAction&&<CorporateActionModal state={state} dispatch={dispatch} onClose={()=>setShowCorpAction(false)} />}
    </div>
  );
}


// ─── REPORTS VIEW ─────────────────────────────────────────────────────────────
// Layout: icon grid (row-based), with Expense by Category and P&L reports
function ReportsView({ state }) {
  const transactions  = state?.transactions      ||[];
  const expCats       = state?.expenseCategories ||DEFAULT.expenseCategories;
  const incCats       = state?.incomeCategories   ||DEFAULT.incomeCategories;
  const fxRates       = state?.fxRates            ||DEFAULT.fxRates;
  const holdings      = state?.holdings           ||[];
  const fixedDeposits = state?.fixedDeposits      ||[];
  const marketPrices  = state?.marketPrices       ||{};

  // Sub-report state
  const [activeReport, setActiveReport] = useState(null); // null | "expense_cat" | "pnl"
  const [catDetail,    setCatDetail]    = useState(null); // selected category for drill-down

  const months = [...new Set(transactions.map(t=>{const d=new Date(t.date+"T00:00:00");return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;}))] .sort().reverse();
  const [sel,setSel] = useState(months[0]||"");

  const mTxs = transactions.filter(t=>{
    if(!sel) return true;
    const d=new Date(t.date+"T00:00:00");
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`===sel;
  });

  const income  = mTxs.filter(t=>t.type==="income"&&!(t.isRefund||t.is_refund)).reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const grossExp= mTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const totalRef= mTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(parseFloat(t.refundedAmount)||0,t.currency,fxRates),0);
  const expense = grossExp - totalRef;

  function breakdown(type, cats) {
    const m={};
    mTxs.filter(t=>t.type===type).forEach(t=>{
      const cat=cats.find(c=>c.id===t.categoryId);
      const k=cat?cat.id:"other";
      const net = type==="expense"?(parseFloat(t.amount)||0)-(parseFloat(t.refundedAmount)||0):parseFloat(t.amount)||0;
      m[k]=(m[k]||0)+toINR(net,t.currency,fxRates);
    });
    return Object.entries(m).map(([id,val])=>{
      const cat=cats.find(c=>c.id===id);
      return {id,label:cat?`${cat.icon} ${cat.name}`:"🏷️ Other",val};
    }).sort((a,b)=>b.val-a.val);
  }
  const expBreak=breakdown("expense",expCats);
  const total=expBreak.reduce((s,r)=>s+r.val,0)||1;

  // Pie chart colors
  const PIE_COLORS=["#6366F1","#10B981","#F59E0B","#EF4444","#3B82F6","#EC4899","#8B5CF6","#06B6D4","#84CC16","#D97706"];

  // Drill-down transactions for a category
  const catTxs = catDetail ? mTxs.filter(t=>t.type==="expense"&&t.categoryId===catDetail) : [];

  // P&L data — CLOSED trades only (FIFO realized), not open holdings
  function getPnlRows() {
    const investmentTx = state?.investmentTx || [];
    const realized = buildRealizedTrades(investmentTx);

    // Aggregate by symbol: sum up pnl, buy cost, sell value
    const bySymbol = {};
    realized.forEach(r => {
      if (!bySymbol[r.symbol]) {
        bySymbol[r.symbol] = {
          type:     r.type === "mf" ? "MF" : "Stock",
          symbol:   r.symbol,
          name:     r.name,
          costBasis:  0,
          sellValue:  0,
          pnl:        0,
          qty:        0,
        };
      }
      const g = bySymbol[r.symbol];
      g.costBasis += r.buyPrice  * r.qty;
      g.sellValue += r.sellPrice * r.qty;
      g.pnl       += r.pnl;
      g.qty       += r.qty;
    });

    return Object.values(bySymbol).map(g => ({
      type:     g.type,
      symbol:   g.symbol,
      name:     g.name,
      invested: g.costBasis,
      current:  g.sellValue,
      pnl:      g.pnl,
      pct:      g.costBasis > 0 ? (g.pnl / g.costBasis) * 100 : null,
    }));
  }

  // Report icon grid
  const REPORTS = [
    {id:"expense_cat", icon:"🥧", title:"Expense by Category", desc:"Pie chart breakdown"},
    {id:"pnl",         icon:"📈", title:"Profit & Loss",        desc:"Stocks, MF, FDs"},
  ];

  if (activeReport==="expense_cat") {
    return (
      <div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={()=>{setActiveReport(null);setCatDetail(null);}} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#6366F1"}}>←</button>
          <h2 style={{margin:0,fontSize:20,fontWeight:800,color:"#0F172A"}}>Expense by Category</h2>
          <select value={sel} onChange={e=>setSel(e.target.value)} style={{marginLeft:"auto",border:"1.5px solid #E2E8F0",borderRadius:10,padding:"7px 12px",fontSize:14,fontFamily:"inherit",outline:"none"}}>
            <option value="">All Time</option>
            {months.map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        {/* SVG Pie Chart */}
        {expBreak.length>0&&(()=>{
          const cx=120,cy=120,r=90,gap=2;
          let cumAngle=-Math.PI/2;
          const slices=expBreak.map((item,i)=>{
            const pct=item.val/total;
            const angle=pct*Math.PI*2;
            const x1=cx+r*Math.cos(cumAngle), y1=cy+r*Math.sin(cumAngle);
            cumAngle+=angle;
            const x2=cx+r*Math.cos(cumAngle), y2=cy+r*Math.sin(cumAngle);
            const large=angle>Math.PI?1:0;
            const path=`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`;
            return {...item,path,color:PIE_COLORS[i%PIE_COLORS.length],pct:pct*100};
          });
          return (
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:20}}>
              <svg width={240} height={240} viewBox="0 0 240 240">
                {slices.map((s,i)=>(
                  <path key={i} d={s.path} fill={catDetail===s.id?s.color+"dd":s.color}
                    stroke="#fff" strokeWidth={gap} cursor="pointer"
                    onClick={()=>setCatDetail(catDetail===s.id?null:s.id)} />
                ))}
                <circle cx={cx} cy={cy} r={50} fill="#fff"/>
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight={700} fill="#0F172A">{fmtINR(expense)}</text>
              </svg>
              {/* Legend */}
              <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center"}}>
                {slices.map((s,i)=>(
                  <button key={i} onClick={()=>setCatDetail(catDetail===s.id?null:s.id)}
                    style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:20,border:`1.5px solid ${catDetail===s.id?s.color:"#E2E8F0"}`,background:catDetail===s.id?s.color+"22":"#fff",cursor:"pointer",fontFamily:"inherit"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:s.color,flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:600,color:"#0F172A"}}>{s.label}</span>
                    <span style={{fontSize:11,color:"#64748B"}}>{s.pct.toFixed(1)}%</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Bar chart */}
        {expBreak.length>0&&(
          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>📊 Breakdown</div>
            {expBreak.map((item,i)=>(
              <div key={item.id} style={{marginBottom:10,cursor:"pointer"}} onClick={()=>setCatDetail(catDetail===item.id?null:item.id)}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3,fontSize:13}}>
                  <span style={{fontWeight:600,color:catDetail===item.id?"#6366F1":"#0F172A"}}>{item.label}</span>
                  <span style={{fontWeight:700,color:"#EF4444"}}>{fmtINR(item.val)}</span>
                </div>
                <div style={{background:"#F1F5F9",borderRadius:20,height:7,overflow:"hidden"}}>
                  <div style={{background:PIE_COLORS[i%PIE_COLORS.length],height:"100%",borderRadius:20,width:`${(item.val/total)*100}%`}}/>
                </div>
              </div>
            ))}
          </Card>
        )}

        {/* Drill-down transactions */}
        {catDetail&&catTxs.length>0&&(
          <Card>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>
              {expCats.find(c=>c.id===catDetail)?.icon} {expCats.find(c=>c.id===catDetail)?.name||"Other"} Transactions
            </div>
            {catTxs.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(tx=>(
              <div key={tx.id} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #F1F5F9",fontSize:13}}>
                <div>
                  <div style={{fontWeight:600,color:"#0F172A"}}>{tx.note||"—"}</div>
                  <div style={{fontSize:11,color:"#94A3B8"}}>{fmtDate(tx.date)}</div>
                </div>
                <div style={{fontWeight:700,color:"#EF4444"}}>{fmtCur(parseFloat(tx.amount)||0,tx.currency||"INR")}</div>
              </div>
            ))}
          </Card>
        )}
        {expBreak.length===0&&<Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}><div>No expenses found for this period</div></Card>}
      </div>
    );
  }

  if (activeReport==="pnl") {
    const pnlRows=getPnlRows();
    const totalCost=pnlRows.reduce((s,r)=>s+r.invested,0);
    const totalSell=pnlRows.reduce((s,r)=>s+r.current,0);
    const totalPnl =pnlRows.reduce((s,r)=>s+r.pnl,0);
    return (
      <div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={()=>setActiveReport(null)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#6366F1"}}>←</button>
          <h2 style={{margin:0,fontSize:20,fontWeight:800,color:"#0F172A"}}>Realized P&L</h2>
          <span style={{fontSize:12,color:"#94A3B8",marginLeft:4}}>Closed trades only</span>
        </div>
        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
          {[
            {label:"Total Cost Basis", val:fmtINR(totalCost),  color:"#0F172A",bg:"#F8FAFC"},
            {label:"Total Sell Value", val:fmtINR(totalSell),  color:"#6366F1",bg:"#EEF2FF"},
            {label:"Net Realized P&L", val:`${totalPnl>=0?"+":""}${fmtINR(totalPnl)}`,color:totalPnl>=0?"#10B981":"#EF4444",bg:totalPnl>=0?"#F0FDF4":"#FEF2F2"},
          ].map(s=>(
            <Card key={s.label} style={{background:s.bg,padding:12,textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:800,color:s.color}}>{s.val}</div>
              <div style={{fontSize:10,color:"#64748B",marginTop:2}}>{s.label}</div>
            </Card>
          ))}
        </div>
        {/* Rows */}
        {["Stock","MF"].map(type=>{
          const rows=pnlRows.filter(r=>r.type===type);
          if(rows.length===0) return null;
          return (
            <Card key={type} style={{marginBottom:12,padding:0}}>
              <div style={{padding:"10px 14px",borderBottom:"1px solid #F1F5F9",fontWeight:700,fontSize:13,color:"#475569"}}>
                {type==="Stock"?"📊 Stocks":"📈 Mutual Funds"}
              </div>
              {rows.map((r,i)=>(
                <div key={i} style={{padding:"10px 14px",borderBottom:i<rows.length-1?"1px solid #F1F5F9":"none"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div>
                      <span style={{fontWeight:700,fontSize:13,color:"#0F172A"}}>{r.symbol}</span>
                      <span style={{fontSize:11,color:"#94A3B8",marginLeft:6}}>{r.name}</span>
                    </div>
                    <span style={{fontWeight:700,fontSize:13,color:r.pnl>=0?"#10B981":"#EF4444"}}>{r.pnl>=0?"+":""}{fmtINR(r.pnl)}</span>
                  </div>
                  <div style={{display:"flex",gap:16,fontSize:11,color:"#64748B"}}>
                    <span>Cost: {fmtINR(r.invested)}</span>
                    <span>Sold: {fmtINR(r.current)}</span>
                    {r.pct!==null&&<span style={{fontWeight:600,color:r.pct>=0?"#10B981":"#EF4444"}}>{r.pct>=0?"+":""}{r.pct.toFixed(1)}%</span>}
                  </div>
                </div>
              ))}
            </Card>
          );
        })}
        {pnlRows.length===0&&(
          <Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}>
            <div style={{fontSize:40}}>📊</div>
            <div style={{marginTop:8,fontWeight:600}}>No closed trades yet</div>
            <div style={{fontSize:13,marginTop:4}}>Sell a holding to see realized P&L here</div>
          </Card>
        )}
      </div>
    );
  }

  // ── Main Reports landing page ──────────────────────────────────────────────
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Reports</h2>
      </div>

      {/* Quick summary */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:24}}>
        {[
          {label:"Month Income",  value:fmtINR(income),   color:"#10B981",bg:"#F0FDF4"},
          {label:"Month Expense", value:fmtINR(expense),  color:"#EF4444",bg:"#FEF2F2"},
          {label:"Savings",       value:fmtINR(income-expense), color:income-expense>=0?"#6366F1":"#EF4444",bg:"#EEF2FF"},
          {label:"Refunds",       value:fmtINR(totalRef), color:"#D97706",bg:"#FFFBEB"},
        ].map(s=>(
          <Card key={s.label} style={{background:s.bg,padding:14}}>
            <div style={{fontSize:16,fontWeight:800,color:s.color}}>{s.value}</div>
            <div style={{fontSize:12,color:"#64748B",marginTop:4}}>{s.label}</div>
          </Card>
        ))}
      </div>

      {/* Report icons grid — 2 per row */}
      <div style={{marginBottom:16,fontSize:12,color:"#64748B",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Available Reports</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
        {REPORTS.map(rpt=>(
          <button key={rpt.id} onClick={()=>setActiveReport(rpt.id)}
            style={{background:"#fff",borderRadius:16,padding:"20px 16px",border:"1.5px solid #E2E8F0",cursor:"pointer",fontFamily:"inherit",textAlign:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.05)",transition:"all 0.15s"}}>
            <div style={{fontSize:36,marginBottom:10}}>{rpt.icon}</div>
            <div style={{fontWeight:700,fontSize:14,color:"#0F172A",marginBottom:4}}>{rpt.title}</div>
            <div style={{fontSize:11,color:"#94A3B8"}}>{rpt.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── ACCOUNT TYPE INLINE MANAGER ─────────────────────────────────────────────
// Used inside Profile modal's "Account Types" tab (no nested modal).
// Same CRUD logic as AccTypeModal but renders inline (no Modal wrapper).
function AccTypeInlineManager({ state, dispatch }) {
  const cats     = state?.accountCategories || DEFAULT.accountCategories;
  const accounts = state?.accounts || [];
  const icons    = ["🏷️","🏦","💵","💳","📱","📈","📊","💰","🏧","🪙","🏠","🚗","✈️","🎮","📚","🔐","🏛️","💸","🏢","🛡️"];
  const colors   = ["#3B82F6","#10B981","#EF4444","#F59E0B","#8B5CF6","#06B6D4","#EC4899","#6B7280","#0EA5E9","#84CC16"];

  const [editing, setEditing] = useState(null);  // null=list, "new"=new, obj=edit
  const [name,    setName]    = useState("");
  const [icon,    setIcon]    = useState("🏷️");
  const [color,   setColor]   = useState(colors[0]);
  const [isCCType,setIsCCType]= useState(false);

  function startNew()  { setEditing("new"); setName(""); setIcon("🏷️"); setColor(colors[0]); setIsCCType(false); }
  function startEdit(c){ setEditing(c); setName(c.name); setIcon(c.icon); setColor(c.color||colors[0]); setIsCCType(!!c.isCreditCardType); }
  function cancel()    { setEditing(null); }

  function save() {
    if (!name.trim()) return;
    if (editing === "new") {
      dispatch({ type:"ADD_ACC_CAT", payload:{ id:uid(), name:name.trim(), icon, color, isCreditCardType:isCCType } });
      toast("Account type added");
    } else {
      dispatch({ type:"EDIT_ACC_CAT", payload:{ ...editing, name:name.trim(), icon, color, isCreditCardType:isCCType } });
      toast("Account type updated");
    }
    setEditing(null);
  }

  function del(cat) {
    const count = accounts.filter(a => a.categoryId === cat.id).length;
    if (count > 0) { toast(`"${cat.name}" used by ${count} account(s) — reassign first`, "error"); return; }
    dispatch({ type:"DEL_ACC_CAT", payload: cat.id });
    toast("Account type deleted");
  }

  if (editing !== null) {
    return (
      <div>
        <button onClick={cancel} style={{background:"none",border:"none",color:"#6366F1",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:14,padding:0}}>
          ← Back to list
        </button>
        <Inp label="Type Name" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Bank, Loan, Crypto…" />
        <Field label="Icon">
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {icons.map(ic=><button key={ic} onClick={()=>setIcon(ic)} style={{width:38,height:38,borderRadius:10,border:`2px solid ${icon===ic?"#6366F1":"#E2E8F0"}`,background:icon===ic?"#EEF2FF":"#F8FAFC",fontSize:19,cursor:"pointer"}}>{ic}</button>)}
          </div>
        </Field>
        <Field label="Color">
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {colors.map(c=><button key={c} onClick={()=>setColor(c)} style={{width:30,height:30,borderRadius:"50%",background:c,border:color===c?"3px solid #0F172A":"2px solid transparent",cursor:"pointer"}} />)}
          </div>
        </Field>
        <Toggle label="Is this a Credit Card type?" checked={isCCType} onChange={setIsCCType}
                note="Enables CC billing cycles and cashback for accounts of this type" />
        <BtnRow>
          <Btn variant="ghost" onClick={cancel}>Cancel</Btn>
          <Btn onClick={save}>{editing==="new"?"Add Type":"Save Changes"}</Btn>
        </BtnRow>
      </div>
    );
  }

  return (
    <div>
      <div style={{fontSize:13,color:"#64748B",marginBottom:12}}>
        Account types power the two-step account selector in the Add Transaction flow.
      </div>
      <Btn onClick={startNew} style={{width:"100%",marginBottom:12}}>+ New Account Type</Btn>
      {cats.length===0&&<div style={{fontSize:13,color:"#94A3B8",textAlign:"center",padding:16}}>No account types yet.</div>}
      {cats.map(cat => {
        const count = accounts.filter(a => a.categoryId === cat.id).length;
        return (
          <div key={cat.id} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 0",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{width:34,height:34,borderRadius:9,background:cat.color+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{cat.icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:14,display:"flex",alignItems:"center",gap:6}}>
                {cat.name}
                {cat.isCreditCardType&&<span style={{fontSize:10,background:"#FEF2F2",color:"#EF4444",padding:"1px 6px",borderRadius:10,fontWeight:700}}>CC</span>}
              </div>
              <div style={{fontSize:11,color:"#94A3B8"}}>{count} account{count!==1?"s":""}</div>
            </div>
            <button onClick={()=>startEdit(cat)} style={{fontSize:12,padding:"4px 9px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️</button>
            <button onClick={()=>del(cat)}        style={{fontSize:12,padding:"4px 9px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── PROFILE MODAL ────────────────────────────────────────────────────────────
// Combines: logout, master record for CC management, FX rates
function ProfileModal({ state, dispatch, user, onLogout, onClose }) {
  const [tab,setTab]         = useState("profile");
  const [showAccType,setShowAccType] = useState(false);
  const accounts     = state?.accounts||[];
  const ccAccounts   = accounts.filter(a=>a.isCreditCard);
  const [editingCC,  setEditingCC] = useState(null);

  return (
    <Modal title="Profile & Settings" onClose={onClose}>
      {/* Tab row */}
      <div style={{display:"flex",gap:8,marginBottom:20,overflowX:"auto",paddingBottom:4}}>
        {[["profile","👤 Profile"],["types","🏷️ Acc Types"],["master","💳 CC Master"],["fx","💱 FX Rates"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{flexShrink:0,padding:"8px 14px",borderRadius:20,border:`1.5px solid ${tab===k?"#6366F1":"#E2E8F0"}`,background:tab===k?"#EEF2FF":"#fff",color:tab===k?"#6366F1":"#64748B",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>{l}</button>
        ))}
      </div>

      {tab==="profile"&&(
        <div>
          <div style={{background:"#F8FAFC",borderRadius:12,padding:16,marginBottom:20}}>
            <div style={{fontSize:12,color:"#64748B",marginBottom:4,textTransform:"uppercase",fontWeight:600}}>Logged in as</div>
            <div style={{fontWeight:700,fontSize:15,color:"#0F172A",wordBreak:"break-all"}}>{user?.email}</div>
          </div>
          <Btn variant="danger" onClick={onLogout} style={{width:"100%"}}>🚪 Log Out</Btn>
        </div>
      )}

      {tab==="types"&&(
        <AccTypeInlineManager state={state} dispatch={dispatch} />
      )}

      {tab==="master"&&(
        <div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:16}}>Manage cashback tiers and billing settings for your credit cards.</div>
          {ccAccounts.length===0?(
            <div style={{textAlign:"center",padding:32,color:"#94A3B8"}}>
              <div style={{fontSize:36}}>💳</div>
              <div style={{marginTop:8}}>No credit cards added yet.</div>
              <div style={{fontSize:12,marginTop:4}}>Add a Credit Card account to configure cashback tiers.</div>
            </div>
          ):ccAccounts.map(acc=>(
            <div key={acc.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderBottom:"1px solid #F1F5F9"}}>
              <div>
                <div style={{fontWeight:600,fontSize:14}}>{acc.icon} {acc.name}</div>
                <div style={{fontSize:12,color:"#94A3B8"}}>
                  Bill: {acc.billDay||"?"}th · Due: {acc.dueDay||"?"}th ·{" "}
                  {(acc.cbTiers||[]).length} tier(s) ·{" "}
                  CB: {acc.cbType==="limited"?"Limited":"Unlimited"} / {acc.cbTiming==="after"?"After bill":"Before bill"}
                </div>
              </div>
              <Btn size="sm" variant="ghost" onClick={()=>setEditingCC(acc)}>Edit</Btn>
            </div>
          ))}
        </div>
      )}

      {tab==="fx"&&(
        <FxInline rates={state?.fxRates||DEFAULT.fxRates} dispatch={dispatch} />
      )}

      {editingCC&&(
        <CreditCardSettingsModal
          acc={{...editingCC, _stateRef:{accounts}}}
          onClose={()=>setEditingCC(null)}
          onSave={updated=>{const{_stateRef,...clean}=updated;dispatch({type:"EDIT_ACCOUNT",payload:clean});setEditingCC(null);}}
        />
      )}
    </Modal>
  );
}

// Inline FX editor for Profile modal (no extra modal)
function FxInline({ rates, dispatch }) {
  const [local,setLocal] = useState({...rates});
  return (
    <div>
      <div style={{background:"#EEF2FF",border:"1.5px solid #C7D2FE",borderRadius:10,padding:12,marginBottom:16,fontSize:13,color:"#3730A3"}}>
        💡 Set how much 1 unit of each currency equals in INR.
      </div>
      {CURRENCIES.filter(c=>c.code!=="INR").map(c=>(
        <div key={c.code} style={{display:"grid",gridTemplateColumns:"52px 1fr",gap:8,marginBottom:10,alignItems:"center"}}>
          <div style={{fontWeight:700,fontSize:13,color:"#475569"}}>{c.code}</div>
          <input type="number" inputMode="decimal"
            value={local[c.code]||""}
            onChange={e=>setLocal(p=>({...p,[c.code]:parseFloat(e.target.value)||0}))}
            style={{...inputStyle}} placeholder={`1 ${c.code} = ₹?`} />
        </div>
      ))}
      <Btn onClick={()=>{dispatch({type:"SET_FX",payload:local});toast("Exchange rates saved");}} style={{width:"100%",marginTop:4}}>Save Rates</Btn>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const NAV = [
  {id:"dashboard",    label:"Dashboard",    icon:"🏠"},
  {id:"accounts",     label:"Accounts",     icon:"🏦"},
  {id:"transactions", label:"Transactions", icon:"↕️"},
  {id:"investments",  label:"Investments",  icon:"📈"},
  {id:"reports",      label:"Reports",      icon:"📊"},
];

export default function App() {
  const [user,        setUser]        = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [state,       dispatch]       = useReducer(reducer, undefined, loadLocal);
  const [view,        setView]        = useState(() => {
    try { return localStorage.getItem("wealthmap_view") || "dashboard"; } catch { return "dashboard"; }
  });
  const [online,      setOnline]      = useState(typeof navigator!=="undefined"?navigator.onLine:true);
  const [quickAdd,    setQuickAdd]    = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [syncStatus,  setSyncStatus]  = useState("idle");
  // Context-aware FAB: each view can register its own action
  const fabActionRef = useRef(null);

  // Toast system
  const toasts = useToastSystem();

  // Refs for stale-closure-free async ops
  const syncTimer = useRef(null);
  const userRef   = useRef(null);
  const netRef    = useRef(true);
  const stateRef  = useRef(state);
  userRef.current  = user;
  netRef.current   = online;
  stateRef.current = state;

  // ── Auth
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setUser(data.session?.user||null);setAuthLoading(false);});
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,session)=>setUser(session?.user||null));
    return ()=>subscription.unsubscribe();
  },[]);

  // ── On login: pull cloud → smart merge
  useEffect(()=>{
    if (!user) return;
    let cancelled=false;
    (async()=>{
      setSyncStatus("syncing");
      try {
        const cloud=await pullCloud(user.id);
        if (!cancelled) {
          const cloudHasData=cloud&&((cloud.accounts?.length>0)||(cloud.transactions?.length>0)||(cloud.holdings?.length>0));
          if (cloudHasData) {
            dispatch({type:"SET",payload:cloud});
            saveLocal(cloud);
          } else {
            const local=stateRef.current;
            if ((local.accounts?.length>0)||(local.transactions?.length>0)) {
              await pushCloud(user.id,local).catch(console.error);
            }
          }
        }
      } catch(e){ console.error("Cloud sync:",e); }
      if (!cancelled) setSyncStatus("synced");
    })();
    return ()=>{cancelled=true;};
  },[user]);

  // ── Online/offline
  useEffect(()=>{
    const on=()=>setOnline(true), off=()=>setOnline(false);
    window.addEventListener("online",on); window.addEventListener("offline",off);
    return ()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[]);

  // ── Save locally + debounce cloud push on every state change
  useEffect(()=>{
    saveLocal(state);
    const u=userRef.current, isOnline=netRef.current;
    if (!u||!isOnline) return;
    setSyncStatus("syncing");
    clearTimeout(syncTimer.current);
    syncTimer.current=setTimeout(async()=>{
      try {
        await pushCloud(u.id,stateRef.current);
        setSyncStatus("synced");
      } catch(e) {
        console.error("Cloud push:",e);
        setSyncStatus("error");
      }
    },1500);
  },[state]);

  async function handleLogout() {
    await supabase.auth.signOut();
    setUser(null);
    setShowProfile(false);
  }

  // Persist view to localStorage whenever it changes
  useEffect(() => {
    try { localStorage.setItem("wealthmap_view", view); } catch {}
  }, [view]);

  // ── Live price auto-fetch: refresh all stock/MF prices every 5 minutes
  useEffect(() => {
    const stocks = stateRef.current?.stocks || [];
    if (stocks.length === 0) return;
    async function refreshPrices() {
      const symbols = stocks.map(s => s.symbol).filter(Boolean);
      if (symbols.length === 0) return;
      try {
        const prices = await fetchMultiplePrices(symbols);
        Object.entries(prices).forEach(([sym, price]) => {
          dispatch({ type: "UPDATE_MARKET_PRICE", payload: { symbol: sym, current_price: price } });
        });
      } catch { /* silent fail */ }
    }
    refreshPrices(); // immediate on mount
    const interval = setInterval(refreshPrices, 5 * 60 * 1000); // every 5 min
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // FAB config per view
  const fabConfig = {
    dashboard:    { label:"Add",          icon:"＋", action:()=>setQuickAdd(true) },
    transactions: { label:"Add",          icon:"＋", action:()=>setQuickAdd(true) },
    accounts:     { label:"Add Account",  icon:"🏦", action:()=>{ document.dispatchEvent(new CustomEvent("wm:addAccount")); } },
    investments:  { label:"Add Trade",    icon:"📊", action:()=>{ document.dispatchEvent(new CustomEvent("wm:addTrade")); } },
    reports:      { label:null,           icon:null, action:null }, // no FAB on reports
  };
  const fab = fabConfig[view] || fabConfig.dashboard;

  if (authLoading) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F8FAFC"}}>
      <div style={{textAlign:"center"}}>
        <div style={{width:56,height:56,background:"linear-gradient(135deg,#6366F1,#8B5CF6)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 16px"}}>💎</div>
        <div style={{color:"#64748B"}}>Loading…</div>
      </div>
    </div>
  );

  if (!user) return <AuthScreen onAuth={setUser} />;

  return (
    <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",background:"#F8FAFC",minHeight:"100vh",display:"flex",flexDirection:"column"}}>

      {/* ── Top bar: logo | + Add | Profile avatar ── */}
      <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:960,margin:"0 auto",padding:"0 14px",display:"flex",justifyContent:"space-between",alignItems:"center",height:54}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:30,height:30,background:"linear-gradient(135deg,#6366F1,#8B5CF6)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>💎</div>
            <span style={{fontWeight:800,fontSize:17,color:"#0F172A"}}>WealthMap</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {/* Sync indicator: small dot only, no persistent text */}
            {syncStatus==="syncing"&&<div style={{width:8,height:8,borderRadius:"50%",background:"#F59E0B",flexShrink:0,animation:"pulse 1s infinite"}} title="Syncing…"/>}
            {syncStatus==="error"&&<div style={{width:8,height:8,borderRadius:"50%",background:"#EF4444",flexShrink:0}} title="Sync error"/>}
            {/* Online dot (subtle, no text) */}
            <div style={{width:7,height:7,borderRadius:"50%",background:online?"#10B981":"#94A3B8",flexShrink:0}} title={online?"Online":"Offline"}/>
            {/* Profile button — Add moved to FAB below */}
            <button onClick={()=>setShowProfile(true)}
              style={{width:36,height:36,borderRadius:"50%",background:"linear-gradient(135deg,#6366F1,#8B5CF6)",border:"none",cursor:"pointer",color:"#fff",fontWeight:800,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {(user?.email||"U")[0].toUpperCase()}
            </button>
          </div>
        </div>
      </div>

      {/* ── Desktop navigation tabs (hidden on mobile) ── */}
      <div className="desktop-tabs" style={{background:"#fff",borderBottom:"1px solid #E2E8F0"}}>
        <div style={{maxWidth:960,margin:"0 auto",padding:"0 14px",display:"flex",gap:4,overflowX:"auto"}}>
          {NAV.map(n=>(
            <button key={n.id} onClick={()=>setView(n.id)}
              style={{display:"flex",alignItems:"center",gap:6,padding:"13px 14px",border:"none",background:"none",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:view===n.id?700:500,color:view===n.id?"#6366F1":"#64748B",borderBottom:`2px solid ${view===n.id?"#6366F1":"transparent"}`,whiteSpace:"nowrap",transition:"all 0.2s"}}>
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{maxWidth:960,margin:"0 auto",padding:"16px 12px 90px",width:"100%",boxSizing:"border-box",flex:1}}>
        {view==="dashboard"    && <DashboardView    state={state} />}
        {view==="accounts"     && <AccountsView     state={state} dispatch={dispatch} />}
        {view==="transactions" && <TransactionsView state={state} dispatch={dispatch} />}
        {view==="investments"  && <InvestmentsView  state={state} dispatch={dispatch} />}
        {view==="reports"      && <ReportsView      state={state} />}
      </div>

      {/* ── Context-aware FAB ─────────────────────────────────────────────────── */}
      {fab.action&&(
        <button
          onClick={fab.action}
          className="fab-add"
          style={{
            position:"fixed", zIndex:200,
            background:"linear-gradient(135deg,#6366F1,#8B5CF6)",
            color:"#fff", border:"none", borderRadius:28,
            boxShadow:"0 6px 24px rgba(99,102,241,0.45)",
            cursor:"pointer", fontFamily:"inherit",
            display:"flex", alignItems:"center", gap:8,
            fontWeight:700, fontSize:16,
            padding:"14px 22px",
          }}
          aria-label={fab.label||"Add"}
        >
          <span style={{fontSize:22,lineHeight:1}}>{fab.icon}</span>
          <span className="fab-label">{fab.label!=="Add"?fab.label:""}</span>
        </button>
      )}

      {/* ── Quick add transaction modal ── */}
      {quickAdd&&<TxModalWithDispatch state={state} dispatch={dispatch} onClose={()=>setQuickAdd(false)} onSave={tx=>{dispatch({type:"ADD_TX",payload:tx});setQuickAdd(false);}} />}

      {/* ── Profile modal ── */}
      {showProfile&&<ProfileModal state={state} dispatch={dispatch} user={user} onLogout={handleLogout} onClose={()=>setShowProfile(false)} />}

      {/* ── Mobile bottom navigation ── */}
      <div className="mobile-nav" style={{
        display:"none", position:"fixed", bottom:0, left:0, right:0,
        background:"#fff", borderTop:"1px solid #E2E8F0", zIndex:100,
        paddingBottom:"env(safe-area-inset-bottom,0px)",
      }}>
        {NAV.map(n=>(
          <button key={n.id} onClick={()=>setView(n.id)} style={{
            flex:1, border:"none", background:"none", padding:"10px 4px 8px",
            cursor:"pointer", display:"flex", flexDirection:"column",
            alignItems:"center", gap:3, minWidth:0,
          }}>
            <span style={{fontSize:20}}>{n.icon}</span>
            <span style={{fontSize:9,fontWeight:600,fontFamily:"inherit",color:view===n.id?"#6366F1":"#94A3B8"}}>{n.label}</span>
          </button>
        ))}
      </div>

      {/* ── Toast container ── */}
      <ToastContainer toasts={toasts} />

      {/* SheetJS for XLSX import */}
      {typeof window!=="undefined"&&!window.XLSX&&(<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js" />)}

      {/* ── Global styles ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        *, *::before, *::after { -webkit-tap-highlight-color:transparent; box-sizing:border-box; }
        ::-webkit-scrollbar { width:5px; height:5px; }
        ::-webkit-scrollbar-track { background:#F1F5F9; }
        ::-webkit-scrollbar-thumb { background:#CBD5E1; border-radius:3px; }

        /* Mobile nav visible, desktop tabs hidden on small screens */
        @media (max-width: 640px) {
          .mobile-nav  { display: flex !important; }
          .desktop-tabs{ display: none  !important; }
        }

        /* Prevent iOS auto-zoom on input focus (requires font-size ≥ 16px) */
        input, select, textarea { font-size: 16px !important; }
        @media (min-width: 641px) { input, select, textarea { font-size: 14px !important; } }

        /* Tables horizontal scroll on narrow screens */
        table { display: block; width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }

        /* Pill row scrollbar hidden */
        [style*="overflowX"] { scrollbar-width: none; }
        [style*="overflowX"]::-webkit-scrollbar { display: none; }

        /* Sync pulse animation */
        @keyframes pulse {
          0%,100%{ opacity:1; }
          50%    { opacity:0.4; }
        }

        /* FAB — floating Add button */
        .fab-add {
          bottom: 28px;
          right:  28px;
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .fab-add:hover {
          transform: scale(1.05);
          box-shadow: 0 8px 32px rgba(99,102,241,0.55);
        }
        .fab-add:active { transform: scale(0.97); }

        /* On mobile: center above the bottom nav */
        @media (max-width: 640px) {
          .fab-add {
            bottom: calc(64px + env(safe-area-inset-bottom, 0px));
            right: 50%;
            transform: translateX(50%);
            border-radius: 28px;
          }
          .fab-add:hover  { transform: translateX(50%) scale(1.05); }
          .fab-add:active { transform: translateX(50%) scale(0.97); }
          .fab-label { display: none; }  /* icon-only on mobile */
        }
      `}</style>
    </div>
  );
}
