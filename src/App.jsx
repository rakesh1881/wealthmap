// ============================================================
// WEALTHMAP v5.1
// Changes vs v5 (surgical modifications only):
//
//  1. FAB "+" button — removed from header, now fixed bottom-right
//     (desktop) / centered bottom (mobile). Thumb-friendly, never
//     overlaps content or bottom nav.
//
//  2. Dynamic Account Types — accountCategories fully user-managed:
//     create / edit / delete in Profile → Account Types.
//     isCreditCardType flag on category drives CC billing logic.
//     Delete blocked if any account uses the type.
//
//  3. Two-step account selection in Expense/Income modal:
//     Step 1 → pick Account Type (user-defined list)
//     Step 2 → pick Account filtered to that type only.
//
//  4. Category + optional Sub-category:
//     - subCategories[] array on each expense/income category.
//     - Sub-category selector appears only when parent has subs.
//     - subCategoryId stored on transaction (null when unused).
//     - TxCatModal: add/remove sub-categories per parent.
//     - TxRow and Reports display sub-category label when set.
// ============================================================

import { useState, useEffect, useReducer, useRef, useMemo, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://hqkqhgrfcwixqoehjfaj.supabase.co";
const SUPABASE_KEY = "sb_publishable_N-ZcUkVL6fF-pch1sZPg6Q_hbd8sUPv";
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY  = "wealthmap_v5";

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
    { id:"cat_other",  name:"Other",        icon:"🏷️", color:"#6B7280", isCreditCardType:false },
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
  transactions: [],
  holdings:     [],
  investmentTx: [],
  fxRates: { USD:83.5, EUR:91.2, GBP:106.5, JPY:0.56, SGD:62.1, AED:22.7, HKD:10.7, CHF:94.3, AUD:54.8 },
};

// ─── SANITIZE ─────────────────────────────────────────────────────────────────
function sanitize(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT };
  return {
    accounts:          Array.isArray(raw.accounts)          ? raw.accounts          : [],
    accountCategories: Array.isArray(raw.accountCategories) ? raw.accountCategories
                     : Array.isArray(raw.categories)        ? raw.categories        : DEFAULT.accountCategories,
    expenseCategories: Array.isArray(raw.expenseCategories) ? raw.expenseCategories : DEFAULT.expenseCategories,
    incomeCategories:  Array.isArray(raw.incomeCategories)  ? raw.incomeCategories  : DEFAULT.incomeCategories,
    transactions:      Array.isArray(raw.transactions)      ? raw.transactions      : [],
    holdings:          Array.isArray(raw.holdings)          ? raw.holdings          : [],
    investmentTx:      Array.isArray(raw.investmentTx)      ? raw.investmentTx      : [],
    fxRates: (raw.fxRates && typeof raw.fxRates === "object") ? raw.fxRates         : DEFAULT.fxRates,
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
// For regular accounts: openingBalance ± transaction effects.
function calcBalance(accountId, transactions, accounts) {
  const acc     = (accounts||[]).find(a => a.id === accountId);
  const opening = parseFloat(acc?.openingBalance) || 0;

  return (transactions||[]).reduce((bal, tx) => {
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
}

// ─── NET WORTH CALCULATOR ─────────────────────────────────────────────────────
// Net Worth = assets (includeInNetWorth=true) − CC payable balances
function calcNetWorth(accounts, transactions, fxRates) {
  let assets = 0;
  let ccPayable = 0;

  accounts.forEach(acc => {
    if (!acc.includeInNetWorth) return;
    if (acc.isCreditCard) {
      // CC payable is a liability
      const { payable, outstanding } = calcCCBalance(acc, transactions);
      ccPayable += toINR(payable + outstanding, acc.currency||"INR", fxRates);
    } else {
      const bal = calcBalance(acc.id, transactions, accounts);
      assets += toINR(bal, acc.currency||"INR", fxRates);
    }
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

// ─── REDUCER ─────────────────────────────────────────────────────────────────
function reducer(rawState, action) {
  const s = sanitize(rawState);
  switch (action.type) {
    case "SET":         return sanitize(action.payload);

    // ── Transactions ─────────────────────────────────────────────────────────
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
            // Mark fully refunded if refunded >= original amount
            isRefunded: next >= (parseFloat(t.amount)||0),
          };
        }),
      };
    }

    // ── Accounts ─────────────────────────────────────────────────────────────
    case "ADD_ACCOUNT":  return { ...s, accounts: [...s.accounts, action.payload] };
    case "EDIT_ACCOUNT": return { ...s, accounts: s.accounts.map(a =>
                           a.id === action.payload.id ? action.payload : a) };

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

    // ── Investments ───────────────────────────────────────────────────────────
    case "ADD_INVESTMENT": {
      const { newHolding, itx, txType, quantity, price, invType } = action.payload;
      let holdings = [...s.holdings];
      if (newHolding) {
        holdings = [...holdings, newHolding];
      } else {
        holdings = holdings.map(h => {
          if (h.id !== itx.holdingId) return h;
          const cur = h.quantity || h.units || 0;
          if (txType === "buy") {
            const newQty = cur + quantity;
            const newAvg = (cur*(h.avgPrice||h.nav||0) + quantity*price) / newQty;
            return invType==="stock" ? {...h, quantity:newQty, avgPrice:newAvg} : {...h, units:newQty, nav:price};
          } else {
            return invType==="stock" ? {...h, quantity:Math.max(0,cur-quantity)} : {...h, units:Math.max(0,cur-quantity)};
          }
        });
      }
      return {
        ...s,
        holdings: holdings.filter(h => (h.quantity||0)>0 || (h.units||0)>0 || newHolding?.id===h.id),
        investmentTx: [...s.investmentTx, itx],
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

// ─── ACCOUNT TYPE MODAL (CRUD) ────────────────────────────────────────────────
// Replaces old AccCatModal. Full create/edit/delete for account types.
// isCreditCardType flag enables CC billing logic for accounts of that type.
function AccTypeModal({ state, dispatch, onClose }) {
  const cats     = state?.accountCategories || DEFAULT.accountCategories;
  const accounts = state?.accounts || [];
  const icons    = ["🏷️","🏦","💵","💳","📱","📈","📊","💰","🏧","🪙","🏠","🚗","✈️","🎮","📚","🔐","🏛️","💸","🏢","🛡️"];
  const colors   = ["#3B82F6","#10B981","#EF4444","#F59E0B","#8B5CF6","#06B6D4","#EC4899","#6B7280","#0EA5E9","#84CC16"];

  // null = list view, "new" = add form, object = edit form
  const [editing, setEditing] = useState(null);
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
    const inUse = accounts.some(a => a.categoryId === cat.id);
    if (inUse) { toast(`"${cat.name}" is used by ${accounts.filter(a=>a.categoryId===cat.id).length} account(s) — reassign or delete them first`, "error"); return; }
    dispatch({ type:"DEL_ACC_CAT", payload: cat.id });
    toast("Account type deleted");
  }

  if (editing !== null) {
    return (
      <Modal title={editing==="new" ? "New Account Type" : "Edit Account Type"} onClose={cancel}>
        <Inp label="Type Name" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Bank, Loan, Crypto, PPF…" />
        <Field label="Icon">
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {icons.map(ic=><button key={ic} onClick={()=>setIcon(ic)} style={{width:40,height:40,borderRadius:10,border:`2px solid ${icon===ic?"#6366F1":"#E2E8F0"}`,background:icon===ic?"#EEF2FF":"#F8FAFC",fontSize:20,cursor:"pointer"}}>{ic}</button>)}
          </div>
        </Field>
        <Field label="Color">
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {colors.map(c=><button key={c} onClick={()=>setColor(c)} style={{width:32,height:32,borderRadius:"50%",background:c,border:color===c?"3px solid #0F172A":"2px solid transparent",cursor:"pointer"}} />)}
          </div>
        </Field>
        <Toggle
          label="Is this a Credit Card type?"
          checked={isCCType} onChange={setIsCCType}
          note="Enables CC billing cycles and cashback for accounts of this type"
        />
        <BtnRow>
          <Btn variant="ghost" onClick={cancel}>Back</Btn>
          <Btn onClick={save}>{editing==="new"?"Add Type":"Save Changes"}</Btn>
        </BtnRow>
      </Modal>
    );
  }

  return (
    <Modal title="Account Types" onClose={onClose}>
      <Btn onClick={startNew} style={{width:"100%",marginBottom:16}}>+ New Account Type</Btn>
      {cats.length===0 && (
        <div style={{textAlign:"center",padding:24,color:"#94A3B8",fontSize:14}}>No account types yet.</div>
      )}
      {cats.map(cat => {
        const count = accounts.filter(a => a.categoryId === cat.id).length;
        return (
          <div key={cat.id} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 0",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{width:36,height:36,borderRadius:10,background:cat.color+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{cat.icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:14,display:"flex",alignItems:"center",gap:6}}>
                {cat.name}
                {cat.isCreditCardType&&<span style={{fontSize:10,background:"#FEF2F2",color:"#EF4444",padding:"1px 6px",borderRadius:10,fontWeight:700}}>CC</span>}
              </div>
              <div style={{fontSize:11,color:"#94A3B8"}}>{count} account{count!==1?"s":""}</div>
            </div>
            <button onClick={()=>startEdit(cat)} style={{fontSize:12,padding:"5px 10px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>✏️</button>
            <button onClick={()=>del(cat)}        style={{fontSize:12,padding:"5px 10px",borderRadius:8,border:"1.5px solid #FECACA",background:"#FEF2F2",color:"#EF4444",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>🗑️</button>
          </div>
        );
      })}
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

// ─── INVESTMENT MODAL ─────────────────────────────────────────────────────────
function InvestModal({ state, onClose, onSave }) {
  const accounts = (state?.accounts||[]).filter(a=>!a.disabled);
  const [txType,setTxType] = useState("buy");
  const [invType,setInvType] = useState("stock");
  const [symbol,setSymbol]  = useState("");
  const [name,setName]      = useState("");
  const [qty,setQty]        = useState("");
  const [price,setPrice]    = useState("");
  const [cur,setCur]        = useState("INR");
  const [date,setDate]      = useState(new Date().toISOString().split("T")[0]);
  const [accId,setAccId]    = useState(accounts[0]?.id||"");
  const [brok,setBrok]      = useState("0");
  const [note,setNote]      = useState("");

  const existing = (state?.holdings||[]).find(h=>h.symbol===symbol.toUpperCase()&&h.type===invType&&h.accountId===accId);
  const total    = (parseFloat(qty)||0)*(parseFloat(price)||0);
  const curObj   = CURRENCIES.find(c=>c.code===cur)||CURRENCIES[0];

  function save() {
    if (!symbol||!qty||!price) { toast("Fill in symbol, quantity and price","error"); return; }
    const q=parseFloat(qty),p=parseFloat(price),b=parseFloat(brok)||0;
    let holdingId, newHolding=null;
    if (existing) { holdingId=existing.id; }
    else if (txType==="buy") {
      holdingId=uid();
      newHolding={id:holdingId,type:invType,symbol:symbol.toUpperCase(),name:name||symbol.toUpperCase(),currency:cur,
        quantity:invType==="stock"?q:0, units:invType==="mf"?q:0,
        avgPrice:invType==="stock"?p:0, nav:invType==="mf"?p:0, accountId:accId};
    }
    const itx={id:uid(),holdingId,type:txType,quantity:q,price:p,currency:cur,date,accountId:accId,brokerage:b,note};
    onSave({newHolding,itx,txType,symbol:symbol.toUpperCase(),quantity:q,price:p,currency:cur,accountId:accId,invType});
    toast(`${txType==="buy"?"Buy":"Sell"} order recorded`);
    onClose();
  }

  return (
    <Modal title="Investment Transaction" onClose={onClose}>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {["buy","sell"].map(t=>(
          <button key={t} onClick={()=>setTxType(t)}
            style={{flex:1,padding:"10px",borderRadius:10,border:`2px solid ${txType===t?(t==="buy"?"#10B981":"#EF4444"):"#E2E8F0"}`,background:txType===t?(t==="buy"?"#F0FDF4":"#FEF2F2"):"#fff",color:txType===t?(t==="buy"?"#10B981":"#EF4444"):"#64748B",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>
            {t==="buy"?"📥 Buy":"📤 Sell"}
          </button>
        ))}
      </div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {[["stock","📊 Stock"],["mf","📈 Mutual Fund"]].map(([v,l])=>(
          <button key={v} onClick={()=>setInvType(v)}
            style={{flex:1,padding:"8px",borderRadius:10,border:`2px solid ${invType===v?"#6366F1":"#E2E8F0"}`,background:invType===v?"#EEF2FF":"#fff",color:invType===v?"#6366F1":"#64748B",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>
      <Sel label="Account" value={accId} onChange={e=>setAccId(e.target.value)}>
        {accounts.map(a=><option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
      </Sel>
      <Sel label="Currency" value={cur} onChange={e=>setCur(e.target.value)}>
        {CURRENCIES.map(c=><option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.name}</option>)}
      </Sel>
      <Inp label={invType==="stock"?"Symbol (e.g. AAPL, RELIANCE)":"Fund Code / Name"}
           value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder={invType==="stock"?"AAPL, TCS…":"MIRAE_ELSS…"} />
      <Inp label="Full Name (optional)" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Apple Inc." />
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Inp label={invType==="stock"?"Shares":"Units"} type="number" inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} />
        <Inp label={`Price (${cur})`} type="number" inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} />
      </div>
      {total>0&&(
        <div style={{background:"#F0FDF4",border:"1.5px solid #A7F3D0",borderRadius:10,padding:12,marginBottom:16,fontSize:14,color:"#065F46"}}>
          Total: <strong>{curObj.symbol}{fmtNum(total)}</strong>
          {cur!=="INR"&&state?.fxRates?.[cur]?` ≈ ${fmtINR(total*state.fxRates[cur])}`:""}
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Inp label={`Brokerage (${cur})`} type="number" inputMode="decimal" value={brok} onChange={e=>setBrok(e.target.value)} />
        <Inp label="Date" type="date" value={date} onChange={e=>setDate(e.target.value)} />
      </div>
      <Inp label="Note" value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional…" />
      <BtnRow>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant={txType==="buy"?"success":"danger"} onClick={save}>{txType==="buy"?"Buy":"Sell"}</Btn>
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

// ─── ACCOUNT CARD ─────────────────────────────────────────────────────────────
function AccountCard({ acc, transactions, accounts, fxRates, onEdit, onToggle, onCCSettings }) {
  const isCreditCard = !!acc.isCreditCard;
  const cur          = acc.currency||"INR";
  const isDisabled   = !!acc.disabled;

  let displayBal, subLabel, canDisable;

  if (isCreditCard && acc.billDay) {
    // Show outstanding + payable separately
    const { outstanding, payable } = calcCCBalance(acc, transactions);
    displayBal = outstanding + payable;  // total owed
    subLabel   = `Outstanding: ${fmtCur(outstanding,cur)}  |  Payable: ${fmtCur(payable,cur)}`;
    canDisable = displayBal < 0.005;
  } else {
    displayBal = calcBalance(acc.id, transactions, accounts);
    subLabel   = null;
    canDisable = Math.abs(displayBal) < 0.005;
  }

  const inrEquiv = cur!=="INR" ? toINR(displayBal,cur,fxRates) : null;

  return (
    <Card style={{padding:20,borderLeft:`4px solid ${isDisabled?"#CBD5E1":acc.color}`,opacity:isDisabled?0.65:1}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:26}}>{acc.icon}</span>
          {isDisabled&&<span style={{fontSize:10,background:"#F1F5F9",color:"#94A3B8",padding:"2px 7px",borderRadius:10,fontWeight:700}}>DISABLED</span>}
          {isCreditCard&&<span style={{fontSize:10,background:"#FEF2F2",color:"#EF4444",padding:"2px 7px",borderRadius:10,fontWeight:700}}>CC</span>}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {acc.includeInNetWorth&&<span style={{fontSize:10,background:"#F0FDF4",color:"#10B981",padding:"2px 7px",borderRadius:10,fontWeight:700}}>NW</span>}
          <span style={{fontSize:10,background:"#F1F5F9",color:"#64748B",padding:"2px 8px",borderRadius:10,fontWeight:600,textTransform:"uppercase"}}>{cur}</span>
        </div>
      </div>
      <div style={{fontWeight:700,fontSize:15,color:isDisabled?"#94A3B8":"#0F172A",marginBottom:4}}>{acc.name}</div>
      <div style={{fontSize:24,fontWeight:800,color:isDisabled?"#94A3B8":isCreditCard?"#EF4444":displayBal>=0?"#0F172A":"#EF4444"}}>
        {isCreditCard?"−":""}{fmtCur(Math.abs(displayBal),cur)}
      </div>
      {inrEquiv!==null&&<div style={{fontSize:12,color:"#94A3B8",marginTop:3}}>≈ {fmtINR(Math.abs(inrEquiv))}</div>}
      {subLabel&&<div style={{fontSize:11,color:"#94A3B8",marginTop:4,lineHeight:1.6}}>{subLabel}</div>}
      {(parseFloat(acc.openingBalance)||0)!==0&&(
        <div style={{fontSize:11,color:"#94A3B8",marginTop:3}}>Opening: {fmtCur(acc.openingBalance,cur)}</div>
      )}
      <div style={{display:"flex",gap:6,marginTop:14,flexWrap:"wrap"}}>
        <button onClick={()=>onEdit(acc)}
          style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#F8FAFC",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
          ✏️ Edit
        </button>
        {isCreditCard&&onCCSettings&&(
          <button onClick={()=>onCCSettings(acc)}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #C7D2FE",background:"#EEF2FF",color:"#6366F1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
            ⚙️ CC Settings
          </button>
        )}
        {isDisabled?(
          <button onClick={()=>onToggle(acc,false)}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:"1.5px solid #A7F3D0",background:"#F0FDF4",color:"#065F46",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
            ✅ Enable
          </button>
        ):(
          <button onClick={()=>canDisable&&onToggle(acc,true)}
            title={canDisable?"Disable account":`Balance must be 0 to disable`}
            style={{fontSize:12,padding:"5px 12px",borderRadius:8,border:`1.5px solid ${canDisable?"#FECACA":"#E2E8F0"}`,background:canDisable?"#FEF2F2":"#F8FAFC",color:canDisable?"#EF4444":"#CBD5E1",cursor:canDisable?"pointer":"not-allowed",fontFamily:"inherit",fontWeight:600}}>
            🚫 Disable
          </button>
        )}
      </div>
    </Card>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashboardView({ state }) {
  const transactions = state?.transactions||[];
  const holdings     = state?.holdings    ||[];
  const accounts     = state?.accounts    ||[];
  const fxRates      = state?.fxRates     ||DEFAULT.fxRates;
  const allCats      = [...(state?.expenseCategories||[]),...(state?.incomeCategories||[])];

  const now      = new Date();
  const monthTxs = transactions.filter(t=>{const d=new Date(t.date+"T00:00:00");return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});

  // Month income (exclude refund-income from totals, it's tracked separately)
  const monthIn  = monthTxs.filter(t=>t.type==="income"&&!t.isRefund).reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);

  // Month actual expense = total expense - refunded amounts
  const monthGrossOut = monthTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const monthRefunded = monthTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(parseFloat(t.refundedAmount)||0,t.currency,fxRates),0);
  const monthNetOut   = monthGrossOut - monthRefunded;

  const portfolio = holdings.reduce((s,h)=>s+toINR(h.type==="stock"?h.quantity*h.avgPrice:h.units*h.nav,h.currency,fxRates),0);
  const totalBal  = accounts.filter(a=>!a.isCreditCard).reduce((s,acc)=>s+toINR(calcBalance(acc.id,transactions,accounts),acc.currency||"INR",fxRates),0);
  const netWorth  = calcNetWorth(accounts, transactions, fxRates);
  const recentTx  = [...transactions].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5);

  // Cashback summary
  const cbSummary = calcCashbackSummary(transactions, accounts);
  const totalCB   = Object.values(cbSummary).reduce((s,c)=>s+Object.values(c.tiers).reduce((a,t)=>a+t.expected,0),0);

  return (
    <div>
      {/* Hero banner */}
      <div style={{background:"linear-gradient(135deg,#1E1B4B,#312E81,#4C1D95)",borderRadius:20,padding:"28px 24px",marginBottom:20,color:"#fff",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,borderRadius:"50%",background:"rgba(255,255,255,0.05)"}}/>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:600}}>Total Balance (INR equiv.)</div>
        <div style={{fontSize:36,fontWeight:800,letterSpacing:"-1px",marginBottom:4}}>{fmtINR(totalBal)}</div>
        <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginBottom:16}}>
          Net Worth: <strong style={{color:"#A7F3D0"}}>{fmtINR(netWorth)}</strong>
        </div>
        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Month In</div><div style={{fontSize:16,fontWeight:700,color:"#A7F3D0"}}>+{fmtINR(monthIn)}</div></div>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Month Out (net)</div><div style={{fontSize:16,fontWeight:700,color:"#FCA5A5"}}>{fmtINR(monthNetOut)}</div></div>
          <div><div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>Portfolio</div><div style={{fontSize:16,fontWeight:700,color:"#C4B5FD"}}>{fmtINR(portfolio)}</div></div>
        </div>
      </div>

      {/* Stats grid — 2 col on mobile */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Month Income",   value:fmtINR(monthIn),         color:"#10B981",bg:"#F0FDF4",icon:"📥"},
          {label:"Net Expense",    value:fmtINR(monthNetOut),      color:"#EF4444",bg:"#FEF2F2",icon:"📤"},
          {label:"Net Worth",      value:fmtINR(netWorth),         color:netWorth>=0?"#6366F1":"#EF4444",bg:"#EEF2FF",icon:"💎"},
          {label:"Expected CB",    value:fmtINR(totalCB),          color:"#D97706",bg:"#FFFBEB",icon:"💳"},
        ].map(s=>(
          <Card key={s.label} style={{background:s.bg,padding:16}}>
            <div style={{fontSize:20,marginBottom:6}}>{s.icon}</div>
            <div style={{fontSize:18,fontWeight:800,color:s.color,marginBottom:4}}>{s.value}</div>
            <div style={{fontSize:12,color:"#64748B",fontWeight:500}}>{s.label}</div>
          </Card>
        ))}
      </div>

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
  const [showFx,      setShowFx]      = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [ccSettings,  setCCSettings]  = useState(null);

  const accounts     = state?.accounts          ||[];
  const accCats      = state?.accountCategories  ||DEFAULT.accountCategories;
  const transactions = state?.transactions       ||[];
  const fxRates      = state?.fxRates            ||DEFAULT.fxRates;
  const byCategory   = accCats.map(cat=>({...cat,accounts:accounts.filter(a=>a.categoryId===cat.id)}));

  function toggleDisable(acc, shouldDisable) {
    if (shouldDisable) {
      const isCCCard = acc.isCreditCard;
      const bal = isCCCard ? (()=>{const{outstanding,payable}=calcCCBalance(acc,transactions);return outstanding+payable;})() : calcBalance(acc.id, transactions, accounts);
      if (bal>=0.005) {
        toast(`Cannot disable "${acc.name}" — balance ${fmtCur(bal,acc.currency||"INR")} must be 0`, "error");
        return;
      }
    }
    dispatch({type:"EDIT_ACCOUNT",payload:{...acc,disabled:shouldDisable}});
    toast(shouldDisable ? "Account disabled" : "Account enabled");
  }

  // Net worth summary row
  const netWorth = calcNetWorth(accounts, transactions, fxRates);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Accounts</h2>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn variant="ghost" size="sm" onClick={()=>setShowFx(true)}>💱 FX Rates</Btn>
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
        <div key={cat.id} style={{marginBottom:28}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <span style={{fontSize:18}}>{cat.icon}</span>
            <span style={{fontWeight:700,color:"#475569",fontSize:14,textTransform:"uppercase",letterSpacing:"0.05em"}}>{cat.name}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(min(100%,260px),1fr))",gap:12}}>
            {cat.accounts.map(acc=>(
              <AccountCard key={acc.id} acc={acc} transactions={transactions} accounts={accounts} fxRates={fxRates}
                onEdit={a=>setEditing(a)}
                onToggle={toggleDisable}
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

// ─── INVESTMENTS VIEW ─────────────────────────────────────────────────────────
function InvestmentsView({ state, dispatch }) {
  const [showAdd,setShowAdd] = useState(false);
  const [tab,setTab]         = useState("holdings");
  const holdings     = state?.holdings    ||[];
  const investmentTx = state?.investmentTx||[];
  const fxRates      = state?.fxRates     ||DEFAULT.fxRates;
  const stocks  = holdings.filter(h=>h.type==="stock");
  const mfs     = holdings.filter(h=>h.type==="mf");
  const stockVal= stocks.reduce((s,h)=>s+toINR(h.quantity*h.avgPrice,h.currency,fxRates),0);
  const mfVal   = mfs.reduce((s,h)=>s+toINR(h.units*h.nav,h.currency,fxRates),0);
  const sortedTx= [...investmentTx].sort((a,b)=>new Date(b.date)-new Date(a.date));

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Investments</h2>
        <Btn onClick={()=>setShowAdd(true)}>+ Trade</Btn>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:20}}>
        {[
          {label:"Portfolio",       value:fmtINR(stockVal+mfVal),color:"#6366F1",bg:"#EEF2FF",icon:"📊"},
          {label:`Stocks (${stocks.length})`,  value:fmtINR(stockVal),     color:"#0EA5E9",bg:"#F0F9FF",icon:"📈"},
          {label:`MFs (${mfs.length})`,        value:fmtINR(mfVal),        color:"#10B981",bg:"#F0FDF4",icon:"📉"},
        ].map(s=>(
          <Card key={s.label} style={{background:s.bg,padding:14,textAlign:"center"}}>
            <div style={{fontSize:20,marginBottom:4}}>{s.icon}</div>
            <div style={{fontSize:14,fontWeight:800,color:s.color}}>{s.value}</div>
            <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{s.label}</div>
          </Card>
        ))}
      </div>
      <div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {[["holdings","Holdings"],["history","Trade History"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)}
            style={{flexShrink:0,padding:"8px 18px",borderRadius:20,border:`2px solid ${tab===k?"#6366F1":"#E2E8F0"}`,background:tab===k?"#EEF2FF":"#fff",color:tab===k?"#6366F1":"#64748B",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>
      {tab==="holdings"&&(
        <div>
          {holdings.length===0&&<Card style={{textAlign:"center",padding:48,color:"#94A3B8"}}><div style={{fontSize:48}}>📊</div><div style={{marginTop:8,fontWeight:600}}>No holdings yet</div></Card>}
          {stocks.length>0&&(
            <div style={{marginBottom:20}}>
              <div style={{fontWeight:700,fontSize:13,color:"#475569",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>📊 Stocks</div>
              <Card style={{padding:0,overflow:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr style={{background:"#F8FAFC"}}>{["Symbol","Shares","Avg Price","Value (INR)","Account"].map(h=><th key={h} style={{padding:"11px 14px",textAlign:"left",fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                  <tbody>{stocks.map(h=>{
                    const a=(state?.accounts||[]).find(a=>a.id===h.accountId);
                    const cO=CURRENCIES.find(c=>c.code===h.currency)||CURRENCIES[0];
                    return <tr key={h.id} style={{borderTop:"1px solid #F1F5F9"}}>
                      <td style={{padding:"12px 14px",fontWeight:800,color:"#6366F1"}}>{h.symbol}</td>
                      <td style={{padding:"12px 14px",fontWeight:600}}>{fmtNum(h.quantity)}</td>
                      <td style={{padding:"12px 14px"}}>{cO.symbol}{fmtNum(h.avgPrice)}</td>
                      <td style={{padding:"12px 14px",fontWeight:700}}>{fmtINR(toINR(h.quantity*h.avgPrice,h.currency,fxRates))}</td>
                      <td style={{padding:"12px 14px",fontSize:12,color:"#94A3B8"}}>{a?.name}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </Card>
            </div>
          )}
          {mfs.length>0&&(
            <div>
              <div style={{fontWeight:700,fontSize:13,color:"#475569",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>📈 Mutual Funds</div>
              <Card style={{padding:0,overflow:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr style={{background:"#F8FAFC"}}>{["Fund","Units","NAV","Value (INR)","Account"].map(h=><th key={h} style={{padding:"11px 14px",textAlign:"left",fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                  <tbody>{mfs.map(h=>{
                    const a=(state?.accounts||[]).find(a=>a.id===h.accountId);
                    return <tr key={h.id} style={{borderTop:"1px solid #F1F5F9"}}>
                      <td style={{padding:"12px 14px"}}><div style={{fontWeight:700}}>{h.name}</div><div style={{fontSize:11,color:"#94A3B8"}}>{h.symbol}</div></td>
                      <td style={{padding:"12px 14px",fontWeight:600}}>{fmtNum(h.units)}</td>
                      <td style={{padding:"12px 14px"}}>{fmtCur(h.nav,h.currency||"INR")}</td>
                      <td style={{padding:"12px 14px",fontWeight:700}}>{fmtINR(toINR(h.units*h.nav,h.currency,fxRates))}</td>
                      <td style={{padding:"12px 14px",fontSize:12,color:"#94A3B8"}}>{a?.name}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      )}
      {tab==="history"&&(
        <Card style={{padding:0,overflow:"auto"}}>
          {sortedTx.length===0?<div style={{textAlign:"center",padding:48,color:"#94A3B8"}}><div style={{fontSize:40}}>📭</div><div style={{marginTop:8}}>No trades yet</div></div>:(
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead><tr style={{background:"#F8FAFC"}}>{["Date","Type","Symbol","Qty","Price","Total (INR)"].map(h=><th key={h} style={{padding:"11px 14px",textAlign:"left",fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
              <tbody>{sortedTx.map(itx=>{
                const h=holdings.find(h=>h.id===itx.holdingId);
                const cur=itx.currency||"INR";
                return <tr key={itx.id} style={{borderTop:"1px solid #F1F5F9"}}>
                  <td style={{padding:"12px 14px",color:"#64748B",whiteSpace:"nowrap"}}>{fmtDate(itx.date)}</td>
                  <td style={{padding:"12px 14px"}}><span style={{background:itx.type==="buy"?"#F0FDF4":"#FEF2F2",color:itx.type==="buy"?"#10B981":"#EF4444",padding:"3px 10px",borderRadius:20,fontWeight:700,fontSize:12}}>{itx.type.toUpperCase()}</span></td>
                  <td style={{padding:"12px 14px",fontWeight:700,color:"#6366F1"}}>{h?.symbol||"—"}</td>
                  <td style={{padding:"12px 14px"}}>{fmtNum(itx.quantity)}</td>
                  <td style={{padding:"12px 14px"}}>{fmtCur(itx.price,cur)}</td>
                  <td style={{padding:"12px 14px",fontWeight:700}}>{fmtINR(toINR(itx.quantity*itx.price,cur,fxRates))}</td>
                </tr>;
              })}</tbody>
            </table>
          )}
        </Card>
      )}
      {showAdd&&<InvestModal state={state} onClose={()=>setShowAdd(false)} onSave={d=>dispatch({type:"ADD_INVESTMENT",payload:d})} />}
    </div>
  );
}

// ─── REPORTS VIEW ─────────────────────────────────────────────────────────────
function ReportsView({ state }) {
  const transactions = state?.transactions      ||[];
  const expCats      = state?.expenseCategories ||DEFAULT.expenseCategories;
  const incCats      = state?.incomeCategories   ||DEFAULT.incomeCategories;
  const fxRates      = state?.fxRates            ||DEFAULT.fxRates;
  const months = [...new Set(transactions.map(t=>{const d=new Date(t.date+"T00:00:00");return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;}))].sort().reverse();
  const [sel,setSel] = useState(months[0]||"");

  const mTxs = transactions.filter(t=>{
    if(!sel) return true;
    const d=new Date(t.date+"T00:00:00");
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`===sel;
  });

  const income  = mTxs.filter(t=>t.type==="income"&&!t.isRefund).reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  // Net expense = gross - refunded
  const grossExp   = mTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(t.amount,t.currency,fxRates),0);
  const totalRefund= mTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+toINR(parseFloat(t.refundedAmount)||0,t.currency,fxRates),0);
  const expense    = grossExp - totalRefund;

  function breakdown(type, cats) {
    const m={};
    mTxs.filter(t=>t.type===type).forEach(t=>{
      const cat=cats.find(c=>c.id===t.categoryId);
      const k=cat?`${cat.icon} ${cat.name}`:"Other";
      const net = type==="expense" ? (parseFloat(t.amount)||0)-(parseFloat(t.refundedAmount)||0) : parseFloat(t.amount)||0;
      m[k]=(m[k]||0)+toINR(net,t.currency,fxRates);
    });
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  }
  const expBreak=breakdown("expense",expCats), incBreak=breakdown("income",incCats);
  const maxExp=Math.max(...expBreak.map(e=>e[1]),1), maxInc=Math.max(...incBreak.map(e=>e[1]),1);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:22,fontWeight:800,color:"#0F172A"}}>Reports</h2>
        <select value={sel} onChange={e=>setSel(e.target.value)} style={{border:"1.5px solid #E2E8F0",borderRadius:10,padding:"8px 14px",fontSize:14,fontFamily:"inherit",outline:"none"}}>
          <option value="">All Time</option>
          {months.map(m=><option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Income",    value:fmtINR(income),         color:"#10B981",bg:"#F0FDF4"},
          {label:"Net Expense",value:fmtINR(expense),       color:"#EF4444",bg:"#FEF2F2"},
          {label:"Savings",   value:fmtINR(income-expense),color:income-expense>=0?"#6366F1":"#EF4444",bg:"#EEF2FF"},
          {label:"Refunds",   value:fmtINR(totalRefund),    color:"#D97706",bg:"#FFFBEB"},
        ].map(s=><Card key={s.label} style={{background:s.bg,padding:16}}><div style={{fontSize:20,fontWeight:800,color:s.color}}>{s.value}</div><div style={{fontSize:12,color:"#64748B",marginTop:4}}>{s.label}</div></Card>)}
      </div>
      {income>0&&(
        <Card style={{marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Savings Rate</div>
          <div style={{background:"#F1F5F9",borderRadius:20,height:16,overflow:"hidden"}}>
            <div style={{background:"linear-gradient(90deg,#6366F1,#8B5CF6)",height:"100%",borderRadius:20,width:`${Math.min(100,Math.max(0,((income-expense)/income)*100))}%`}}/>
          </div>
          <div style={{marginTop:8,fontSize:14,color:"#475569"}}>{Math.round(((income-expense)/income)*100)}% saved this period</div>
        </Card>
      )}
      <div style={{display:"flex",flexDirection:"column",gap:16}}>
        {expBreak.length>0&&(
          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16}}>📤 Net Expense by Category</div>
            {expBreak.map(([cat,amt])=>(
              <div key={cat} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontSize:14}}>
                  <span style={{fontWeight:600}}>{cat}</span><span style={{fontWeight:700,color:"#EF4444"}}>{fmtINR(amt)}</span>
                </div>
                <div style={{background:"#F1F5F9",borderRadius:20,height:8,overflow:"hidden"}}><div style={{background:"#EF4444",height:"100%",borderRadius:20,width:`${(amt/maxExp)*100}%`}}/></div>
              </div>
            ))}
          </Card>
        )}
        {incBreak.length>0&&(
          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16}}>📥 Income by Category</div>
            {incBreak.map(([cat,amt])=>(
              <div key={cat} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontSize:14}}>
                  <span style={{fontWeight:600}}>{cat}</span><span style={{fontWeight:700,color:"#10B981"}}>{fmtINR(amt)}</span>
                </div>
                <div style={{background:"#F1F5F9",borderRadius:20,height:8,overflow:"hidden"}}><div style={{background:"#10B981",height:"100%",borderRadius:20,width:`${(amt/maxInc)*100}%`}}/></div>
              </div>
            ))}
          </Card>
        )}
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
  const [view,        setView]        = useState("dashboard");
  const [online,      setOnline]      = useState(typeof navigator!=="undefined"?navigator.onLine:true);
  const [quickAdd,    setQuickAdd]    = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [syncStatus,  setSyncStatus]  = useState("idle");

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

      {/* ── FAB: floating "+ Add" button ─────────────────────────────────────── */}
      {/* Desktop: fixed bottom-right. Mobile: fixed bottom-center above nav bar.  */}
      <button
        onClick={()=>setQuickAdd(true)}
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
        aria-label="Add transaction"
      >
        <span style={{fontSize:22,lineHeight:1}}>＋</span>
        <span className="fab-label">Add</span>
      </button>

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
