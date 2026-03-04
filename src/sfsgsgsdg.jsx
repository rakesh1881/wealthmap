
// WEALTHMAP - Personal Finance Tracker
// Full offline/online capable, cross-platform finance tracker

import { useState, useEffect, useCallback, useMemo } from "react";

// ─── STORAGE LAYER ──────────────────────────────────────────────────────────
const STORAGE_KEY = "wealthmap_v1";

const defaultState = {
  accounts: [],
  categories: [
    { id: "cat_bank", name: "Bank", icon: "🏦", color: "#3B82F6" },
    { id: "cat_cash", name: "Cash", icon: "💵", color: "#10B981" },
    { id: "cat_cc", name: "Credit Card", icon: "💳", color: "#EF4444" },
    { id: "cat_wallet", name: "Wallet / UPI", icon: "📱", color: "#F59E0B" },
    { id: "cat_broker", name: "Stock Broker", icon: "📈", color: "#8B5CF6" },
    { id: "cat_mf", name: "Mutual Funds", icon: "📊", color: "#06B6D4" },
    { id: "cat_other", name: "Other", icon: "🏷️", color: "#6B7280" },
  ],
  transactions: [],
  holdings: [],
  investmentTx: [],
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return defaultState;
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  // Also save to IndexedDB for robustness (offline)
  try {
    const req = indexedDB.open("wealthmap", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("data");
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").put(state, "state");
    };
  } catch {}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const uid = () => "id_" + Math.random().toString(36).slice(2, 10);
const fmt = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const fmtNum = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const TX_TYPES = {
  expense: { label: "Expense", color: "#EF4444", icon: "↑", bg: "#FEF2F2" },
  income: { label: "Income", color: "#10B981", icon: "↓", bg: "#F0FDF4" },
  transfer: { label: "Transfer", color: "#6366F1", icon: "⇄", bg: "#EEF2FF" },
  refund_expense: { label: "Refundable Expense", color: "#F59E0B", icon: "↑?", bg: "#FFFBEB" },
  refund_income: { label: "Refundable Income", color: "#06B6D4", icon: "↓?", bg: "#ECFEFF" },
};

const EXPENSE_CATS = ["Food", "Transport", "Shopping", "Bills", "Health", "Entertainment", "Education", "Lend", "Other"];
const INCOME_CATS = ["Salary", "Freelance", "Business", "Interest", "Dividends", "Borrow", "Refund", "Other"];

// ─── MINI COMPONENTS ─────────────────────────────────────────────────────────
function Badge({ children, color, bg }) {
  return <span style={{ background: bg, color, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{children}</span>;
}

function Card({ children, style = {}, onClick, hover }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => hover && setH(true)}
      onMouseLeave={() => hover && setH(false)}
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: 20,
        boxShadow: h ? "0 8px 32px rgba(0,0,0,0.12)" : "0 2px 8px rgba(0,0,0,0.06)",
        transition: "all 0.2s",
        cursor: onClick ? "pointer" : "default",
        transform: h ? "translateY(-2px)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Modal({ title, onClose, children, width = 480 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: width, maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "20px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#0F172A" }}>{title}</h3>
          <button onClick={onClose} style={{ border: "none", background: "#F1F5F9", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
    </div>
  );
}

function Input({ label, ...props }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>}
      <input
        {...props}
        style={{ width: "100%", border: "1.5px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border-color 0.2s", fontFamily: "inherit", ...props.style }}
        onFocus={e => e.target.style.borderColor = "#6366F1"}
        onBlur={e => e.target.style.borderColor = "#E2E8F0"}
      />
    </div>
  );
}

function Select({ label, children, ...props }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>}
      <select {...props} style={{ width: "100%", border: "1.5px solid #E2E8F0", borderRadius: 10, padding: "10px 14px", fontSize: 14, outline: "none", background: "#fff", cursor: "pointer", fontFamily: "inherit", ...props.style }}>
        {children}
      </select>
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", style = {} }) {
  const styles = {
    primary: { background: "linear-gradient(135deg, #6366F1, #8B5CF6)", color: "#fff", border: "none" },
    danger: { background: "#FEF2F2", color: "#EF4444", border: "1.5px solid #FECACA" },
    ghost: { background: "#F8FAFC", color: "#475569", border: "1.5px solid #E2E8F0" },
    success: { background: "linear-gradient(135deg, #10B981, #059669)", color: "#fff", border: "none" },
  };
  const sizes = { sm: { padding: "6px 14px", fontSize: 13 }, md: { padding: "10px 20px", fontSize: 14 }, lg: { padding: "13px 28px", fontSize: 15 } };
  return (
    <button onClick={onClick} style={{ borderRadius: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s", ...styles[variant], ...sizes[size], ...style }}>
      {children}
    </button>
  );
}

// ─── FORMS ───────────────────────────────────────────────────────────────────
function AddTransactionModal({ state, onClose, onSave, prefillType }) {
  const [type, setType] = useState(prefillType || "expense");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(state.accounts[0]?.id || "");
  const [fromAccountId, setFromAccountId] = useState(state.accounts[0]?.id || "");
  const [toAccountId, setToAccountId] = useState(state.accounts[1]?.id || "");
  const [category, setCategory] = useState("Food");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  const cats = (type === "income" || type === "refund_income") ? INCOME_CATS : EXPENSE_CATS;

  function handleSave() {
    if (!amount || isNaN(parseFloat(amount))) return;
    const base = { id: uid(), type, amount: parseFloat(amount), note, date, tags: [] };
    if (type === "transfer") {
      onSave({ ...base, fromAccountId, toAccountId });
    } else {
      onSave({ ...base, accountId, category, refundStatus: (type === "refund_expense" || type === "refund_income") ? "pending" : undefined, linkedTxId: null });
    }
    onClose();
  }

  return (
    <Modal title="Add Transaction" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {Object.entries(TX_TYPES).map(([k, v]) => (
          <button key={k} onClick={() => { setType(k); setCategory(cats[0]); }}
            style={{ padding: "6px 12px", borderRadius: 20, border: `2px solid ${type === k ? v.color : "#E2E8F0"}`, background: type === k ? v.bg : "#fff", color: type === k ? v.color : "#64748B", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>
      <Input label="Amount (₹)" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
      {type === "transfer" ? (
        <>
          <Select label="From Account" value={fromAccountId} onChange={e => setFromAccountId(e.target.value)}>
            {state.accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
          </Select>
          <Select label="To Account" value={toAccountId} onChange={e => setToAccountId(e.target.value)}>
            {state.accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
          </Select>
        </>
      ) : (
        <>
          <Select label="Account" value={accountId} onChange={e => setAccountId(e.target.value)}>
            {state.accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
          </Select>
          <Select label="Category" value={category} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
        </>
      )}
      <Input label="Note" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note..." />
      <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />
      {(type === "refund_expense" || type === "refund_income") && (
        <div style={{ background: "#FFFBEB", border: "1.5px solid #FDE68A", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          💡 This is tracked as a <strong>refundable</strong> transaction — it won't affect your net worth permanently until marked as settled.
        </div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={handleSave}>Save Transaction</Btn>
      </div>
    </Modal>
  );
}

function AddAccountModal({ state, onClose, onSave }) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState(state.categories[0]?.id || "");
  const [icon, setIcon] = useState("🏦");
  const icons = ["🏦", "💵", "💳", "📱", "📈", "📊", "💰", "🏧", "🪙", "💼"];

  function handleSave() {
    if (!name.trim()) return;
    const cat = state.categories.find(c => c.id === categoryId);
    onSave({ id: uid(), name: name.trim(), categoryId, balance: 0, currency: "INR", color: cat?.color || "#6B7280", icon });
    onClose();
  }

  return (
    <Modal title="Add Account" onClose={onClose}>
      <Select label="Account Type" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
        {state.categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
      </Select>
      <Input label="Account Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. SBI Savings, Paytm Wallet..." />
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Icon</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {icons.map(ic => (
            <button key={ic} onClick={() => setIcon(ic)} style={{ width: 40, height: 40, borderRadius: 10, border: `2px solid ${icon === ic ? "#6366F1" : "#E2E8F0"}`, background: icon === ic ? "#EEF2FF" : "#F8FAFC", fontSize: 20, cursor: "pointer" }}>{ic}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={handleSave}>Add Account</Btn>
      </div>
    </Modal>
  );
}

function AddCategoryModal({ onClose, onSave }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏷️");
  const icons = ["🏷️", "🏦", "💵", "💳", "📱", "📈", "📊", "💰", "🏧", "🪙", "🏠", "🚗", "✈️", "🎮", "📚"];
  const colors = ["#3B82F6", "#10B981", "#EF4444", "#F59E0B", "#8B5CF6", "#06B6D4", "#EC4899", "#6B7280"];
  const [color, setColor] = useState(colors[0]);

  function handleSave() {
    if (!name.trim()) return;
    onSave({ id: uid(), name: name.trim(), icon, color });
    onClose();
  }

  return (
    <Modal title="Add Account Category" onClose={onClose}>
      <Input label="Category Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Crypto, PPF, NPS..." />
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Icon</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {icons.map(ic => <button key={ic} onClick={() => setIcon(ic)} style={{ width: 40, height: 40, borderRadius: 10, border: `2px solid ${icon === ic ? "#6366F1" : "#E2E8F0"}`, background: icon === ic ? "#EEF2FF" : "#F8FAFC", fontSize: 20, cursor: "pointer" }}>{ic}</button>)}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Color</label>
        <div style={{ display: "flex", gap: 8 }}>
          {colors.map(c => <button key={c} onClick={() => setColor(c)} style={{ width: 32, height: 32, borderRadius: "50%", background: c, border: color === c ? "3px solid #0F172A" : "2px solid transparent", cursor: "pointer" }} />)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={handleSave}>Add Category</Btn>
      </div>
    </Modal>
  );
}

function AddInvestmentModal({ state, onClose, onSave }) {
  const [txType, setTxType] = useState("buy");
  const [invType, setInvType] = useState("stock");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [accountId, setAccountId] = useState(state.accounts.find(a => a.categoryId === "cat_broker")?.id || state.accounts[0]?.id || "");
  const [brokerage, setBrokerage] = useState("0");
  const [note, setNote] = useState("");

  // Check if holding exists
  const existingHolding = state.holdings.find(h => h.symbol === symbol.toUpperCase() && h.type === invType && h.accountId === accountId);

  function handleSave() {
    if (!symbol || !quantity || !price) return;
    const q = parseFloat(quantity);
    const p = parseFloat(price);
    const b = parseFloat(brokerage) || 0;

    let holdingId;
    let newHolding = null;

    if (existingHolding) {
      holdingId = existingHolding.id;
    } else if (txType === "buy") {
      holdingId = uid();
      newHolding = {
        id: holdingId, type: invType, symbol: symbol.toUpperCase(), name: name || symbol.toUpperCase(),
        quantity: invType === "stock" ? q : 0, units: invType === "mf" ? q : 0,
        avgPrice: invType === "stock" ? p : 0, nav: invType === "mf" ? p : 0, accountId
      };
    }

    const itx = { id: uid(), holdingId, type: txType, quantity: q, price: p, date, accountId, brokerage: b, note };
    onSave({ newHolding, itx, txType, symbol: symbol.toUpperCase(), quantity: q, price: p, accountId, invType });
    onClose();
  }

  return (
    <Modal title="Investment Transaction" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {["buy", "sell"].map(t => (
          <button key={t} onClick={() => setTxType(t)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: `2px solid ${txType === t ? (t === "buy" ? "#10B981" : "#EF4444") : "#E2E8F0"}`, background: txType === t ? (t === "buy" ? "#F0FDF4" : "#FEF2F2") : "#fff", color: txType === t ? (t === "buy" ? "#10B981" : "#EF4444") : "#64748B", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
            {t === "buy" ? "📥 Buy" : "📤 Sell"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["stock", "📊 Stock"], ["mf", "📈 Mutual Fund"]].map(([val, lbl]) => (
          <button key={val} onClick={() => setInvType(val)} style={{ flex: 1, padding: "8px", borderRadius: 10, border: `2px solid ${invType === val ? "#6366F1" : "#E2E8F0"}`, background: invType === val ? "#EEF2FF" : "#fff", color: invType === val ? "#6366F1" : "#64748B", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {lbl}
          </button>
        ))}
      </div>
      <Select label="Account (Broker/Fund House)" value={accountId} onChange={e => setAccountId(e.target.value)}>
        {state.accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
      </Select>
      <Input label={invType === "stock" ? "Stock Symbol (e.g. RELIANCE)" : "Fund Code / Name"} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder={invType === "stock" ? "RELIANCE, TCS, INFY..." : "MIRAE_ELSS, SBI_BLUE..."} />
      <Input label="Full Name (optional)" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Reliance Industries Ltd" />
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Input label={invType === "stock" ? "Quantity (Shares)" : "Units"} type="number" value={quantity} onChange={e => setQuantity(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <Input label={invType === "stock" ? "Price per Share (₹)" : "NAV (₹)"} type="number" value={price} onChange={e => setPrice(e.target.value)} />
        </div>
      </div>
      {quantity && price && (
        <div style={{ background: "#F0FDF4", border: "1.5px solid #A7F3D0", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 14, color: "#065F46" }}>
          Total: <strong>{fmt(parseFloat(quantity || 0) * parseFloat(price || 0))}</strong>
          {parseFloat(brokerage) > 0 && ` + ₹${brokerage} brokerage = ${fmt(parseFloat(quantity || 0) * parseFloat(price || 0) + parseFloat(brokerage))}`}
        </div>
      )}
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}><Input label="Brokerage / Charges (₹)" type="number" value={brokerage} onChange={e => setBrokerage(e.target.value)} /></div>
        <div style={{ flex: 1 }}><Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
      </div>
      <Input label="Note" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional..." />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant={txType === "buy" ? "success" : "danger"} onClick={handleSave}>{txType === "buy" ? "Buy" : "Sell"}</Btn>
      </div>
    </Modal>
  );
}

// ─── TRANSACTION LIST ─────────────────────────────────────────────────────────
function TransactionItem({ tx, state, onMarkRefund, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const acc = state.accounts.find(a => a.id === tx.accountId);
  const fromAcc = state.accounts.find(a => a.id === tx.fromAccountId);
  const toAcc = state.accounts.find(a => a.id === tx.toAccountId);
  const txMeta = TX_TYPES[tx.type];

  const isRefundable = tx.type === "refund_expense" || tx.type === "refund_income";

  return (
    <div style={{ borderBottom: "1px solid #F1F5F9" }}>
      <div onClick={() => setExpanded(!expanded)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", cursor: "pointer" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: txMeta.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: txMeta.color, fontWeight: 700, flexShrink: 0 }}>
          {txMeta.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#0F172A", marginBottom: 2 }}>
            {tx.note || tx.category || "Transfer"}
            {isRefundable && <span style={{ marginLeft: 6, fontSize: 11, background: tx.refundStatus === "settled" ? "#D1FAE5" : "#FEF3C7", color: tx.refundStatus === "settled" ? "#065F46" : "#92400E", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>{tx.refundStatus === "settled" ? "Settled" : "Pending"}</span>}
          </div>
          <div style={{ fontSize: 12, color: "#94A3B8" }}>
            {tx.type === "transfer" ? `${fromAcc?.name} → ${toAcc?.name}` : acc?.name} · {fmtDate(tx.date)}
            {tx.category && ` · ${tx.category}`}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: tx.type === "income" || tx.type === "refund_income" ? "#10B981" : tx.type === "transfer" ? "#6366F1" : txMeta.color }}>
            {tx.type === "income" || tx.type === "refund_income" ? "+" : tx.type === "transfer" ? "" : "-"}{fmt(tx.amount)}
          </div>
        </div>
      </div>
      {expanded && (
        <div style={{ background: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge color={txMeta.color} bg={txMeta.bg}>{txMeta.label}</Badge>
            {tx.category && <Badge color="#64748B" bg="#F1F5F9">{tx.category}</Badge>}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isRefundable && tx.refundStatus === "pending" && (
              <Btn size="sm" variant="success" onClick={() => onMarkRefund(tx.id)}>✓ Mark as Settled</Btn>
            )}
            <Btn size="sm" variant="danger" onClick={() => onDelete(tx.id)}>Delete</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────
function DashboardView({ state }) {
  // Monthly stats
  const now = new Date();
  const monthTxs = state.transactions.filter(t => {
    const d = new Date(t.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthIncome = monthTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const monthExpense = monthTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const pendingRefunds = state.transactions.filter(t => (t.type === "refund_expense" || t.type === "refund_income") && t.refundStatus === "pending");

  const portfolioValue = state.holdings.reduce((sum, h) => {
    if (h.type === "stock") return sum + h.quantity * h.avgPrice;
    return sum + h.units * h.nav;
  }, 0);

  const recentTx = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

  return (
    <div>
      {/* Summary Hero */}
      <div style={{ background: "linear-gradient(135deg, #1E1B4B 0%, #312E81 50%, #4C1D95 100%)", borderRadius: 24, padding: "32px 28px", marginBottom: 24, color: "#fff", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -40, right: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.05)" }} />
        <div style={{ position: "absolute", bottom: -60, left: 40, width: 150, height: 150, borderRadius: "50%", background: "rgba(255,255,255,0.03)" }} />
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>This Month</div>
        <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-1px", marginBottom: 20 }}>{fmt(monthIncome - monthExpense)}</div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>Income</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#A7F3D0" }}>+{fmt(monthIncome)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>Expense</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#FCA5A5" }}>{fmt(monthExpense)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>Investments</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#C4B5FD" }}>{fmt(portfolioValue)}</div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginBottom: 24 }}>
        {[
          { label: "This Month Income", value: fmt(monthIncome), color: "#10B981", bg: "#F0FDF4", icon: "📥" },
          { label: "This Month Expense", value: fmt(monthExpense), color: "#EF4444", bg: "#FEF2F2", icon: "📤" },
          { label: "Savings Rate", value: monthIncome > 0 ? Math.round(((monthIncome - monthExpense) / monthIncome) * 100) + "%" : "—", color: "#6366F1", bg: "#EEF2FF", icon: "💰" },
          { label: "Pending Refunds", value: pendingRefunds.length + " items", color: "#F59E0B", bg: "#FFFBEB", icon: "⏳" },
        ].map(s => (
          <Card key={s.label} style={{ background: s.bg, padding: 16 }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color, marginBottom: 4 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>{s.label}</div>
          </Card>
        ))}
      </div>

      {/* Pending Refunds Alert */}
      {pendingRefunds.length > 0 && (
        <Card style={{ background: "#FFFBEB", border: "1.5px solid #FDE68A", marginBottom: 24, padding: 16 }}>
          <div style={{ fontWeight: 700, color: "#92400E", marginBottom: 8 }}>⏳ Pending Refunds ({pendingRefunds.length})</div>
          {pendingRefunds.map(t => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#78350F", padding: "4px 0", borderBottom: "1px solid #FDE68A" }}>
              <span>{t.note || t.category} · {fmtDate(t.date)}</span>
              <span style={{ fontWeight: 700 }}>{fmt(t.amount)}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Recent Transactions */}
      <Card>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, color: "#0F172A" }}>Recent Transactions</div>
        {recentTx.length === 0 ? (
          <div style={{ textAlign: "center", color: "#94A3B8", padding: 32 }}>No transactions yet</div>
        ) : (
          recentTx.map(tx => (
            <div key={tx.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#0F172A" }}>{tx.note || tx.category || "Transfer"}</div>
                <div style={{ fontSize: 12, color: "#94A3B8" }}>{fmtDate(tx.date)} · <Badge color={TX_TYPES[tx.type].color} bg={TX_TYPES[tx.type].bg}>{TX_TYPES[tx.type].label}</Badge></div>
              </div>
              <div style={{ fontWeight: 700, color: tx.type === "income" || tx.type === "refund_income" ? "#10B981" : tx.type === "transfer" ? "#6366F1" : "#EF4444" }}>
                {tx.type === "income" || tx.type === "refund_income" ? "+" : tx.type === "transfer" ? "~" : "-"}{fmt(tx.amount)}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function AccountsView({ state, dispatch }) {
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);

  const byCategory = state.categories.map(cat => ({
    ...cat,
    accounts: state.accounts.filter(a => a.categoryId === cat.id),
    total: state.accounts.filter(a => a.categoryId === cat.id).reduce((s, a) => s + a.balance, 0),
  })).filter(c => c.accounts.length > 0 || true);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A" }}>Accounts</h2>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShowAddCategory(true)}>+ Category</Btn>
          <Btn size="sm" onClick={() => setShowAddAccount(true)}>+ Account</Btn>
        </div>
      </div>

      {byCategory.map(cat => cat.accounts.length > 0 && (
        <div key={cat.id} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>{cat.icon}</span>
              <span style={{ fontWeight: 700, color: "#475569", fontSize: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>{cat.name}</span>
            </div>

          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
            {cat.accounts.map(acc => (
              <Card key={acc.id} hover style={{ padding: 20, borderLeft: `4px solid ${acc.color}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ fontSize: 24 }}>{acc.icon}</div>
                  <div style={{ fontSize: 10, background: "#F1F5F9", color: "#64748B", padding: "2px 8px", borderRadius: 10, fontWeight: 600, textTransform: "uppercase" }}>
                    {cat.name}
                  </div>
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#0F172A" }}>{acc.name}</div>

              </Card>
            ))}
          </div>
        </div>
      ))}

      {showAddAccount && (
        <AddAccountModal state={state} onClose={() => setShowAddAccount(false)}
          onSave={acc => dispatch({ type: "ADD_ACCOUNT", payload: acc })} />
      )}
      {showAddCategory && (
        <AddCategoryModal onClose={() => setShowAddCategory(false)}
          onSave={cat => dispatch({ type: "ADD_CATEGORY", payload: cat })} />
      )}
    </div>
  );
}

function TransactionsView({ state, dispatch }) {
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");

  const filtered = state.transactions.filter(t => {
    if (filter !== "all" && t.type !== filter) return false;
    if (search && !((t.note || "").toLowerCase().includes(search.toLowerCase()) || (t.category || "").toLowerCase().includes(search.toLowerCase()))) return false;
    if (selectedMonth) {
      const d = new Date(t.date);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (m !== selectedMonth) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A" }}>Transactions</h2>
        <Btn onClick={() => setShowAdd(true)}>+ Add</Btn>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search..." style={{ flex: 1, minWidth: 150, border: "1.5px solid #E2E8F0", borderRadius: 10, padding: "8px 14px", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
        <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} style={{ border: "1.5px solid #E2E8F0", borderRadius: 10, padding: "8px 12px", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[["all", "All"], ...Object.entries(TX_TYPES).map(([k, v]) => [k, v.label])].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${filter === k ? "#6366F1" : "#E2E8F0"}`, background: filter === k ? "#EEF2FF" : "#fff", color: filter === k ? "#6366F1" : "#64748B", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>

      <Card style={{ padding: "0 20px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", color: "#94A3B8", padding: 48 }}>
            <div style={{ fontSize: 40 }}>📭</div>
            <div style={{ marginTop: 8 }}>No transactions found</div>
          </div>
        ) : filtered.map(tx => (
          <TransactionItem key={tx.id} tx={tx} state={state}
            onMarkRefund={id => dispatch({ type: "SETTLE_REFUND", payload: id })}
            onDelete={id => dispatch({ type: "DELETE_TX", payload: id })} />
        ))}
      </Card>

      {showAdd && <AddTransactionModal state={state} onClose={() => setShowAdd(false)}
        onSave={tx => dispatch({ type: "ADD_TX", payload: tx })} />}
    </div>
  );
}

function InvestmentsView({ state, dispatch }) {
  const [showAdd, setShowAdd] = useState(false);
  const [activeTab, setActiveTab] = useState("holdings");

  const stocks = state.holdings.filter(h => h.type === "stock");
  const mfs = state.holdings.filter(h => h.type === "mf");

  const stockValue = stocks.reduce((s, h) => s + h.quantity * h.avgPrice, 0);
  const mfValue = mfs.reduce((s, h) => s + h.units * h.nav, 0);
  const totalValue = stockValue + mfValue;

  const sortedITx = [...state.investmentTx].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A" }}>Investments</h2>
        <Btn onClick={() => setShowAdd(true)}>+ Trade</Btn>
      </div>

      {/* Portfolio Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Portfolio Value", value: fmt(totalValue), color: "#6366F1", bg: "#EEF2FF", icon: "📊" },
          { label: "Stocks", value: fmt(stockValue), color: "#0EA5E9", bg: "#F0F9FF", icon: "📈", sub: `${stocks.length} stocks` },
          { label: "Mutual Funds", value: fmt(mfValue), color: "#10B981", bg: "#F0FDF4", icon: "📉", sub: `${mfs.length} funds` },
        ].map(s => (
          <Card key={s.label} style={{ background: s.bg, padding: 18 }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{s.sub || s.label}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[["holdings", "Holdings"], ["history", "Trade History"]].map(([k, l]) => (
          <button key={k} onClick={() => setActiveTab(k)} style={{ padding: "8px 18px", borderRadius: 20, border: `2px solid ${activeTab === k ? "#6366F1" : "#E2E8F0"}`, background: activeTab === k ? "#EEF2FF" : "#fff", color: activeTab === k ? "#6366F1" : "#64748B", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>

      {activeTab === "holdings" && (
        <div>
          {stocks.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>📊 Stocks</div>
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      {["Symbol", "Name", "Qty", "Avg Price", "Current Value", "Account"].map(h => (
                        <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stocks.map(h => {
                      const acc = state.accounts.find(a => a.id === h.accountId);
                      const val = h.quantity * h.avgPrice;
                      return (
                        <tr key={h.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "14px 16px", fontWeight: 800, color: "#6366F1" }}>{h.symbol}</td>
                          <td style={{ padding: "14px 16px", color: "#475569" }}>{h.name}</td>
                          <td style={{ padding: "14px 16px", fontWeight: 600 }}>{fmtNum(h.quantity)}</td>
                          <td style={{ padding: "14px 16px" }}>₹{fmtNum(h.avgPrice)}</td>
                          <td style={{ padding: "14px 16px", fontWeight: 700, color: "#0F172A" }}>{fmt(val)}</td>
                          <td style={{ padding: "14px 16px", fontSize: 12, color: "#94A3B8" }}>{acc?.name}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </div>
          )}

          {mfs.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>📈 Mutual Funds</div>
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      {["Fund", "Units", "NAV", "Current Value", "Account"].map(h => (
                        <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mfs.map(h => {
                      const acc = state.accounts.find(a => a.id === h.accountId);
                      const val = h.units * h.nav;
                      return (
                        <tr key={h.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "14px 16px" }}>
                            <div style={{ fontWeight: 700, color: "#0F172A" }}>{h.name}</div>
                            <div style={{ fontSize: 11, color: "#94A3B8" }}>{h.symbol}</div>
                          </td>
                          <td style={{ padding: "14px 16px", fontWeight: 600 }}>{fmtNum(h.units)}</td>
                          <td style={{ padding: "14px 16px" }}>₹{fmtNum(h.nav)}</td>
                          <td style={{ padding: "14px 16px", fontWeight: 700 }}>{fmt(val)}</td>
                          <td style={{ padding: "14px 16px", fontSize: 12, color: "#94A3B8" }}>{acc?.name}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </div>
          )}

          {state.holdings.length === 0 && (
            <Card style={{ textAlign: "center", padding: 48, color: "#94A3B8" }}>
              <div style={{ fontSize: 48 }}>📊</div>
              <div style={{ marginTop: 8, fontWeight: 600 }}>No holdings yet</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Click "+ Trade" to add your first investment</div>
            </Card>
          )}
        </div>
      )}

      {activeTab === "history" && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {sortedITx.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#94A3B8" }}>
              <div style={{ fontSize: 40 }}>📭</div>
              <div style={{ marginTop: 8 }}>No trade history</div>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "#F8FAFC" }}>
                  {["Date", "Type", "Symbol", "Qty/Units", "Price", "Total", "Charges", "Notes"].map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedITx.map(itx => {
                  const holding = state.holdings.find(h => h.id === itx.holdingId);
                  return (
                    <tr key={itx.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                      <td style={{ padding: "12px 16px", color: "#64748B" }}>{fmtDate(itx.date)}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{ background: itx.type === "buy" ? "#F0FDF4" : "#FEF2F2", color: itx.type === "buy" ? "#10B981" : "#EF4444", padding: "3px 10px", borderRadius: 20, fontWeight: 700, fontSize: 12 }}>
                          {itx.type === "buy" ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", fontWeight: 700, color: "#6366F1" }}>{holding?.symbol || "—"}</td>
                      <td style={{ padding: "12px 16px" }}>{fmtNum(itx.quantity)}</td>
                      <td style={{ padding: "12px 16px" }}>₹{fmtNum(itx.price)}</td>
                      <td style={{ padding: "12px 16px", fontWeight: 700 }}>{fmt(itx.quantity * itx.price)}</td>
                      <td style={{ padding: "12px 16px", color: "#94A3B8" }}>{itx.brokerage > 0 ? `₹${itx.brokerage}` : "—"}</td>
                      <td style={{ padding: "12px 16px", color: "#64748B" }}>{itx.note || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {showAdd && (
        <AddInvestmentModal state={state} onClose={() => setShowAdd(false)}
          onSave={data => dispatch({ type: "ADD_INVESTMENT", payload: data })} />
      )}
    </div>
  );
}

function ReportsView({ state }) {
  const months = useMemo(() => {
    const seen = new Set();
    state.transactions.forEach(t => {
      const d = new Date(t.date);
      seen.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    });
    return [...seen].sort().reverse();
  }, [state.transactions]);

  const [selectedMonth, setSelectedMonth] = useState(months[0] || "");

  const monthTxs = state.transactions.filter(t => {
    if (!selectedMonth) return true;
    const d = new Date(t.date);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return m === selectedMonth;
  });

  const income = monthTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = monthTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const refundExp = monthTxs.filter(t => t.type === "refund_expense").reduce((s, t) => s + t.amount, 0);
  const savings = income - expense;

  // Category breakdown
  const catBreakdown = {};
  monthTxs.filter(t => t.type === "expense").forEach(t => {
    catBreakdown[t.category || "Other"] = (catBreakdown[t.category || "Other"] || 0) + t.amount;
  });
  const cats = Object.entries(catBreakdown).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(...cats.map(c => c[1]), 1);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A" }}>Reports</h2>
        <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} style={{ border: "1.5px solid #E2E8F0", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontFamily: "inherit", outline: "none" }}>
          <option value="">All Time</option>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Income", value: fmt(income), color: "#10B981", bg: "#F0FDF4" },
          { label: "Expense", value: fmt(expense), color: "#EF4444", bg: "#FEF2F2" },
          { label: "Savings", value: fmt(savings), color: savings >= 0 ? "#6366F1" : "#EF4444", bg: "#EEF2FF" },
          { label: "Lent Out", value: fmt(refundExp), color: "#F59E0B", bg: "#FFFBEB" },
        ].map(s => (
          <Card key={s.label} style={{ background: s.bg, padding: 20 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 4 }}>{s.label}</div>
          </Card>
        ))}
      </div>

      {income > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Savings Rate</div>
          <div style={{ background: "#F1F5F9", borderRadius: 20, height: 16, overflow: "hidden" }}>
            <div style={{ background: "linear-gradient(90deg, #6366F1, #8B5CF6)", height: "100%", width: `${Math.min(100, Math.max(0, (savings / income) * 100))}%`, borderRadius: 20, transition: "width 0.5s" }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 14, color: "#475569" }}>{income > 0 ? Math.round((savings / income) * 100) : 0}% saved this period</div>
        </Card>
      )}

      {cats.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Expense by Category</div>
          {cats.map(([cat, amt]) => (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 14 }}>
                <span style={{ fontWeight: 600 }}>{cat}</span>
                <span style={{ fontWeight: 700, color: "#EF4444" }}>{fmt(amt)}</span>
              </div>
              <div style={{ background: "#F1F5F9", borderRadius: 20, height: 8, overflow: "hidden" }}>
                <div style={{ background: "#EF4444", height: "100%", width: `${(amt / maxCat) * 100}%`, borderRadius: 20, opacity: 0.7 + (amt / maxCat) * 0.3 }} />
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── REDUCER ─────────────────────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {
    case "ADD_TX": {
      const tx = action.payload;
      let accounts = [...state.accounts];

      if (tx.type === "transfer") {
        accounts = accounts.map(a => {
          if (a.id === tx.fromAccountId) return { ...a, balance: a.balance - tx.amount };
          if (a.id === tx.toAccountId) return { ...a, balance: a.balance + tx.amount };
          return a;
        });
      } else if (tx.type === "income" || tx.type === "refund_income") {
        accounts = accounts.map(a => a.id === tx.accountId ? { ...a, balance: a.balance + tx.amount } : a);
      } else if (tx.type === "expense") {
        accounts = accounts.map(a => a.id === tx.accountId ? { ...a, balance: a.balance - tx.amount } : a);
      } else if (tx.type === "refund_expense") {
        accounts = accounts.map(a => a.id === tx.accountId ? { ...a, balance: a.balance - tx.amount } : a);
      }

      return { ...state, transactions: [...state.transactions, tx], accounts };
    }
    case "DELETE_TX": {
      return { ...state, transactions: state.transactions.filter(t => t.id !== action.payload) };
    }
    case "SETTLE_REFUND": {
      return { ...state, transactions: state.transactions.map(t => t.id === action.payload ? { ...t, refundStatus: "settled" } : t) };
    }
    case "ADD_ACCOUNT":
      return { ...state, accounts: [...state.accounts, action.payload] };
    case "ADD_CATEGORY":
      return { ...state, categories: [...state.categories, action.payload] };
    case "ADD_INVESTMENT": {
      const { newHolding, itx, txType, quantity, price, accountId, invType } = action.payload;
      let holdings = [...state.holdings];
      const brokerage = itx.brokerage || 0;
      const total = quantity * price + (txType === "buy" ? brokerage : -brokerage);

      if (newHolding) {
        holdings = [...holdings, newHolding];
      } else {
        // Update existing holding
        holdings = holdings.map(h => {
          if (h.symbol === itx.holdingId || h.id === itx.holdingId) {
            if (txType === "buy") {
              const newQty = (h.quantity || h.units || 0) + quantity;
              const newAvg = (((h.quantity || h.units || 0) * (h.avgPrice || h.nav || 0)) + quantity * price) / newQty;
              if (invType === "stock") return { ...h, quantity: newQty, avgPrice: newAvg };
              return { ...h, units: newQty, nav: price };
            } else {
              const newQty = Math.max(0, (h.quantity || h.units || 0) - quantity);
              if (invType === "stock") return { ...h, quantity: newQty };
              return { ...h, units: newQty };
            }
          }
          return h;
        });
      }

      // Debit/credit account
      const accounts = state.accounts.map(a => {
        if (a.id === accountId) return { ...a, balance: a.balance + (txType === "buy" ? -total : total) };
        return a;
      });

      return { ...state, holdings: holdings.filter(h => (h.quantity || 0) > 0 || (h.units || 0) > 0 || newHolding), investmentTx: [...state.investmentTx, itx], accounts };
    }
    default:
      return state;
  }
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "🏠" },
  { id: "accounts", label: "Accounts", icon: "🏦" },
  { id: "transactions", label: "Transactions", icon: "↕️" },
  { id: "investments", label: "Investments", icon: "📈" },
  { id: "reports", label: "Reports", icon: "📊" },
];

export default function App() {
  const [state, dispatch_] = useState(() => loadState());
  const [view, setView] = useState("dashboard");
  const [online, setOnline] = useState(navigator.onLine);
  const [quickAdd, setQuickAdd] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const dispatch = useCallback((action) => {
    dispatch_(prev => {
      const next = reducer(prev, action);
      saveState(next);
      return next;
    });
  }, []);

  return (
    <div style={{ fontFamily: "'DM Sans', 'Nunito', system-ui, sans-serif", background: "#F8FAFC", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E2E8F0", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px", display: "flex", justifyContent: "space-between", alignItems: "center", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #6366F1, #8B5CF6)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>💎</div>
            <span style={{ fontWeight: 800, fontSize: 18, color: "#0F172A" }}>WealthMap</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: online ? "#F0FDF4" : "#FEF2F2", color: online ? "#10B981" : "#EF4444", fontWeight: 600 }}>
              {online ? "● Online" : "● Offline"}
            </span>
            <button onClick={() => setQuickAdd(true)} style={{ background: "linear-gradient(135deg, #6366F1, #8B5CF6)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              + Add
            </button>
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E2E8F0" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px", display: "flex", gap: 4, overflowX: "auto" }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setView(n.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "14px 16px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: view === n.id ? 700 : 500, color: view === n.id ? "#6366F1" : "#64748B", borderBottom: `2px solid ${view === n.id ? "#6366F1" : "transparent"}`, whiteSpace: "nowrap", transition: "all 0.2s" }}>
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px", width: "100%", boxSizing: "border-box", flex: 1 }}>
        {view === "dashboard" && <DashboardView state={state} />}
        {view === "accounts" && <AccountsView state={state} dispatch={dispatch} />}
        {view === "transactions" && <TransactionsView state={state} dispatch={dispatch} />}
        {view === "investments" && <InvestmentsView state={state} dispatch={dispatch} />}
        {view === "reports" && <ReportsView state={state} />}
      </div>

      {/* Quick Add Modal */}
      {quickAdd && (
        <AddTransactionModal state={state} onClose={() => setQuickAdd(false)}
          onSave={tx => { dispatch({ type: "ADD_TX", payload: tx }); setQuickAdd(false); }} />
      )}

      {/* Bottom nav for mobile */}
      <div style={{ display: "none", position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #E2E8F0", padding: "8px 0", zIndex: 100 }} className="mobile-nav">
        {NAV.map(n => (
          <button key={n.id} onClick={() => setView(n.id)} style={{ flex: 1, border: "none", background: "none", padding: "8px 4px", cursor: "pointer", fontSize: 20 }}>{n.icon}</button>
        ))}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #F1F5F9; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        @media (max-width: 640px) {
          .mobile-nav { display: flex !important; }
        }
        table { overflow-x: auto; }
        @media (max-width: 600px) {
          table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        }
      `}</style>
    </div>
  );
}
