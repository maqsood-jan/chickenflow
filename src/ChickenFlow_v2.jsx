import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, onSnapshot } from "firebase/firestore";

// ─── FIREBASE CONFIG ─ Replace with your own from Firebase Console ──────────
const firebaseConfig = {
  apiKey: "AIzaSyDcoWautL9x8jhmrOvZc8n6CYL_csWskU0",
  authDomain: "chickenflow-a3cf2.firebaseapp.com",
  projectId: "chickenflow-a3cf2",
  storageBucket: "chickenflow-a3cf2.firebasestorage.app",
  messagingSenderId: "264036211412",
  appId: "1:264036211412:web:13436225e08ef36a42b941"
};

// Initialize Firebase (modular SDK bundled by Vite)
const _fbApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(_fbApp);
const db = getFirestore(_fbApp);


// ─── UTILS ───────────────────────────────────────────────────────────────────
const genId   = () => Math.random().toString(36).slice(2,8).toUpperCase();
const today   = () => new Date().toISOString().split("T")[0];
const nowTime = () => new Date().toTimeString().slice(0,5);
const n       = v => Number(v)||0;
const fmt     = v => n(v).toLocaleString("en-PK");
const fmtKg   = v => `${fmt(v)} kg`;
const fmtRs   = v => `Rs. ${fmt(Math.round(n(v)))}`;

function loadXLSX(){
  return new Promise(resolve=>{
    if(window.XLSX) return resolve(window.XLSX);
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload=()=>resolve(window.XLSX);
    document.head.appendChild(s);
  });
}

function getBalance(accountId,txns){
  return txns.reduce((b,t)=>{
    if(t.debitAccountId===accountId)  return b+n(t.amount);
    if(t.creditAccountId===accountId) return b-n(t.amount);
    return b;
  },0);
}

function calcVehicle(v, transactions=[], labourers=[]){
  const purchased=v.purchases.reduce((s,p)=>s+n(p.weight),0);
  const transitLoss=v.purchases.reduce((s,p)=>s+n(p.transitLoss),0);
  const received=purchased-transitLoss;
  const soldWt=v.sales.reduce((s,x)=>s+n(x.weight),0);
  const transferWt=v.transfers.reduce((s,x)=>s+n(x.weight),0);
  const remaining=received-soldWt-transferWt;
  const purchaseCost=v.purchases.reduce((s,p)=>s+n(p.weight)*n(p.rate),0);
  const vehicleExpenses=v.expenses.reduce((s,x)=>s+n(x.amount),0);
  // linked general expenses & salaries from transactions
  const linkedExpenses=transactions.filter(t=>t.linkedVehicleId===v.id&&(t.type==="general_exp"||t.type==="salary")).reduce((s,t)=>s+n(t.amount),0);
  const totalExpenses=vehicleExpenses+linkedExpenses;
  const totalCost=purchaseCost+totalExpenses;
  const totalSaleValue=v.sales.reduce((s,x)=>s+n(x.weight)*n(x.rate),0);
  const totalReceiptsCollected=v.sales.reduce((s,sale)=>s+(sale.receipts||[]).reduce((a,r)=>a+n(r.amount),0),0);
  const totalSaleBalance=totalSaleValue-totalReceiptsCollected;
  const pnl=totalSaleValue-totalCost;
  const supplierPaid=v.purchases.reduce((s,p)=>s+(p.payments||[]).reduce((a,r)=>a+n(r.amount),0),0);
  const supplierBalance=purchaseCost-supplierPaid;
  return{purchased,transitLoss,received,soldWt,transferWt,remaining,
    purchaseCost,totalExpenses,totalCost,totalSaleValue,
    totalReceiptsCollected,totalSaleBalance,pnl,supplierPaid,supplierBalance,linkedExpenses};
}

// ─── SALARY CALCULATION UTILS ─────────────────────────────────────────────────
// Get the applicable salary rate for a given date based on salary history
function getSalaryRateForDate(labourer, dateStr) {
  const history = labourer.salaryHistory || [];
  // Find the most recent salary change on or before dateStr
  const applicable = history
    .filter(h => h.effectiveFrom <= dateStr)
    .sort((a,b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (applicable.length > 0) return n(applicable[0].amount);
  return n(labourer.monthlySalary) || 0;
}

// Calculate days between two date strings
function daysBetween(from, to) {
  const a = new Date(from), b = new Date(to);
  return Math.max(0, Math.round((b - a) / (1000*60*60*24)));
}

// Calculate earned salary from joinDate to today using salary history
function calcEarnedSalary(labourer) {
  if (!labourer.joinDate) return { earned: 0, breakdown: [] };
  const history = labourer.salaryHistory || [];
  const todayStr = today();
  if (labourer.joinDate > todayStr) return { earned: 0, breakdown: [] };

  // Build segments: join → first change → next change → ... → today
  const sortedHistory = [...history].sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const segments = [];
  let segStart = labourer.joinDate;

  for (const h of sortedHistory) {
    if (h.effectiveFrom <= segStart) continue; // already past
    if (h.effectiveFrom > todayStr) break;
    // Find rate for segStart
    const rate = getSalaryRateForDate(labourer, segStart);
    segments.push({ from: segStart, to: h.effectiveFrom, dailyRate: rate / 30 });
    segStart = h.effectiveFrom;
  }
  // Final segment to today
  const finalRate = getSalaryRateForDate(labourer, segStart);
  segments.push({ from: segStart, to: todayStr, dailyRate: finalRate / 30 });

  let earned = 0;
  const breakdown = segments.map(s => {
    const days = daysBetween(s.from, s.to);
    const amount = days * s.dailyRate;
    earned += amount;
    return { ...s, days, amount };
  });
  return { earned: Math.round(earned), breakdown };
}

// Calculate current month's earned salary
function calcCurrentMonthEarned(labourer) {
  if (!labourer.joinDate) return 0;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const effectiveStart = labourer.joinDate > monthStart ? labourer.joinDate : monthStart;
  const todayStr = today();
  const days = daysBetween(effectiveStart, todayStr) + 1; // inclusive
  const rate = getSalaryRateForDate(labourer, todayStr);
  return Math.round((rate / 30) * Math.min(days, 30));
}

// ─── PERSISTED STATE (replaced by Firebase)

// ─── DATA BACKUP / RESTORE ────────────────────────────────────────────────────




function importDataFromFile(file, callbacks) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data._version) throw new Error("Invalid backup file format");
      const { setVehicles, setCustomers, setSuppliers, setAccounts, setTransactions, setLabourers, setExpenseCategories } = callbacks;
      if (data.vehicles    != null) setVehicles(data.vehicles);
      if (data.customers   != null) setCustomers(data.customers);
      if (data.suppliers   != null) setSuppliers(data.suppliers);
      if (data.accounts    != null) setAccounts(data.accounts);
      if (data.transactions!= null) setTransactions(data.transactions);
      if (data.labourers   != null) setLabourers(data.labourers);
      if (data.categories  != null) setExpenseCategories(data.categories);
      alert(`✅ Data restored successfully!\nBackup was from: ${data._exportedAt ? new Date(data._exportedAt).toLocaleString() : "unknown date"}`);
    } catch(err) {
      alert("❌ Failed to import: " + err.message);
    }
  };
  reader.readAsText(file);
}

// ─── COLORS & CSS ────────────────────────────────────────────────────────────
const C={
  bg:"#080B12",card:"#101420",card2:"#161D2E",card3:"#1C2438",
  border:"#232D42",text:"#D9E4F5",muted:"#4E5E7A",
  amber:"#F59E0B",amberD:"#B45309",amberSoft:"#F59E0B18",
  green:"#22C55E",greenSoft:"#22C55E18",
  red:"#EF4444",redSoft:"#EF444418",
  blue:"#60A5FA",blueSoft:"#60A5FA18",
  purple:"#A78BFA",purpleSoft:"#A78BFA18",
  teal:"#2DD4BF",tealSoft:"#2DD4BF18",
  orange:"#FB923C",orangeSoft:"#FB923C18",
};
const css=`
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;overscroll-behavior:none;}
  body{background:${C.bg};color:${C.text};font-family:'Plus Jakarta Sans',sans-serif;min-height:100vh;min-height:100dvh;-webkit-tap-highlight-color:transparent;}
  input,select,textarea{background:${C.card2};border:1.5px solid ${C.border};color:${C.text};padding:10px 12px;border-radius:10px;font-family:inherit;font-size:16px;width:100%;outline:none;transition:border-color 0.15s;-webkit-appearance:none;appearance:none;}
  input:focus,select:focus,textarea:focus{border-color:${C.amber};}
  input::placeholder,textarea::placeholder{color:${C.muted};}
  select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%234E5E7A' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px;}
  select option{background:${C.card2};}
  button{cursor:pointer;font-family:inherit;border:none;border-radius:10px;font-size:14px;font-weight:600;padding:10px 18px;transition:all 0.15s;min-height:44px;-webkit-tap-highlight-color:transparent;}
  button:active{opacity:0.75;transform:scale(0.97);}
  .mono{font-family:'JetBrains Mono',monospace;}
  ::-webkit-scrollbar{width:4px;height:4px;}
  ::-webkit-scrollbar-track{background:${C.bg};}
  ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px;}
  tr:hover>td{background:${C.card2}66;}
  .ci{padding:6px 10px !important;font-size:12px !important;border-radius:8px !important;}
  .page-content{padding:16px;padding-bottom:calc(80px + env(safe-area-inset-bottom));max-width:1200px;margin:0 auto;}
  .bottom-nav{position:fixed;bottom:0;left:0;right:0;background:${C.card};border-top:1px solid ${C.border};display:flex;align-items:stretch;z-index:100;padding-bottom:env(safe-area-inset-bottom);height:calc(62px + env(safe-area-inset-bottom));}
  .bottom-nav-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:8px 4px;cursor:pointer;border:none;background:transparent;font-family:inherit;transition:all 0.15s;min-height:44px;-webkit-tap-highlight-color:transparent;}
  .bottom-nav-item:active{background:${C.card2};}
  .bottom-nav-icon{font-size:20px;line-height:1;}
  .bottom-nav-label{font-size:10px;font-weight:600;letter-spacing:0.02em;}
  .top-header{background:${C.card};border-bottom:1px solid ${C.border};padding:0 16px;display:flex;align-items:center;height:56px;position:sticky;top:0;z-index:99;gap:8px;padding-top:env(safe-area-inset-top);}
  .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
  .card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;}
  .form-row{display:flex;gap:12px;flex-wrap:wrap;}
  .form-row>*{flex:1;min-width:140px;}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px;border:1px solid ${C.border};}
  .table-wrap table{min-width:500px;}
  .mobile-card{background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:16px;margin-bottom:12px;}
  .overflow-menu{position:relative;}
  @media(max-width:600px){
    .stat-grid{grid-template-columns:repeat(2,1fr);}
    .card-grid{grid-template-columns:1fr;}
    .hide-mobile{display:none !important;}
    .full-mobile{width:100% !important;}
    .form-row>*{min-width:100%;flex:0 0 100%;}
    h1{font-size:18px !important;}
    h2{font-size:16px !important;}
  }
  @media(min-width:768px){
    .bottom-nav{display:none;}
    .page-content{padding-bottom:24px;}
    .top-nav-desktop{display:flex !important;}
  }
  .top-nav-desktop{display:none;}
  @media print{
    .no-print{display:none !important;}
    body{background:#fff;color:#000;}
    .print-card{background:#fff;border:1px solid #ddd;color:#000;}
    .bottom-nav{display:none !important;}
  }
`;

// ─── SHARED UI ────────────────────────────────────────────────────────────────
const Btn=({children,color="amber",onClick,full,small,sx={}})=>{
  const M={
    amber:{bg:C.amber,fg:"#000",hov:C.amberD},
    ghost:{bg:"transparent",fg:C.muted,hov:C.border+"66",bdr:`1px solid ${C.border}`},
    red:{bg:C.redSoft,fg:C.red,hov:C.red+"33",bdr:`1px solid ${C.red}33`},
    green:{bg:C.greenSoft,fg:C.green,hov:C.green+"33",bdr:`1px solid ${C.green}33`},
    blue:{bg:C.blueSoft,fg:C.blue,hov:C.blue+"33",bdr:`1px solid ${C.blue}33`},
    purple:{bg:C.purpleSoft,fg:C.purple,hov:C.purple+"33",bdr:`1px solid ${C.purple}33`},
    teal:{bg:C.tealSoft,fg:C.teal,hov:C.teal+"33",bdr:`1px solid ${C.teal}33`},
    orange:{bg:C.orangeSoft,fg:C.orange,hov:C.orange+"33",bdr:`1px solid ${C.orange}33`},
  };
  const m=M[color]||M.amber;
  return(
    <button onClick={onClick} style={{background:m.bg,color:m.fg,border:m.bdr||"none",
      width:full?"100%":undefined,padding:small?"6px 12px":"10px 18px",fontSize:small?12:14,
      minHeight:small?36:44,...sx}}
      onMouseEnter={e=>e.currentTarget.style.background=m.hov}
      onMouseLeave={e=>e.currentTarget.style.background=m.bg}>
      {children}
    </button>
  );
};
const Tag=({children,color=C.blue})=>(
  <span style={{display:"inline-block",padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,
    background:color+"22",color,border:`1px solid ${color}33`}}>{children}</span>
);
const Label=({children})=>(
  <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>{children}</div>
);
const Fld=({label,children,half,third,sx={}})=>(
  <div style={{marginBottom:13,width:third?"calc(33% - 8px)":half?"calc(50% - 6px)":"100%",...sx}}>
    {label&&<Label>{label}</Label>}{children}
  </div>
);
const Row2=({label,value,color,bold,border=true})=>(
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",
    borderBottom:border?`1px solid ${C.border}33`:"none"}}>
    <span style={{fontSize:13,color:C.muted}}>{label}</span>
    <span className="mono" style={{fontSize:13,color:color||C.text,fontWeight:bold?"700":"500"}}>{value}</span>
  </div>
);
const TH=({ch,right})=>(
  <th style={{textAlign:right?"right":"left",padding:"9px 12px",fontSize:11,color:C.muted,fontWeight:700,
    textTransform:"uppercase",letterSpacing:"0.06em",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{ch}</th>
);
const TD=({children,color,bold,mono,right,small})=>(
  <td style={{padding:small?"6px 10px":"9px 12px",fontSize:small?12:13,color:color||C.text,fontWeight:bold?"700":"400",
    borderBottom:`1px solid ${C.border}22`,fontFamily:mono?"'JetBrains Mono',monospace":undefined,
    textAlign:right?"right":"left"}}>{children}</td>
);
const StatBox=({label,value,color,sub})=>(
  <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 10px"}}>
    <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
    <div className="mono" style={{fontSize:15,fontWeight:700,color:color||C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{value}</div>
    {sub&&<div style={{fontSize:10,color:C.muted,marginTop:2}}>{sub}</div>}
  </div>
);
const InfoCard=({title,children,action})=>(
  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:16,height:"fit-content"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <Label>{title}</Label>{action}
    </div>{children}
  </div>
);
const Empty=({icon,text})=>(
  <div style={{textAlign:"center",padding:"50px 20px",color:C.muted}}>
    <div style={{fontSize:36,marginBottom:10}}>{icon||"📭"}</div>
    <div style={{fontSize:14}}>{text}</div>
  </div>
);
const Modal=({title,onSave,saveLabel="Save",onClose,children,width=500,noFooter})=>(
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",
    alignItems:"flex-end",justifyContent:"center",zIndex:999}}
    onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div style={{background:C.card,border:`1px solid ${C.border}`,
      borderRadius:"16px 16px 0 0",width:"100%",maxWidth:width,
      maxHeight:"92vh",display:"flex",flexDirection:"column",
      paddingBottom:"env(safe-area-inset-bottom)"}}>
      <div style={{width:36,height:4,background:C.border,borderRadius:2,margin:"10px auto 0"}}/>
      <div style={{padding:"12px 20px 12px",borderBottom:`1px solid ${C.border}`,
        display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <div style={{fontSize:16,fontWeight:700}}>{title}</div>
        <button onClick={onClose} style={{background:C.card2,color:C.muted,fontSize:16,
          width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
          border:`1px solid ${C.border}`,minHeight:32,padding:0}}>✕</button>
      </div>
      <div style={{padding:"16px 20px",overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch"}}>{children}</div>
      {!noFooter&&(
        <div style={{padding:"12px 20px",borderTop:`1px solid ${C.border}`,display:"flex",gap:8,flexShrink:0}}>
          <Btn color="ghost" onClick={onClose} full>Cancel</Btn>
          {onSave&&<Btn color="amber" onClick={onSave} full>{saveLabel}</Btn>}
        </div>
      )}
    </div>
  </div>
);
const AcctSelect=({accounts,value,onChange,label="Account"})=>(
  <Fld label={label}>
    <select value={value||""} onChange={onChange}>
      <option value="">— Select Account —</option>
      {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  </Fld>
);

// Project selector component
const ProjectSelect=({vehicles,value,onChange,label="Link to Project (Optional)"})=>(
  <Fld label={label}>
    <select value={value||""} onChange={onChange}>
      <option value="">— No Project / General —</option>
      {vehicles.filter(v=>v.status==="active").map(v=><option key={v.id} value={v.id}>🚛 {v.vehicleNo} ({v.date})</option>)}
      {vehicles.filter(v=>v.status!=="active").length>0&&<optgroup label="Closed Projects">
        {vehicles.filter(v=>v.status!=="active").map(v=><option key={v.id} value={v.id}>🚛 {v.vehicleNo} ({v.date}) [closed]</option>)}
      </optgroup>}
    </select>
  </Fld>
);

const TXN_TYPES={
  receipt:{label:"Customer Receipt",color:C.green},
  supplier_pay:{label:"Supplier Payment",color:C.red},
  vehicle_exp:{label:"Vehicle Expense",color:C.red},
  general_exp:{label:"General Expense",color:C.red},
  salary:{label:"Salary",color:C.purple},
  advance:{label:"Salary Advance",color:C.orange},
  transfer_in:{label:"Transfer In",color:C.teal},
  transfer_out:{label:"Transfer Out",color:C.blue},
  general_income:{label:"Income",color:C.green},
};

// ─── AUTO-BACKUP HOOK ─────────────────────────────────────────────────────────
function useAutoBackup(intervalMinutes) {
  const lastBackupRef = useRef(null);
  const [lastBackupTime, setLastBackupTime] = useState(null);
  const [nextBackupIn, setNextBackupIn] = useState(null);

  useEffect(() => {
    if (!intervalMinutes || intervalMinutes <= 0) return;
    const intervalMs = intervalMinutes * 60 * 1000;

    const doBackup = () => {
      onExport && onExport();
      const now = new Date();
      lastBackupRef.current = now;
      setLastBackupTime(now);
    };

    const ticker = setInterval(() => {
      if (!lastBackupRef.current) {
        setNextBackupIn(intervalMinutes * 60);
        return;
      }
      const elapsed = (Date.now() - lastBackupRef.current.getTime()) / 1000;
      const remaining = Math.max(0, intervalMs / 1000 - elapsed);
      setNextBackupIn(Math.round(remaining));
    }, 5000);

    const backupTimer = setInterval(doBackup, intervalMs);

    return () => {
      clearInterval(ticker);
      clearInterval(backupTimer);
    };
  }, [intervalMinutes]);

  return { lastBackupTime, nextBackupIn };
}

// ─── BACKUP PANEL ─────────────────────────────────────────────────────────────
function BackupPanel({ autoBackupMinutes, setAutoBackupMinutes, importCallbacks, onExport }) {
  const [modal, setModal] = useState(false);
  const [pendingMin, setPendingMin] = useState(autoBackupMinutes);
  const importRef = useRef();
  const { lastBackupTime, nextBackupIn } = useAutoBackup(autoBackupMinutes);

  const fmtCountdown = (secs) => {
    if (secs == null) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {autoBackupMinutes > 0 && (
          <div style={{ fontSize: 10, color: C.muted, textAlign: "right", lineHeight: 1.5 }}>
            <div>Auto-backup: every {autoBackupMinutes}m</div>
            {nextBackupIn != null && <div style={{ color: C.teal }}>Next in: {fmtCountdown(nextBackupIn)}</div>}
          </div>
        )}
        <Btn color="teal" small onClick={() => setModal(true)}>💾 Backup</Btn>
      </div>

      {modal && (
        <Modal title="💾 Data Backup & Restore" onClose={() => setModal(false)} noFooter width={520}>
          <div style={{ background: C.greenSoft, border: `1px solid ${C.green}33`, borderRadius: 10, padding: "12px 16px", marginBottom: 20, display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 20 }}>✅</span>
            <div>
              <div style={{ fontWeight: 700, color: C.green, fontSize: 13 }}>Auto-saving to browser storage</div>
              <div style={{ fontSize: 12, color: C.muted }}>Every change is saved instantly. Data survives closing the browser.</div>
            </div>
          </div>
          <div style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>📤 Export Backup</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Download all your data as a JSON file.</div>
            <Btn color="amber" onClick={() => { onExport && onExport(); setModal(false); }}>⬇ Download Backup Now</Btn>
          </div>
          <div style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>⏱ Auto-Backup to File</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
              Automatically downloads a backup file on a schedule.
              {lastBackupTime && <span style={{ color: C.teal }}> Last: {lastBackupTime.toLocaleTimeString()}</span>}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <select value={pendingMin} onChange={e => setPendingMin(Number(e.target.value))} style={{ width: 180 }}>
                <option value={0}>Disabled</option>
                <option value={15}>Every 15 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 1 hour</option>
                <option value={120}>Every 2 hours</option>
              </select>
              <Btn color="green" onClick={() => { setAutoBackupMinutes(pendingMin); setModal(false); }}>Save</Btn>
            </div>
          </div>
          <div style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>📥 Restore from Backup</div>
            <div style={{ background: C.redSoft, border: `1px solid ${C.red}33`, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.red, marginBottom: 12 }}>
              ⚠️ This will replace ALL current data with the backup.
            </div>
            <Btn color="blue" onClick={() => importRef.current.click()}>📂 Choose Backup File</Btn>
            <input ref={importRef} type="file" accept=".json" style={{ display: "none" }}
              onChange={e => {
                const f = e.target.files[0];
                if (!f) return;
                if (!window.confirm("This will REPLACE all current data. Are you sure?")) return;
                importDataFromFile(f, importCallbacks);
                setModal(false);
                e.target.value = "";
              }} />
          </div>
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <Btn color="ghost" onClick={() => setModal(false)}>Close</Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

// ─── ACCOUNTS PAGE ────────────────────────────────────────────────────────────
function AccountsPage({accounts,setAccounts,transactions,setTransactions,expenseCategories,setExpenseCategories,vehicles}){
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [selAccId,setSelAccId]=useState("all");
  const [catInput,setCatInput]=useState("");
  const [ledgerFrom,setLedgerFrom]=useState("");
  const [ledgerTo,setLedgerTo]=useState("");
  const [txnSearch,setTxnSearch]=useState("");
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const close=()=>{setModal(null);setForm({});};
  const totalBalance=accounts.reduce((s,a)=>s+getBalance(a.id,transactions),0);

  const addAccount=()=>{
    if(!form.name) return alert("Enter account name");
    setAccounts(p=>[...p,{id:genId(),name:form.name,type:form.type||"bank",createdAt:today()}]);
    close();
  };
  const doTransfer=()=>{
    if(!form.fromAccountId||!form.toAccountId) return alert("Select both accounts");
    if(form.fromAccountId===form.toAccountId) return alert("Cannot transfer to same account");
    if(!form.amount) return alert("Enter amount");
    const id=genId();
    setTransactions(p=>[...p,
      {id:id+"A",date:form.date||today(),type:"transfer_out",amount:n(form.amount),
       creditAccountId:form.fromAccountId,debitAccountId:null,
       description:`Transfer to ${accounts.find(a=>a.id===form.toAccountId)?.name}`,note:form.note||""},
      {id:id+"B",date:form.date||today(),type:"transfer_in",amount:n(form.amount),
       debitAccountId:form.toAccountId,creditAccountId:null,
       description:`Transfer from ${accounts.find(a=>a.id===form.fromAccountId)?.name}`,note:form.note||""},
    ]);
    close();
  };
  const doGeneralExpense=()=>{
    if(!form.accountId||!form.amount||!form.description) return alert("Fill all required fields");
    setTransactions(p=>[...p,{id:genId(),date:form.date||today(),type:"general_exp",
      amount:n(form.amount),creditAccountId:form.accountId,debitAccountId:null,
      description:form.description,category:form.category||"Other",note:form.note||"",
      linkedVehicleId:form.linkedVehicleId||null,
      linkedVehicleNo:form.linkedVehicleId?vehicles.find(v=>v.id===form.linkedVehicleId)?.vehicleNo||"":""
    }]);
    close();
  };
  const doGeneralIncome=()=>{
    if(!form.accountId||!form.amount||!form.description) return alert("Fill all required fields");
    setTransactions(p=>[...p,{id:genId(),date:form.date||today(),type:"general_income",
      amount:n(form.amount),debitAccountId:form.accountId,creditAccountId:null,
      description:form.description,note:form.note||""}]);
    close();
  };
  const addCategory=()=>{
    if(!catInput.trim()) return;
    setExpenseCategories(p=>[...p,catInput.trim()]); setCatInput("");
  };
  const filteredTxns=useMemo(()=>{
    const t=[...transactions].sort((a,b)=>b.date.localeCompare(a.date));
    if(selAccId==="all") return t;
    return t.filter(t=>t.debitAccountId===selAccId||t.creditAccountId===selAccId);
  },[transactions,selAccId]);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div><h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>💰 Accounts & Ledger</h1>
          <p style={{color:C.muted,fontSize:13}}>Total Balance: <span className="mono" style={{color:totalBalance>=0?C.green:C.red,fontWeight:700}}>{fmtRs(totalBalance)}</span></p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <Btn color="teal"   onClick={()=>{setForm({date:today()});setModal("transfer");}}>⇄ Transfer</Btn>
          <Btn color="green"  onClick={()=>{setForm({date:today()});setModal("income");}}>+ Income</Btn>
          <Btn color="red"    onClick={()=>{setForm({date:today()});setModal("expense");}}>− Expense</Btn>
          <Btn color="ghost"  onClick={()=>setModal("category")}>📋 Categories</Btn>
          <Btn color="amber"  onClick={()=>{setForm({type:"bank"});setModal("addAccount");}}>+ Add Account</Btn>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14,marginBottom:24}}>
        <div onClick={()=>setSelAccId("all")} style={{background:C.card,border:`2px solid ${selAccId==="all"?C.amber:C.border}`,borderRadius:12,padding:18,cursor:"pointer"}}>
          <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>All Accounts</div>
          <div className="mono" style={{fontSize:22,fontWeight:800,color:totalBalance>=0?C.green:C.red}}>{fmtRs(totalBalance)}</div>
          <div style={{fontSize:12,color:C.muted,marginTop:4}}>{accounts.length} accounts</div>
        </div>
        {accounts.map(a=>{
          const bal=getBalance(a.id,transactions);
          return(
            <div key={a.id} onClick={()=>setSelAccId(a.id)}
              style={{background:C.card,border:`2px solid ${selAccId===a.id?C.amber:C.border}`,borderRadius:12,padding:18,cursor:"pointer"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor=C.amber}
              onMouseLeave={e=>e.currentTarget.style.borderColor=selAccId===a.id?C.amber:C.border}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase"}}>{a.type==="cash"?"💵":"🏦"} {a.name}</div>
                <Tag color={a.type==="cash"?C.amber:C.blue}>{a.type}</Tag>
              </div>
              <div className="mono" style={{fontSize:22,fontWeight:800,color:bal>=0?C.green:C.red}}>{fmtRs(bal)}</div>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        <input value={txnSearch} onChange={e=>setTxnSearch(e.target.value)} placeholder="🔍 Search transactions…" style={{maxWidth:220,padding:"6px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13}}/>
        <input type="date" value={ledgerFrom} onChange={e=>setLedgerFrom(e.target.value)} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13}}/>
        <span style={{color:C.muted,fontSize:13}}>to</span>
        <input type="date" value={ledgerTo} onChange={e=>setLedgerTo(e.target.value)} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13}}/>
        {(ledgerFrom||ledgerTo||txnSearch)&&<button onClick={()=>{setLedgerFrom("");setLedgerTo("");setTxnSearch("");}} style={{padding:"5px 10px",borderRadius:8,fontSize:11,background:C.card2,color:C.muted,border:`1px solid ${C.border}`,cursor:"pointer"}}>✕ Clear</button>}
        <div style={{marginLeft:"auto",fontSize:13,color:C.muted,fontWeight:600}}>{selAccId==="all"?"All Transactions":accounts.find(a=>a.id===selAccId)?.name} <span style={{color:C.text}}>({filteredTxns.length})</span></div>
      </div>
      {filteredTxns.length===0?<Empty icon="📒" text="No transactions yet."/>:(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr><TH ch="Date"/><TH ch="Description"/><TH ch="Type"/><TH ch="Project"/><TH ch="Account"/><TH ch="In" right/><TH ch="Out" right/><TH ch=""/></tr></thead>
            <tbody>
              {filteredTxns.map(t=>{
                const cfg=TXN_TYPES[t.type]||{label:t.type,color:C.muted};
                const isIn=!!t.debitAccountId;
                const acctId=t.debitAccountId||t.creditAccountId;
                const acct=accounts.find(a=>a.id===acctId);
                return(
                  <tr key={t.id}>
                    <TD color={C.muted}>{t.date}</TD>
                    <TD bold>{t.description}{t.category?<span style={{color:C.muted,fontWeight:400}}> · {t.category}</span>:""}</TD>
                    <TD><Tag color={cfg.color}>{cfg.label}</Tag></TD>
                    <TD color={C.muted} small>{t.linkedVehicleNo?<Tag color={C.teal}>🚛 {t.linkedVehicleNo}</Tag>:"—"}</TD>
                    <TD color={C.muted}>{acct?.name||"—"}</TD>
                    <TD right mono color={C.green}>{isIn?fmtRs(t.amount):"—"}</TD>
                    <TD right mono color={C.red}>{!isIn?fmtRs(t.amount):"—"}</TD>
                    <TD><button onClick={()=>{const r=window.prompt("Reason for voiding (required):");if(!r)return;if(!window.confirm("Void this transaction? It will be hidden from all reports."))return;setTransactions(p=>p.map(x=>x.id===t.id?{...x,voided:true,voidReason:r,voidedAt:today()}:x));}} style={{background:"transparent",color:C.red,fontSize:11,padding:"2px 8px",border:`1px solid ${C.red}55`,borderRadius:6,cursor:"pointer",whiteSpace:"nowrap"}}>🚫 Void</button></TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {modal==="addAccount"&&(
        <Modal title="Add New Account" onSave={addAccount} saveLabel="Add Account" onClose={close}>
          <Fld label="Account Name"><input value={form.name||""} onChange={f("name")} placeholder="e.g. UBL Bank, HBL, Cash on Hand"/></Fld>
          <Fld label="Type"><select value={form.type||"bank"} onChange={f("type")}><option value="cash">Cash</option><option value="bank">Bank</option><option value="other">Other</option></select></Fld>
        </Modal>
      )}
      {modal==="transfer"&&(
        <Modal title="⇄ Transfer Between Accounts" onSave={doTransfer} saveLabel="Transfer" onClose={close} width={480}>
          <div style={{display:"flex",gap:12}}>
            <Fld label="From Account" half><select value={form.fromAccountId||""} onChange={f("fromAccountId")}><option value="">— From —</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} ({fmtRs(getBalance(a.id,transactions))})</option>)}</select></Fld>
            <Fld label="To Account" half><select value={form.toAccountId||""} onChange={f("toAccountId")}><option value="">— To —</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Fld>
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="e.g. 50000"/></Fld>
            <Fld label="Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
          </div>
          <Fld label="Note"><input value={form.note||""} onChange={f("note")} placeholder="Optional"/></Fld>
        </Modal>
      )}
      {modal==="expense"&&(
        <Modal title="− General Expense" onSave={doGeneralExpense} saveLabel="Record" onClose={close}>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={f("accountId")} label="Pay From Account"/>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
            <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="Amount"/></Fld>
          </div>
          <Fld label="Description"><input value={form.description||""} onChange={f("description")} placeholder="e.g. Home electricity, Grocery"/></Fld>
          <Fld label="Category"><select value={form.category||""} onChange={f("category")}><option value="">— Category —</option>{expenseCategories.map(c=><option key={c}>{c}</option>)}</select></Fld>
          {/* Project linking */}
          <ProjectSelect vehicles={vehicles} value={form.linkedVehicleId} onChange={f("linkedVehicleId")}/>
          {form.linkedVehicleId&&<div style={{background:C.tealSoft,border:`1px solid ${C.teal}33`,borderRadius:8,padding:"9px 14px",fontSize:12,color:C.teal,marginBottom:8}}>✓ This expense will be included in the linked project's P&L</div>}
          <Fld label="Note"><input value={form.note||""} onChange={f("note")} placeholder="Optional"/></Fld>
        </Modal>
      )}
      {modal==="income"&&(
        <Modal title="+ Income" onSave={doGeneralIncome} saveLabel="Record" onClose={close}>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={f("accountId")} label="Deposit To Account"/>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
            <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="Amount"/></Fld>
          </div>
          <Fld label="Description"><input value={form.description||""} onChange={f("description")} placeholder="e.g. Other income"/></Fld>
        </Modal>
      )}
      {modal==="category"&&(
        <Modal title="📋 Expense Categories" onClose={close} noFooter>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <input value={catInput} onChange={e=>setCatInput(e.target.value)} placeholder="New category name" onKeyDown={e=>e.key==="Enter"&&addCategory()}/>
            <Btn color="amber" onClick={addCategory}>Add</Btn>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {expenseCategories.map((c,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:6,background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 12px"}}>
                <span style={{fontSize:13}}>{c}</span>
                <button onClick={()=>setExpenseCategories(p=>p.filter((_,j)=>j!==i))} style={{background:"transparent",color:C.red,fontSize:14,padding:"0 2px"}}>✕</button>
              </div>
            ))}
          </div>
          <div style={{marginTop:20,display:"flex",justifyContent:"flex-end"}}><Btn color="ghost" onClick={close}>Close</Btn></div>
        </Modal>
      )}
    </div>
  );
}

// ─── SALARIES PAGE ────────────────────────────────────────────────────────────
function SalariesPage({labourers,setLabourers,accounts,transactions,setTransactions,vehicles}){
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [selLabourer,setSelLabourer]=useState(null);
  const [viewId,setViewId]=useState(null);
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const close=()=>{setModal(null);setForm({});setSelLabourer(null);};

  const addLabourer=()=>{
    if(!form.name) return alert("Enter name");
    if(!form.joinDate) return alert("Enter join date");
    const initialSalary = n(form.monthlySalary);
    const newLabourer = {
      id:genId(),
      name:form.name,
      role:form.role||"",
      phone:form.phone||"",
      monthlySalary:initialSalary,
      joinDate:form.joinDate,
      createdAt:today(),
      salaryHistory: initialSalary > 0 ? [{id:genId(), amount:initialSalary, effectiveFrom:form.joinDate, note:"Initial salary"}] : []
    };
    setLabourers(p=>[...p,newLabourer]);
    close();
  };

  const updateSalary=()=>{
    if(!form.newSalary) return alert("Enter new salary amount");
    if(!form.effectiveFrom) return alert("Enter effective from date");
    setLabourers(p=>p.map(l=>{
      if(l.id!==selLabourer.id) return l;
      const newEntry = {id:genId(), amount:n(form.newSalary), effectiveFrom:form.effectiveFrom, note:form.note||"Salary revision"};
      return {...l, monthlySalary:n(form.newSalary), salaryHistory:[...(l.salaryHistory||[]),newEntry]};
    }));
    close();
  };

  // Pay regular salary
  const paySalary=()=>{
    const lab=labourers.find(l=>l.id===form.labourerId);
    if(!form.labourerId||!form.accountId||!form.amount) return alert("Fill all required fields");
    const monthEarned = calcCurrentMonthEarned(lab);
    const alreadyPaidThisMonth = getSalaryTxnsForLabourer(lab.id)
      .filter(t=>t.type==="salary" && t.salaryMonth === getCurrentMonthKey())
      .reduce((s,t)=>s+n(t.amount),0);
    const maxCanPay = monthEarned - alreadyPaidThisMonth;
    if(n(form.amount) > maxCanPay) {
      return alert(`⚠️ Cannot pay more than earned this month!\nEarned so far: ${fmtRs(monthEarned)}\nAlready paid: ${fmtRs(alreadyPaidThisMonth)}\nRemaining payable: ${fmtRs(maxCanPay)}`);
    }
    setTransactions(p=>[...p,{id:genId(),date:form.date||today(),type:"salary",
      amount:n(form.amount),creditAccountId:form.accountId,debitAccountId:null,
      description:`Salary — ${lab?.name}`,labourerId:form.labourerId,labourerName:lab?.name||"",
      note:form.note||"",month:form.month||"",salaryMonth:getCurrentMonthKey(),
      linkedVehicleId:form.linkedVehicleId||null,
      linkedVehicleNo:form.linkedVehicleId?vehicles.find(v=>v.id===form.linkedVehicleId)?.vehicleNo||"":""
    }]);
    close();
  };

  // Pay advance
  const payAdvance=()=>{
    const lab=labourers.find(l=>l.id===form.labourerId);
    if(!form.labourerId||!form.accountId||!form.amount) return alert("Fill all required fields");
    if(!form.forMonth) return alert("Specify which month this advance is for");
    setTransactions(p=>[...p,{id:genId(),date:form.date||today(),type:"advance",
      amount:n(form.amount),creditAccountId:form.accountId,debitAccountId:null,
      description:`Advance — ${lab?.name} (for ${form.forMonth})`,
      labourerId:form.labourerId,labourerName:lab?.name||"",
      forMonth:form.forMonth,note:form.note||"",
      linkedVehicleId:form.linkedVehicleId||null,
      linkedVehicleNo:form.linkedVehicleId?vehicles.find(v=>v.id===form.linkedVehicleId)?.vehicleNo||"":""
    }]);
    close();
  };

  const getCurrentMonthKey=()=>{
    const now=new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  };

  const getSalaryTxnsForLabourer=(labId)=>transactions.filter(t=>(t.type==="salary"||t.type==="advance")&&t.labourerId===labId);

  const allSalaryTxns=transactions.filter(t=>t.type==="salary"||t.type==="advance").sort((a,b)=>b.date.localeCompare(a.date));
  const totalPaid=allSalaryTxns.filter(t=>t.type==="salary").reduce((s,t)=>s+n(t.amount),0);
  const totalAdvances=allSalaryTxns.filter(t=>t.type==="advance").reduce((s,t)=>s+n(t.amount),0);

  const viewLabourer = viewId ? labourers.find(l=>l.id===viewId) : null;
  const viewTxns = viewId ? getSalaryTxnsForLabourer(viewId).sort((a,b)=>b.date.localeCompare(a.date)) : [];

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>👷 Salaries & Labour</h1>
          <p style={{color:C.muted,fontSize:13}}>{labourers.length} labourers · Paid: {fmtRs(totalPaid)} · Advances: {fmtRs(totalAdvances)}</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn color="amber" onClick={()=>{setForm({date:today()});setModal("pay");}}>💸 Pay Salary</Btn>
          <Btn color="orange" onClick={()=>{setForm({date:today()});setModal("advance");}}>⚡ Pay Advance</Btn>
          <Btn color="ghost" onClick={()=>{setForm({joinDate:today()});setModal("add");}}>+ Add Labourer</Btn>
        </div>
      </div>

      {viewLabourer ? (
        // ── LABOURER DETAIL VIEW ──
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
            <Btn color="ghost" onClick={()=>setViewId(null)}>← Back</Btn>
            <span style={{fontSize:18,fontWeight:800}}>{viewLabourer.name}</span>
            {viewLabourer.role&&<Tag color={C.blue}>{viewLabourer.role}</Tag>}
          </div>
          {(() => {
            const earned = calcEarnedSalary(viewLabourer);
            const totalPaidToLabourer = viewTxns.filter(t=>t.type==="salary").reduce((s,t)=>s+n(t.amount),0);
            const totalAdvancesToLabourer = viewTxns.filter(t=>t.type==="advance").reduce((s,t)=>s+n(t.amount),0);
            const totalDeducted = totalPaidToLabourer + totalAdvancesToLabourer;
            const remaining = earned.earned - totalDeducted;
            const currentRate = getSalaryRateForDate(viewLabourer, today());
            const monthEarned = calcCurrentMonthEarned(viewLabourer);
            const paidThisMonth = viewTxns
              .filter(t=>t.type==="salary"&&t.salaryMonth===`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}`)
              .reduce((s,t)=>s+n(t.amount),0);
            const advancesThisMonth = viewTxns
              .filter(t=>t.type==="advance")
              .reduce((s,t)=>s+n(t.amount),0);

            return (
              <div>
                {/* Stats */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:14,marginBottom:20}}>
                  <StatBox label="Current Monthly Salary" value={fmtRs(currentRate)} color={C.amber}/>
                  <StatBox label="Total Earned (lifetime)" value={fmtRs(earned.earned)} color={C.blue}/>
                  <StatBox label="This Month Earned" value={fmtRs(monthEarned)} color={C.teal}/>
                  <StatBox label="This Month Paid" value={fmtRs(paidThisMonth)} color={C.green}/>
                  <StatBox label="Total Advances" value={fmtRs(advancesThisMonth)} color={C.orange}/>
                  <StatBox label="Net Remaining" value={fmtRs(remaining)} color={remaining>0?C.red:C.muted} sub={remaining>0?"Payable":remaining<0?"Overpaid":"Clear"}/>
                </div>

                {/* Info row */}
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,marginBottom:20}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
                    <div><Label>Join Date</Label><div style={{fontWeight:700}}>{viewLabourer.joinDate||"—"}</div></div>
                    <div><Label>Phone</Label><div style={{color:C.muted}}>{viewLabourer.phone||"—"}</div></div>
                    <div><Label>Working Days</Label><div className="mono" style={{fontWeight:700,color:C.blue}}>{viewLabourer.joinDate?daysBetween(viewLabourer.joinDate,today())+" days":"—"}</div></div>
                  </div>
                </div>

                {/* Salary History */}
                <div style={{marginBottom:20}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{fontSize:14,fontWeight:700,color:C.muted}}>SALARY REVISION HISTORY</div>
                    <Btn color="purple" small onClick={()=>{setSelLabourer(viewLabourer);setForm({effectiveFrom:today()});setModal("updateSalary");}}>✏️ Update Salary</Btn>
                  </div>
                  {(viewLabourer.salaryHistory||[]).length===0?<div style={{color:C.muted,fontSize:13}}>No history</div>:(
                    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                      <table style={{width:"100%",borderCollapse:"collapse"}}>
                        <thead><tr><TH ch="Effective From"/><TH ch="Monthly Salary" right/><TH ch="Note"/></tr></thead>
                        <tbody>{[...(viewLabourer.salaryHistory||[])].sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom)).map((h,i)=>(
                          <tr key={h.id}><TD color={C.muted}>{h.effectiveFrom}</TD><TD right mono color={C.amber} bold>{fmtRs(h.amount)}</TD><TD color={C.muted}>{h.note||"—"}{i===0&&<span style={{marginLeft:6,background:C.greenSoft,color:C.green,padding:"1px 7px",borderRadius:10,fontSize:10,fontWeight:700}}>CURRENT</span>}</TD></tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Payment history */}
                <div style={{fontSize:14,fontWeight:700,color:C.muted,marginBottom:12}}>PAYMENT HISTORY</div>
                {viewTxns.length===0?<Empty icon="💸" text="No payments yet."/>:(
                  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr><TH ch="Date"/><TH ch="Type"/><TH ch="For Month/Period"/><TH ch="Project"/><TH ch="Account"/><TH ch="Amount" right/></tr></thead>
                      <tbody>{viewTxns.map(t=>{
                        const cfg=TXN_TYPES[t.type]||{label:t.type,color:C.muted};
                        const acct=accounts.find(a=>a.id===t.creditAccountId);
                        return(<tr key={t.id}>
                          <TD color={C.muted}>{t.date}</TD>
                          <TD><Tag color={cfg.color}>{cfg.label}</Tag></TD>
                          <TD color={C.muted}>{t.forMonth||t.month||"—"}</TD>
                          <TD color={C.muted}>{t.linkedVehicleNo?<Tag color={C.teal}>🚛 {t.linkedVehicleNo}</Tag>:"—"}</TD>
                          <TD><Tag color={C.blue}>{acct?.name||"—"}</Tag></TD>
                          <TD right mono color={t.type==="advance"?C.orange:C.red} bold>{fmtRs(t.amount)}</TD>
                        </tr>);
                      })}</tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        // ── LABOURERS LIST ──
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          <div>
            <div style={{marginBottom:12,fontSize:14,fontWeight:700,color:C.muted}}>LABOURERS</div>
            {labourers.length===0?<Empty icon="👷" text="No labourers added yet."/>:(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {labourers.map(l=>{
                  const labTxns = getSalaryTxnsForLabourer(l.id);
                  const totalPaidToL = labTxns.filter(t=>t.type==="salary").reduce((s,t)=>s+n(t.amount),0);
                  const totalAdvancesL = labTxns.filter(t=>t.type==="advance").reduce((s,t)=>s+n(t.amount),0);
                  const monthEarned = calcCurrentMonthEarned(l);
                  const currentRate = getSalaryRateForDate(l, today());
                  const paidThisMonth = labTxns
                    .filter(t=>t.type==="salary"&&t.salaryMonth===`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}`)
                    .reduce((s,t)=>s+n(t.amount),0);
                  const thisMonthRemaining = monthEarned - paidThisMonth;

                  return(
                    <div key={l.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:16,cursor:"pointer"}}
                      onClick={()=>setViewId(l.id)}
                      onMouseEnter={e=>e.currentTarget.style.borderColor=C.amber}
                      onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                        <div>
                          <div style={{fontWeight:700,fontSize:14}}>{l.name}</div>
                          <div style={{fontSize:12,color:C.muted}}>{l.role||"—"} {l.phone?`· ${l.phone}`:""}</div>
                          {l.joinDate&&<div style={{fontSize:11,color:C.muted,marginTop:2}}>Joined: {l.joinDate} · {daysBetween(l.joinDate,today())} days</div>}
                        </div>
                        <Tag color={C.amber}>{fmtRs(currentRate)}/mo</Tag>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                        <div style={{background:C.card2,borderRadius:8,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase"}}>This Month Earned</div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:C.teal}}>{fmtRs(monthEarned)}</div>
                        </div>
                        <div style={{background:C.card2,borderRadius:8,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase"}}>Paid This Month</div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:C.green}}>{fmtRs(paidThisMonth)}</div>
                        </div>
                        <div style={{background:thisMonthRemaining>0?C.redSoft:C.card2,borderRadius:8,padding:"8px 10px",border:thisMonthRemaining>0?`1px solid ${C.red}33`:"none"}}>
                          <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase"}}>Payable Now</div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:thisMonthRemaining>0?C.red:C.muted}}>{fmtRs(Math.max(0,thisMonthRemaining))}</div>
                        </div>
                      </div>
                      {totalAdvancesL>0&&<div style={{marginTop:8,fontSize:12,color:C.orange}}>⚡ Total Advances: {fmtRs(totalAdvancesL)}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div style={{marginBottom:12,fontSize:14,fontWeight:700,color:C.muted}}>RECENT PAYMENTS</div>
            {allSalaryTxns.length===0?<Empty icon="💸" text="No salary payments yet."/>:(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr><TH ch="Date"/><TH ch="Labourer"/><TH ch="Type"/><TH ch="Project"/><TH ch="Amount" right/></tr></thead>
                  <tbody>
                    {allSalaryTxns.slice(0,20).map(t=>{
                      const cfg=TXN_TYPES[t.type]||{label:t.type,color:C.muted};
                      return(<tr key={t.id}><TD color={C.muted}>{t.date}</TD><TD bold>{t.labourerName}</TD>
                        <TD><Tag color={cfg.color}>{cfg.label}</Tag></TD>
                        <TD color={C.muted}>{t.linkedVehicleNo?<Tag color={C.teal}>🚛 {t.linkedVehicleNo}</Tag>:"—"}</TD>
                        <TD right mono color={t.type==="advance"?C.orange:C.red} bold>{fmtRs(t.amount)}</TD>
                      </tr>);
                    })}
                    <tr><td colSpan={4} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>TOTAL PAID + ADVANCES</td>
                      <td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.red,fontWeight:700}}>{fmtRs(totalPaid+totalAdvances)}</span></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ADD LABOURER MODAL */}
      {modal==="add"&&(
        <Modal title="Add Labourer" onSave={addLabourer} saveLabel="Add" onClose={close}>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Full Name" half><input value={form.name||""} onChange={f("name")} placeholder="e.g. Muhammad Ali"/></Fld>
            <Fld label="Role" half><input value={form.role||""} onChange={f("role")} placeholder="e.g. Driver, Loader"/></Fld>
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="+92 300..."/></Fld>
            <Fld label="Join Date" half><input type="date" value={form.joinDate||""} onChange={f("joinDate")}/></Fld>
          </div>
          <Fld label="Monthly Salary (Rs)">
            <input type="number" value={form.monthlySalary||""} onChange={f("monthlySalary")} placeholder="e.g. 20000"/>
          </Fld>
          {form.monthlySalary&&form.joinDate&&(
            <div style={{background:C.tealSoft,border:`1px solid ${C.teal}33`,borderRadius:8,padding:"10px 14px",fontSize:13,color:C.teal}}>
              Daily rate: <strong className="mono">{fmtRs(n(form.monthlySalary)/30)}</strong> · Earning salary from {form.joinDate}
            </div>
          )}
        </Modal>
      )}

      {/* UPDATE SALARY MODAL */}
      {modal==="updateSalary"&&selLabourer&&(
        <Modal title={`✏️ Update Salary — ${selLabourer.name}`} onSave={updateSalary} saveLabel="Update" onClose={close}>
          <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16}}>
            <div style={{fontSize:13,color:C.muted,marginBottom:4}}>Current Monthly Salary</div>
            <div className="mono" style={{fontSize:22,fontWeight:800,color:C.amber}}>{fmtRs(getSalaryRateForDate(selLabourer,today()))}</div>
          </div>
          <div style={{background:C.amberSoft,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"10px 14px",fontSize:13,color:C.amber,marginBottom:14}}>
            ℹ️ The new salary will be calculated from the effective date, not from join date.
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="New Monthly Salary (Rs)" half><input type="number" value={form.newSalary||""} onChange={f("newSalary")} placeholder="e.g. 25000" autoFocus/></Fld>
            <Fld label="Effective From" half><input type="date" value={form.effectiveFrom||""} onChange={f("effectiveFrom")}/></Fld>
          </div>
          <Fld label="Note (reason for revision)"><input value={form.note||""} onChange={f("note")} placeholder="e.g. Annual increment, Performance raise"/></Fld>
        </Modal>
      )}

      {/* PAY SALARY MODAL */}
      {modal==="pay"&&(()=>{
        const lab = form.labourerId ? labourers.find(l=>l.id===form.labourerId) : null;
        const monthEarned = lab ? calcCurrentMonthEarned(lab) : 0;
        const monthKey = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}`;
        const paidThisMonth = lab ? getSalaryTxnsForLabourer(lab.id)
          .filter(t=>t.type==="salary"&&t.salaryMonth===monthKey)
          .reduce((s,t)=>s+n(t.amount),0) : 0;
        const maxPayable = Math.max(0, monthEarned - paidThisMonth);
        const enteredAmt = n(form.amount);
        const overLimit = enteredAmt > maxPayable && maxPayable > 0;

        return(
          <Modal title="💸 Pay Salary" onSave={paySalary} saveLabel="Pay Salary" onClose={close}>
            <Fld label="Labourer">
              <select value={form.labourerId||""} onChange={e=>setForm(p=>({...p,labourerId:e.target.value,amount:""}))}>
                <option value="">— Select —</option>
                {labourers.map(l=><option key={l.id} value={l.id}>{l.name} {l.role?`(${l.role})`:""}</option>)}
              </select>
            </Fld>
            {lab&&(
              <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:14}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <div><Label>Monthly Salary</Label><div className="mono" style={{fontWeight:700,color:C.amber}}>{fmtRs(getSalaryRateForDate(lab,today()))}</div></div>
                  <div><Label>Earned This Month</Label><div className="mono" style={{fontWeight:700,color:C.teal}}>{fmtRs(monthEarned)}</div></div>
                  <div><Label>Max Payable Now</Label><div className="mono" style={{fontWeight:700,color:maxPayable>0?C.green:C.muted}}>{fmtRs(maxPayable)}</div></div>
                </div>
                {paidThisMonth>0&&<div style={{marginTop:8,fontSize:12,color:C.muted}}>Already paid this month: {fmtRs(paidThisMonth)}</div>}
              </div>
            )}
            {overLimit&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.red,marginBottom:12}}>⚠️ Amount exceeds what's earned this month! Max payable: {fmtRs(maxPayable)}</div>}
            <AcctSelect accounts={accounts} value={form.accountId} onChange={f("accountId")} label="Pay From Account"/>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
              <Fld label="Amount (Rs)" half>
                <input type="number" value={form.amount||""} onChange={f("amount")} placeholder="Amount"
                  style={{borderColor:overLimit?C.red:C.border}}/>
              </Fld>
            </div>
            <Fld label="For Month (label)"><input value={form.month||""} onChange={f("month")} placeholder="e.g. April 2026"/></Fld>
            <ProjectSelect vehicles={vehicles} value={form.linkedVehicleId} onChange={f("linkedVehicleId")}/>
            {form.linkedVehicleId&&<div style={{background:C.tealSoft,border:`1px solid ${C.teal}33`,borderRadius:8,padding:"9px 14px",fontSize:12,color:C.teal,marginBottom:8}}>✓ This salary will be included in the linked project's P&L</div>}
            <Fld label="Note"><input value={form.note||""} onChange={f("note")} placeholder="Optional"/></Fld>
          </Modal>
        );
      })()}

      {/* PAY ADVANCE MODAL */}
      {modal==="advance"&&(()=>{
        const lab = form.labourerId ? labourers.find(l=>l.id===form.labourerId) : null;
        const nextMonthName = ()=>{
          const d=new Date();d.setMonth(d.getMonth()+1);
          return d.toLocaleString("en-PK",{month:"long",year:"numeric"});
        };

        return(
          <Modal title="⚡ Pay Advance" onSave={payAdvance} saveLabel="Pay Advance" onClose={close}>
            <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"10px 14px",fontSize:13,color:C.orange,marginBottom:14}}>
              ⚡ An advance is deducted from a future month's salary. It will be tracked separately and shown as outstanding.
            </div>
            <Fld label="Labourer">
              <select value={form.labourerId||""} onChange={e=>setForm(p=>({...p,labourerId:e.target.value}))}>
                <option value="">— Select —</option>
                {labourers.map(l=><option key={l.id} value={l.id}>{l.name} {l.role?`(${l.role})`:""}</option>)}
              </select>
            </Fld>
            {lab&&(()=>{
              const prevAdvances = getSalaryTxnsForLabourer(lab.id)
                .filter(t=>t.type==="advance")
                .reduce((s,t)=>s+n(t.amount),0);
              return prevAdvances>0?(
                <div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.red,marginBottom:12}}>
                  ⚠️ {lab.name} has {fmtRs(prevAdvances)} in outstanding advances
                </div>
              ):null;
            })()}
            <AcctSelect accounts={accounts} value={form.accountId} onChange={f("accountId")} label="Pay From Account"/>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
              <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="Advance amount"/></Fld>
            </div>
            <Fld label="This Advance Is For Month">
              <input value={form.forMonth||""} onChange={f("forMonth")} placeholder={`e.g. ${nextMonthName()}`}/>
            </Fld>
            <ProjectSelect vehicles={vehicles} value={form.linkedVehicleId} onChange={f("linkedVehicleId")}/>
            <Fld label="Note"><input value={form.note||""} onChange={f("note")} placeholder="Optional reason"/></Fld>
          </Modal>
        );
      })()}
    </div>
  );
}

// ─── CUSTOMERS PAGE ───────────────────────────────────────────────────────────
function CustomersPage({customers,setCustomers}){
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [search,setSearch]=useState("");
  const [rateSearch,setRateSearch]=useState("");
  const [balSearch,setBalSearch]=useState("");
  const [importPreview,setImportPreview]=useState([]);
  const [importError,setImportError]=useState("");
  const [editRates,setEditRates]=useState({});
  const [editBals,setEditBals]=useState({});
  const [selCustomer,setSelCustomer]=useState(null);
  const fileRef=useRef();
  const balFileRef=useRef();
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));

  const filtered=useMemo(()=>customers.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())||(c.city||"").toLowerCase().includes(search.toLowerCase())),[customers,search]);

  // ── Add / Edit helpers ──
  const saveAdd=()=>{
    if(!form.name) return alert("Name required");
    setCustomers(p=>[{id:genId(),...form,defaultRate:n(form.defaultRate),openingBalance:n(form.openingBalance),createdAt:today()},...p]);
    setModal(null);setForm({});
  };
  const saveEditCustomer=()=>{
    setCustomers(p=>p.map(c=>c.id===selCustomer.id?{...c,defaultRate:n(form.defaultRate),openingBalance:n(form.openingBalance)}:c));
    setModal(null);setForm({});setSelCustomer(null);
  };

  // ── Batch Rate ──
  const openBatchRate=()=>{const map={};customers.forEach(c=>{map[c.id]=c.defaultRate||"";});setEditRates(map);setRateSearch("");setModal("batchRate");};
  const saveBatchRates=()=>{setCustomers(p=>p.map(c=>({...c,defaultRate:n(editRates[c.id]??c.defaultRate)})));setModal(null);};

  // ── Batch Opening Balance ──
  const openBatchBalance=()=>{const map={};customers.forEach(c=>{map[c.id]=c.openingBalance||"";});setEditBals(map);setBalSearch("");setModal("batchBal");};
  const saveBatchBals=()=>{setCustomers(p=>p.map(c=>({...c,openingBalance:n(editBals[c.id]??c.openingBalance)})));setModal(null);};

  // ── Import customers (with Opening Balance column) ──
  const handleFileSelect=async(e)=>{
    const file=e.target.files[0];if(!file)return;setImportError("");
    try{
      const XLSX=await loadXLSX();const data=await file.arrayBuffer();const wb=XLSX.read(data);
      const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      if(!rows.length) return setImportError("File is empty.");
      const norm=rows.map(r=>{
        const low={};Object.keys(r).forEach(k=>{low[k.trim().toLowerCase()]=r[k];});
        return{
          name:String(low.name||low["shop name"]||low["customer name"]||"").trim(),
          phone:String(low.phone||low["mobile"]||"").trim(),
          city:String(low.city||low["area"]||"").trim(),
          address:String(low.address||"").trim(),
          defaultRate:n(low.rate||low["default rate"]||0),
          openingBalance:n(low["opening balance"]||low["opening bal"]||low["prev balance"]||low["previous balance"]||low["balance"]||0),
        };
      }).filter(r=>r.name);
      if(!norm.length) return setImportError("No valid rows. Check 'Name' column.");
      setImportPreview(norm);
    }catch(err){setImportError("Could not read: "+err.message);}
    e.target.value="";
  };
  const confirmImport=()=>{
    let added=0,updated=0;
    setCustomers(prev=>{const next=[...prev];
      importPreview.forEach(row=>{
        const i=next.findIndex(c=>c.name.toLowerCase()===row.name.toLowerCase());
        if(i>=0){next[i]={...next[i],...row};updated++;}
        else{next.unshift({id:genId(),...row,createdAt:today()});added++;}
      });return next;
    });
    alert(`✅ ${added} added · ${updated} updated`);setImportPreview([]);setModal(null);
  };

  // ── Import opening balances only (name + balance) ──
  const [balImportPreview,setBalImportPreview]=useState([]);
  const [balImportError,setBalImportError]=useState("");
  const handleBalFileSelect=async(e)=>{
    const file=e.target.files[0];if(!file)return;setBalImportError("");
    try{
      const XLSX=await loadXLSX();const data=await file.arrayBuffer();const wb=XLSX.read(data);
      const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      if(!rows.length) return setBalImportError("File is empty.");
      const norm=rows.map(r=>{
        const low={};Object.keys(r).forEach(k=>{low[k.trim().toLowerCase()]=r[k];});
        const name=String(low.name||low["customer name"]||low["shop name"]||"").trim();
        const bal=n(low["opening balance"]||low["opening bal"]||low["balance"]||low["prev balance"]||0);
        return{name,openingBalance:bal};
      }).filter(r=>r.name);
      if(!norm.length) return setBalImportError("No valid rows. Need Name + Opening Balance columns.");
      // Match to existing customers
      const matched=norm.map(r=>({...r,match:customers.find(c=>c.name.toLowerCase()===r.name.toLowerCase())||null}));
      setBalImportPreview(matched);
    }catch(err){setBalImportError("Could not read: "+err.message);}
    e.target.value="";
  };
  const confirmBalImport=()=>{
    const toUpdate=balImportPreview.filter(r=>r.match);
    if(!toUpdate.length) return alert("No matching customers found.");
    setCustomers(p=>p.map(c=>{
      const match=toUpdate.find(r=>r.match.id===c.id);
      return match?{...c,openingBalance:match.openingBalance}:c;
    }));
    alert(`✅ Opening balances updated for ${toUpdate.length} customer(s)`);
    setBalImportPreview([]);setBalImportError("");setModal(null);
  };

  const downloadTemplate=async()=>{
    const XLSX=await loadXLSX();
    const ws=XLSX.utils.aoa_to_sheet([
      ["Name","Phone","City","Address","Rate","Opening Balance"],
      ["Ali Chicken Shop","0300-1234567","Khuzdar","Main Bazar",420,15000],
      ["Sana Poultry","0333-9876543","Quetta","Liaquat Road",415,0],
    ]);
    ws["!cols"]=[{wch:25},{wch:16},{wch:14},{wch:25},{wch:10},{wch:16}];
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Customers");XLSX.writeFile(wb,"customers_template.xlsx");
  };
  const downloadBalTemplate=async()=>{
    const XLSX=await loadXLSX();
    const ws=XLSX.utils.aoa_to_sheet([
      ["Name","Opening Balance"],
      ["Ali Chicken Shop",15000],
      ["Sana Poultry",8500],
    ]);
    ws["!cols"]=[{wch:30},{wch:16}];
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"OpeningBalances");XLSX.writeFile(wb,"opening_balances_template.xlsx");
  };

  const rateFiltered=useMemo(()=>customers.filter(c=>c.name.toLowerCase().includes(rateSearch.toLowerCase())||(c.city||"").toLowerCase().includes(rateSearch.toLowerCase())),[customers,rateSearch]);
  const balFiltered=useMemo(()=>customers.filter(c=>c.name.toLowerCase().includes(balSearch.toLowerCase())||(c.city||"").toLowerCase().includes(balSearch.toLowerCase())),[customers,balSearch]);
  const totalOpeningBal=customers.reduce((s,c)=>s+n(c.openingBalance),0);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>👤 Customers</h1>
          <p style={{color:C.muted,fontSize:13}}>
            {customers.length} customers
            {totalOpeningBal>0&&<span style={{marginLeft:12,color:C.orange}}>· Opening Bal: {fmtRs(totalOpeningBal)}</span>}
          </p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <Btn color="ghost" onClick={downloadTemplate}>⬇ Template</Btn>
          <Btn color="blue" onClick={()=>setModal("import")}>📥 Import Excel</Btn>
          <Btn color="orange" onClick={()=>setModal("importBal")}>📥 Import Balances</Btn>
          <Btn color="teal" onClick={openBatchBalance}>💰 Update Balances</Btn>
          <Btn color="purple" onClick={openBatchRate}>✏️ Update Rates</Btn>
          <Btn color="amber" onClick={()=>{setForm({});setModal("add");}}>+ Add Customer</Btn>
        </div>
      </div>
      <div style={{marginBottom:14}}><input placeholder="🔍  Search by name or city…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:340}}/></div>
      {customers.length===0?<Empty icon="👤" text="No customers yet."/>:(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Name","Phone","City","Address","Default Rate","Opening Balance","Action"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
            <tbody>{filtered.map(cu=>(
              <tr key={cu.id}>
                <TD bold>{cu.name}</TD>
                <TD color={C.muted}>{cu.phone||"—"}</TD>
                <TD>{cu.city||"—"}</TD>
                <TD color={C.muted}>{cu.address||"—"}</TD>
                <TD><span className="mono" style={{color:cu.defaultRate?C.amber:C.muted,fontWeight:700}}>{cu.defaultRate?`Rs.${fmt(cu.defaultRate)}/kg`:"Not set"}</span></TD>
                <TD>
                  {cu.openingBalance>0
                    ?<span className="mono" style={{color:C.orange,fontWeight:700}}>{fmtRs(cu.openingBalance)}</span>
                    :<span style={{color:C.muted,fontSize:12}}>—</span>}
                </TD>
                <TD>
                  <Btn small color="ghost" onClick={()=>{setSelCustomer(cu);setForm({defaultRate:cu.defaultRate||"",openingBalance:cu.openingBalance||""});setModal("editCustomer");}}>Edit</Btn>
                </TD>
              </tr>
            ))}</tbody>
          </table>
          {filtered.length===0&&<Empty icon="🔍" text="No customers match"/>}
        </div>
      )}

      {/* ── ADD CUSTOMER ── */}
      {modal==="add"&&(<Modal title="Add Customer" onSave={saveAdd} saveLabel="Add" onClose={()=>setModal(null)}>
        <div style={{display:"flex",flexWrap:"wrap",gap:"0 12px"}}>
          <Fld label="Name / Shop Name"><input value={form.name||""} onChange={f("name")} placeholder="e.g. Ali Chicken Shop"/></Fld>
          <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="+92 300..."/></Fld>
          <Fld label="City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Khuzdar"/></Fld>
          <Fld label="Address"><input value={form.address||""} onChange={f("address")} placeholder="Street / area"/></Fld>
          <Fld label="Default Rate (Rs/kg)" half><input type="number" value={form.defaultRate||""} onChange={f("defaultRate")} placeholder="e.g. 420"/></Fld>
          <Fld label="Opening Balance (Rs)" half><input type="number" value={form.openingBalance||""} onChange={f("openingBalance")} placeholder="Previous due balance"/></Fld>
        </div>
        {n(form.openingBalance)>0&&(
          <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.orange,marginTop:4}}>
            💰 This customer starts with a previous balance of <strong>{fmtRs(n(form.openingBalance))}</strong> — it will be added to their total receivable.
          </div>
        )}
      </Modal>)}

      {/* ── EDIT CUSTOMER ── */}
      {modal==="editCustomer"&&selCustomer&&(
        <Modal title={`Edit — ${selCustomer.name}`} onSave={saveEditCustomer} saveLabel="Save" onClose={()=>setModal(null)} width={500}>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Default Rate (Rs/kg)" half><input type="number" value={form.defaultRate||""} onChange={f("defaultRate")} placeholder="e.g. 420" autoFocus/></Fld>
            <Fld label="Opening Balance (Rs)" half><input type="number" value={form.openingBalance||""} onChange={f("openingBalance")} placeholder="Previous due balance"/></Fld>
          </div>
          {n(form.openingBalance)>0&&(
            <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.orange}}>
              💰 Opening balance of <strong>{fmtRs(n(form.openingBalance))}</strong> will appear as "Previous Balance" on the customer statement.
            </div>
          )}
          <div style={{marginTop:14,padding:"12px 14px",background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,color:C.muted}}>
            To edit name, phone, city or address, use the Import Excel feature to update those fields.
          </div>
        </Modal>
      )}

      {/* ── BATCH RATE UPDATE ── */}
      {modal==="batchRate"&&(<Modal title="✏️ Update Rates" onSave={saveBatchRates} saveLabel="Save All" onClose={()=>setModal(null)} width={680}>
        <input placeholder="🔍  Filter…" value={rateSearch} onChange={e=>setRateSearch(e.target.value)} style={{marginBottom:12}}/>
        <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:420,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}><tr><TH ch="Customer"/><TH ch="City"/><TH ch="Current Rate"/><TH ch="New Rate"/></tr></thead>
            <tbody>{rateFiltered.map(cu=>(
              <tr key={cu.id}><TD bold>{cu.name}</TD><TD color={C.muted}>{cu.city||"—"}</TD>
                <TD><span className="mono" style={{color:cu.defaultRate?C.amber:C.muted}}>{cu.defaultRate?`Rs.${fmt(cu.defaultRate)}`:"-"}</span></TD>
                <TD><input className="ci" type="number" value={editRates[cu.id]??cu.defaultRate??""} placeholder="Rate" onChange={e=>setEditRates(p=>({...p,[cu.id]:e.target.value}))} style={{width:110}}/></TD>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Modal>)}

      {/* ── BATCH OPENING BALANCE UPDATE ── */}
      {modal==="batchBal"&&(<Modal title="💰 Update Opening Balances" onSave={saveBatchBals} saveLabel="Save All" onClose={()=>setModal(null)} width={700}>
        <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.orange}}>
          💡 Opening balance = amount the customer owed <strong>before</strong> you started using this app. Leave blank to keep existing value.
        </div>
        <input placeholder="🔍  Filter…" value={balSearch} onChange={e=>setBalSearch(e.target.value)} style={{marginBottom:12}}/>
        <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:420,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}><tr><TH ch="Customer"/><TH ch="City"/><TH ch="Current Opening Bal"/><TH ch="New Opening Bal (Rs)"/></tr></thead>
            <tbody>{balFiltered.map(cu=>(
              <tr key={cu.id}><TD bold>{cu.name}</TD><TD color={C.muted}>{cu.city||"—"}</TD>
                <TD><span className="mono" style={{color:cu.openingBalance>0?C.orange:C.muted}}>{cu.openingBalance>0?fmtRs(cu.openingBalance):"—"}</span></TD>
                <TD><input className="ci" type="number" value={editBals[cu.id]??cu.openingBalance??""} placeholder="0" onChange={e=>setEditBals(p=>({...p,[cu.id]:e.target.value}))} style={{width:130}}/></TD>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Modal>)}

      {/* ── IMPORT CUSTOMERS (with Opening Balance) ── */}
      {modal==="import"&&(<Modal title="📥 Import Customers" onSave={importPreview.length?confirmImport:undefined} saveLabel={`Import ${importPreview.length}`} onClose={()=>{setModal(null);setImportPreview([]);setImportError("");}} width={780}>
        <div style={{background:C.blueSoft,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"12px 16px",marginBottom:16,fontSize:13}}>
          <div style={{fontWeight:700,color:C.blue,marginBottom:4}}>Columns: Name | Phone | City | Address | Rate | Opening Balance</div>
          <div style={{color:C.muted,fontSize:12}}>Existing names = update · New names = add · <strong>Opening Balance</strong> column is optional</div>
        </div>
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          <Btn color="ghost" onClick={downloadTemplate}>⬇ Sample Template</Btn>
          <Btn color="amber" onClick={()=>fileRef.current.click()}>📂 Choose File</Btn>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleFileSelect}/>
        </div>
        {importError&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px 14px",color:C.red,fontSize:13,marginBottom:12}}>⚠ {importError}</div>}
        {importPreview.length>0?(
          <div>
            <div style={{fontWeight:700,marginBottom:10,color:C.green}}>✅ {importPreview.length} rows ready</div>
            <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:300,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:C.card3}}><tr>{["Name","Phone","City","Rate","Opening Bal"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                <tbody>{importPreview.map((r,i)=>{const exists=customers.some(c=>c.name.toLowerCase()===r.name.toLowerCase());return(
                  <tr key={i}>
                    <TD bold>{r.name}<span style={{marginLeft:6,fontSize:10,background:exists?C.amberSoft:C.greenSoft,color:exists?C.amber:C.green,padding:"1px 7px",borderRadius:10}}>{exists?"UPDATE":"NEW"}</span></TD>
                    <TD color={C.muted}>{r.phone||"—"}</TD><TD>{r.city||"—"}</TD>
                    <TD><span className="mono" style={{color:r.defaultRate?C.amber:C.muted}}>{r.defaultRate?`Rs.${fmt(r.defaultRate)}`:"-"}</span></TD>
                    <TD><span className="mono" style={{color:r.openingBalance>0?C.orange:C.muted}}>{r.openingBalance>0?fmtRs(r.openingBalance):"—"}</span></TD>
                  </tr>);})}</tbody>
              </table>
            </div>
          </div>
        ):<div style={{textAlign:"center",padding:"30px 20px",color:C.muted,border:`2px dashed ${C.border}`,borderRadius:10}}>📂 Select Excel file to preview</div>}
      </Modal>)}

      {/* ── IMPORT OPENING BALANCES ONLY ── */}
      {modal==="importBal"&&(<Modal title="📥 Import Opening Balances" onSave={balImportPreview.filter(r=>r.match).length?confirmBalImport:undefined} saveLabel={`Update ${balImportPreview.filter(r=>r.match).length} Balances`} onClose={()=>{setModal(null);setBalImportPreview([]);setBalImportError("");}} width={700}>
        <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"12px 16px",marginBottom:16,fontSize:13}}>
          <div style={{fontWeight:700,color:C.orange,marginBottom:4}}>Columns: Name | Opening Balance</div>
          <div style={{color:C.muted,fontSize:12}}>Only updates existing customers — matched by name. Use this to bulk-import previous balances.</div>
        </div>
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          <Btn color="ghost" onClick={downloadBalTemplate}>⬇ Balance Template</Btn>
          <Btn color="amber" onClick={()=>balFileRef.current.click()}>📂 Choose File</Btn>
          <input ref={balFileRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleBalFileSelect}/>
        </div>
        {balImportError&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px 14px",color:C.red,fontSize:13,marginBottom:12}}>⚠ {balImportError}</div>}
        {balImportPreview.length>0?(
          <div>
            <div style={{display:"flex",gap:16,marginBottom:10}}>
              <span style={{fontWeight:700,color:C.green}}>✅ {balImportPreview.filter(r=>r.match).length} matched</span>
              {balImportPreview.filter(r=>!r.match).length>0&&<span style={{color:C.red,fontWeight:700}}>⚠ {balImportPreview.filter(r=>!r.match).length} not found</span>}
            </div>
            <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:320,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:C.card3}}><tr><TH ch="Name in File"/><TH ch="Matched Customer"/><TH ch="Opening Balance" right/></tr></thead>
                <tbody>{balImportPreview.map((r,i)=>(
                  <tr key={i} style={{background:r.match?"transparent":C.redSoft}}>
                    <TD bold>{r.name}</TD>
                    <TD>{r.match?<span style={{color:C.green,fontWeight:700}}>✓ {r.match.name}{r.match.city?<span style={{color:C.muted,fontWeight:400}}> · {r.match.city}</span>:""}</span>:<span style={{color:C.red,fontSize:12}}>Not found in customers</span>}</TD>
                    <TD right mono color={r.openingBalance>0?C.orange:C.muted}>{r.openingBalance>0?fmtRs(r.openingBalance):"0"}</TD>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        ):<div style={{textAlign:"center",padding:"30px 20px",color:C.muted,border:`2px dashed ${C.border}`,borderRadius:10}}>📂 Select Excel file to preview</div>}
      </Modal>)}
    </div>
  );
}

// ─── SUPPLIERS PAGE ───────────────────────────────────────────────────────────
function SuppliersPage({suppliers,setSuppliers}){
  const [editingSup,setEditingSup]=useState(null);
  const [editForm,setEditForm]=useState({});
  const ef=k=>e=>setEditForm(p=>({...p,[k]:e.target.value}));
  const saveEditSup=()=>{
    if(!editForm.name) return alert("Name required");
    setSuppliers(p=>p.map(s=>s.id===editingSup.id?{...s,name:editForm.name,phone:editForm.phone||s.phone,city:editForm.city||s.city,region:editForm.region||s.region}:s));
    setEditingSup(null);setEditForm({});
  };
  const [modal,setModal]=useState(false);const [form,setForm]=useState({});
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const save=()=>{if(!form.name) return alert("Name required");setSuppliers(p=>[{id:genId(),...form,createdAt:today()},...p]);setModal(false);setForm({});};
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24}}>
        <div><h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>🏭 Suppliers</h1><p style={{color:C.muted,fontSize:13}}>{suppliers.length} suppliers</p></div>
        <Btn onClick={()=>{setForm({});setModal(true);}}>+ Add Supplier</Btn>
      </div>
      {suppliers.length===0?<Empty icon="🏭" text="No suppliers yet."/>:(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Name","Phone","City","Region","Added"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
            <tbody>{suppliers.map(s=><tr key={s.id}><TD bold>{s.name}</TD><TD color={C.muted}>{s.phone||"—"}</TD><TD>{s.city||"—"}</TD><TD><Tag color={C.purple}>{s.region||"Punjab"}</Tag></TD><TD color={C.muted}>{s.createdAt}</TD></tr>)}</tbody>
          </table>
        </div>
      )}
      {modal&&(<Modal title="Add Supplier" onSave={save} saveLabel="Add" onClose={()=>setModal(false)}>
        <div style={{display:"flex",flexWrap:"wrap",gap:"0 12px"}}>
          <Fld label="Name"><input value={form.name||""} onChange={f("name")} placeholder="e.g. Punjab Poultry Farms"/></Fld>
          <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="+92 300..."/></Fld>
          <Fld label="City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Lahore"/></Fld>
          <Fld label="Region" half><select value={form.region||"Punjab"} onChange={f("region")}><option>Punjab</option><option>Sindh</option><option>KPK</option><option>Balochistan</option><option>Other</option></select></Fld>
        </div>
      </Modal>)}
    </div>
  );
}

// ─── BATCH RECEIPT PAGE ───────────────────────────────────────────────────────
function BatchReceiptPage({vehicles,setVehicles,customers,accounts,labourers,addTxn}){
  const [date,setDate]=useState(today());
  const [accountId,setAccountId]=useState("");
  const [collectorId,setCollectorId]=useState("");
  const [collectorName,setCollectorName]=useState("");
  const [search,setSearch]=useState("");
  const [rows,setRows]=useState([]);
  const [submitted,setSubmitted]=useState(false);

  const buildRows=()=>{
    const map={};
    vehicles.forEach(v=>{
      v.sales.forEach(sale=>{
        const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
        const bal=sale.totalAmount-collected;
        if(bal<0.01) return;
        if(!map[sale.customerId]) map[sale.customerId]={customerId:sale.customerId,customerName:sale.customerName,pendingAmount:0,enterAmount:"",pendingSales:[]};
        map[sale.customerId].pendingAmount+=bal;
        map[sale.customerId].pendingSales.push({...sale,vehicleNo:v.vehicleNo,vehicleId:v.id,balance:bal,collected});
      });
    });
    Object.values(map).forEach(row=>row.pendingSales.sort((a,b)=>a.date.localeCompare(b.date)));
    return Object.values(map).sort((a,b)=>a.customerName.localeCompare(b.customerName));
  };

  const allRows=useMemo(buildRows,[vehicles]);
  const mergedRows=useMemo(()=>allRows.map(r=>{
    const entered=rows.find(x=>x.customerId===r.customerId);
    return{...r,enterAmount:entered?.enterAmount||""};
  }),[allRows,rows]);

  const mergedFiltered=useMemo(()=>mergedRows.filter(r=>r.customerName.toLowerCase().includes(search.toLowerCase())),[mergedRows,search]);
  const mergedWithAmt=mergedRows.filter(r=>n(r.enterAmount)>0);
  const totalMergedAmt=mergedWithAmt.reduce((s,r)=>s+n(r.enterAmount),0);

  const updateAmount=(customerId,val)=>{
    setRows(prev=>{
      const exists=prev.find(r=>r.customerId===customerId);
      if(exists) return prev.map(r=>r.customerId===customerId?{...r,enterAmount:val}:r);
      const base=allRows.find(r=>r.customerId===customerId);
      return base?[...prev,{...base,enterAmount:val}]:prev;
    });
  };

  const confirmBatchReceipt=()=>{
    if(!accountId) return alert("Select an account to receive into");
    if(mergedWithAmt.length===0) return alert("Enter amount for at least one customer");
    const collector=collectorId?labourers.find(l=>l.id===collectorId)?.name||collectorName:collectorName;

    setVehicles(vs=>vs.map(vehicle=>{
      let salesUpdated=[...vehicle.sales];
      mergedWithAmt.forEach(row=>{
        let remaining=n(row.enterAmount);
        const pendingForVehicle=row.pendingSales.filter(s=>s.vehicleId===vehicle.id);
        pendingForVehicle.forEach(pendingSale=>{
          if(remaining<=0) return;
          const saleIdx=salesUpdated.findIndex(s=>s.id===pendingSale.id);
          if(saleIdx<0) return;
          const sale=salesUpdated[saleIdx];
          const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
          const bal=sale.totalAmount-collected;
          if(bal<=0) return;
          const toApply=Math.min(remaining,bal);
          remaining-=toApply;
          const newReceipt={id:genId(),amount:toApply,date,method:"Batch Receipt",accountId,accountName:accounts.find(a=>a.id===accountId)?.name||"",collector,note:`Batch receipt${collector?` by ${collector}`:""}`};
          salesUpdated[saleIdx]={...sale,receipts:[...(sale.receipts||[]),newReceipt]};
        });
      });
      return{...vehicle,sales:salesUpdated};
    }));

    addTxn({date,type:"receipt",amount:totalMergedAmt,debitAccountId:accountId,creditAccountId:null,
      description:`Batch Receipt — ${mergedWithAmt.length} customers${collector?` · Collector: ${collector}`:""}`,note:""});

    setSubmitted(true);
    setRows([]);
  };

  const reset=()=>{setSubmitted(false);setRows([]);setAccountId("");setCollectorId("");setCollectorName("");};

  if(submitted) return(
    <div style={{textAlign:"center",padding:"80px 20px"}}>
      <div style={{fontSize:52,marginBottom:16}}>✅</div>
      <div style={{fontSize:22,fontWeight:800,marginBottom:8}}>Batch Receipt Recorded!</div>
      <div style={{color:C.muted,marginBottom:8}}>Total Collected: <span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(totalMergedAmt)}</span></div>
      <div style={{color:C.muted,fontSize:14,marginBottom:24}}>Amounts auto-applied to oldest invoices first</div>
      <Btn color="amber" onClick={reset}>+ New Batch Receipt</Btn>
    </div>
  );

  return(
    <div>
      <div style={{marginBottom:20}}>
        <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>📥 Batch Receipt</h1>
        <p style={{color:C.muted,fontSize:13}}>Enter amount received from each customer — auto-applied to oldest invoices first</p>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,marginBottom:20,display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end"}}>
        <Fld label="Receipt Date" sx={{marginBottom:0,width:160}}><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></Fld>
        <Fld label="Deposit Into Account" sx={{marginBottom:0,flex:1,minWidth:200}}>
          <select value={accountId} onChange={e=>setAccountId(e.target.value)}>
            <option value="">— Select Account —</option>
            {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Fld>
        <Fld label="Collector / Driver" sx={{marginBottom:0,flex:1,minWidth:200}}>
          <select value={collectorId} onChange={e=>{setCollectorId(e.target.value);setCollectorName(e.target.value?labourers.find(l=>l.id===e.target.value)?.name||"":"");}}>
            <option value="">— Select Collector —</option>
            {labourers.map(l=><option key={l.id} value={l.id}>{l.name} {l.role?`(${l.role})`:""}</option>)}
          </select>
        </Fld>
        {!collectorId&&(
          <Fld label="Or Enter Name Manually" sx={{marginBottom:0,flex:1,minWidth:160}}>
            <input value={collectorName} onChange={e=>setCollectorName(e.target.value)} placeholder="Collector name"/>
          </Fld>
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:14,marginBottom:20}}>
        <StatBox label="Customers with Pending" value={allRows.length} color={C.amber}/>
        <StatBox label="Total Pending" value={fmtRs(allRows.reduce((s,r)=>s+r.pendingAmount,0))} color={C.red}/>
        <StatBox label="Amount Entered" value={fmtRs(totalMergedAmt)} color={mergedWithAmt.length>0?C.green:C.muted}/>
      </div>
      {allRows.length===0?<Empty icon="🎉" text="No pending invoices! All customers are fully paid."/>:(
        <>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <input placeholder="🔍  Search customer…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:300}}/>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {mergedWithAmt.length>0&&<span style={{fontSize:13,color:C.muted}}>{mergedWithAmt.length} customers · {fmtRs(totalMergedAmt)}</span>}
              <Btn color="amber" onClick={confirmBatchReceipt} sx={{opacity:mergedWithAmt.length===0||!accountId?0.5:1}}>
                ✅ Confirm Batch Receipt ({mergedWithAmt.length})
              </Btn>
            </div>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}>
                <tr><TH ch="#"/><TH ch="Customer"/><TH ch="Invoices"/><TH ch="Total Pending" right/><TH ch="Oldest Invoice"/><TH ch="Amount to Receive" right/></tr>
              </thead>
              <tbody>
                {mergedFiltered.map((row,i)=>{
                  const entered=n(row.enterAmount);
                  const over=entered>row.pendingAmount;
                  const oldest=row.pendingSales[0];
                  return(
                    <tr key={row.customerId} style={{background:entered>0?C.greenSoft:"transparent"}}>
                      <TD color={C.muted} small>{i+1}</TD>
                      <TD bold>{row.customerName}</TD>
                      <TD color={C.muted} small>{row.pendingSales.length} invoice{row.pendingSales.length!==1?"s":""}</TD>
                      <TD right mono color={C.red}>{fmtRs(row.pendingAmount)}</TD>
                      <TD small color={C.muted}>{oldest?`${oldest.receiptNo} · ${oldest.date}`:"-"}</TD>
                      <TD right>
                        <input className="ci" type="number" placeholder="0"
                          value={row.enterAmount}
                          onChange={e=>updateAmount(row.customerId,e.target.value)}
                          style={{width:130,textAlign:"right",borderColor:over?C.red:C.border,color:over?C.red:C.text}}/>
                        {over&&<div style={{fontSize:10,color:C.red,marginTop:2}}>Exceeds pending!</div>}
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── REPORTS PAGE ─────────────────────────────────────────────────────────────
// Reusable searchable picker — shows a text box, live-filtered list, selected chip
function SearchPicker({items,value,onChange,placeholder,renderItem,renderChip,emptyText}){
  const [q,setQ]=useState("");
  const [open,setOpen]=useState(false);
  const ref=useRef();
  // Close dropdown on outside click
  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target)){setOpen(false);setQ("");}};
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  const filtered=useMemo(()=>items.filter(i=>renderItem(i).toLowerCase().includes(q.toLowerCase())).slice(0,12),[items,q]);
  const selected=value?items.find(i=>i.id===value):null;
  return(
    <div ref={ref} style={{position:"relative"}}>
      {selected?(
        <div style={{display:"flex",alignItems:"center",gap:10,background:C.card2,border:`1.5px solid ${C.amber}`,borderRadius:9,padding:"9px 14px"}}>
          <span style={{flex:1,fontWeight:700,fontSize:13}}>{renderChip?renderChip(selected):renderItem(selected)}</span>
          <button onClick={()=>{onChange("");setQ("");}} style={{background:"transparent",color:C.muted,fontSize:16,padding:"0 4px",lineHeight:1}} title="Clear">✕</button>
        </div>
      ):(
        <>
          <input
            value={q}
            onChange={e=>{setQ(e.target.value);setOpen(true);}}
            onFocus={()=>setOpen(true)}
            placeholder={placeholder}
            style={{width:"100%"}}
          />
          {open&&(
            <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:C.card,border:`1px solid ${C.border}`,borderRadius:10,zIndex:200,maxHeight:260,overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.45)"}}>
              {filtered.length===0
                ?<div style={{padding:"14px 16px",color:C.muted,fontSize:13}}>{emptyText||"No results found"}</div>
                :filtered.map(item=>(
                  <div key={item.id}
                    onMouseDown={e=>{e.preventDefault();onChange(item.id);setOpen(false);setQ("");}}
                    style={{padding:"11px 16px",cursor:"pointer",borderBottom:`1px solid ${C.border}22`,fontSize:13}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.card2}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    {renderItem(item)}
                  </div>
                ))
              }
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ReportsPage({vehicles,customers,suppliers,transactions}){
  const [tab,setTab]=useState("sales");
  const [fromDate,setFromDate]=useState(()=>{const d=new Date();d.setDate(1);return d.toISOString().split("T")[0];});
  const [toDate,setToDate]=useState(today());
  const [selCustomer,setSelCustomer]=useState("");
  const [selSupplier,setSelSupplier]=useState("");
  // separate search-filter state for sales & receipts tabs
  const [salesCustFilter,setSalesCustFilter]=useState("");
  const [receiptsCustFilter,setReceiptsCustFilter]=useState("");
  // Customer statement date filter + B/F toggle
  const [custFromDate,setCustFromDate]=useState(()=>{const d=new Date();d.setDate(1);return d.toISOString().split("T")[0];});
  const [custToDate,setCustToDate]=useState(today());
  const [custBF,setCustBF]=useState(true);

  const TABS=["sales","receipts","customer","supplier","receivables","sup_due","pnl","aging"];
  const TAB_LABELS={"sales":"📊 Sales","receipts":"🧾 Receipts","customer":"👤 Customer","supplier":"🏭 Supplier","receivables":"💳 Receivables","sup_due":"🏭 Sup. Due","pnl":"📈 P&L","aging":"⏳ Aging"};

  const allSales=useMemo(()=>{const res=[];vehicles.forEach(v=>v.sales.forEach(s=>res.push({...s,vehicleNo:v.vehicleNo,vehicleId:v.id})));return res;},[vehicles]);
  const allReceipts=useMemo(()=>{const res=[];vehicles.forEach(v=>v.sales.forEach(sale=>(sale.receipts||[]).forEach(r=>res.push({...r,saleId:sale.id,receiptNo:sale.receiptNo,customerName:sale.customerName,customerId:sale.customerId,vehicleNo:v.vehicleNo}))));return res;},[vehicles]);
  const allPurchases=useMemo(()=>{const res=[];vehicles.forEach(v=>v.purchases.forEach(p=>res.push({...p,vehicleNo:v.vehicleNo,vehicleId:v.id})));return res;},[vehicles]);
  const allSupplierPayments=useMemo(()=>{const res=[];vehicles.forEach(v=>v.purchases.forEach(p=>(p.payments||[]).forEach(pay=>res.push({...pay,purchaseId:p.id,supplierName:p.supplierName,supplierId:p.supplierId,vehicleNo:v.vehicleNo}))));return res;},[vehicles]);

  const inRange=(dateStr)=>dateStr>=fromDate&&dateStr<=toDate;

  // ── Sales tab ──
  const salesInRange=useMemo(()=>allSales.filter(s=>inRange(s.date)&&(!salesCustFilter||s.customerId===salesCustFilter)),[allSales,fromDate,toDate,salesCustFilter]);
  const salesTotal=salesInRange.reduce((s,x)=>s+n(x.weight)*n(x.rate),0);
  const salesWt=salesInRange.reduce((s,x)=>s+n(x.weight),0);
  const salesCollected=salesInRange.reduce((s,sale)=>s+(sale.receipts||[]).reduce((a,r)=>a+n(r.amount),0),0);
  const salesPending=salesTotal-salesCollected;

  // ── Receipts tab ──
  const receiptsInRange=useMemo(()=>allReceipts.filter(r=>inRange(r.date)&&(!receiptsCustFilter||r.customerId===receiptsCustFilter)),[allReceipts,fromDate,toDate,receiptsCustFilter]);
  const receiptsTotal=receiptsInRange.reduce((s,r)=>s+n(r.amount),0);

  // ── Customer statement ──
  const custInfo=customers.find(c=>c.id===selCustomer);
  const custOpeningBal=n(custInfo?.openingBalance);

  // B/F: sales & receipts BEFORE custFromDate (for brought-forward balance)
  const custSalesBefore=useMemo(()=>allSales.filter(s=>s.customerId===selCustomer&&s.date<custFromDate),[allSales,selCustomer,custFromDate]);
  const custReceiptsBefore=useMemo(()=>allReceipts.filter(r=>r.customerId===selCustomer&&r.date<custFromDate),[allReceipts,selCustomer,custFromDate]);
  const bfBalance=custOpeningBal + custSalesBefore.reduce((s,x)=>s+n(x.weight)*n(x.rate),0) - custReceiptsBefore.reduce((s,r)=>s+n(r.amount),0);

  // Sales & receipts IN the selected date range
  const custSalesInRange=useMemo(()=>allSales.filter(s=>s.customerId===selCustomer&&s.date>=custFromDate&&s.date<=custToDate).sort((a,b)=>a.date.localeCompare(b.date)),[allSales,selCustomer,custFromDate,custToDate]);
  const custReceiptsInRange=useMemo(()=>allReceipts.filter(r=>r.customerId===selCustomer&&r.date>=custFromDate&&r.date<=custToDate).sort((a,b)=>a.date.localeCompare(b.date)),[allReceipts,selCustomer,custFromDate,custToDate]);

  // Combined ledger rows (invoices + receipts) sorted by date
  const custLedgerRows=useMemo(()=>{
    const rows=[];
    custSalesInRange.forEach(s=>rows.push({type:"invoice",date:s.date,description:`Invoice · ${fmtKg(s.weight)} @ Rs.${fmt(s.rate)}/kg`,debit:n(s.weight)*n(s.rate),credit:0,collector:"",_s:s}));
    custReceiptsInRange.forEach(r=>rows.push({type:"receipt",date:r.date,description:`Receipt`,debit:0,credit:n(r.amount),collector:r.collector||"",_r:r}));
    return rows.sort((a,b)=>a.date.localeCompare(b.date)||( a.type==="invoice"?-1:1));
  },[custSalesInRange,custReceiptsInRange]);

  // Running balance starting from BF (or 0)
  const custLedgerWithBal=useMemo(()=>{
    let bal=custBF?bfBalance:custOpeningBal;
    return custLedgerRows.map(row=>{
      bal=bal+row.debit-row.credit;
      return{...row,runningBal:bal};
    });
  },[custLedgerRows,custBF,bfBalance,custOpeningBal]);

  const custSalesTotal=custSalesInRange.reduce((s,x)=>s+n(x.weight)*n(x.rate),0);
  const custReceiptsTotal=custReceiptsInRange.reduce((s,r)=>s+n(r.amount),0);
  // Net balance = opening balance + all sales ever - all receipts ever
  const custAllSalesTotal=allSales.filter(s=>s.customerId===selCustomer).reduce((s,x)=>s+n(x.weight)*n(x.rate),0);
  const custAllReceiptsTotal=allReceipts.filter(r=>r.customerId===selCustomer).reduce((s,r)=>s+n(r.amount),0);
  const custNetBalance=custOpeningBal+custAllSalesTotal-custAllReceiptsTotal;
  const custBalance=custNetBalance;

  // ── Supplier statement ──
  const supPurchases=useMemo(()=>allPurchases.filter(p=>p.supplierId===selSupplier).sort((a,b)=>a.date.localeCompare(b.date)),[allPurchases,selSupplier]);
  const supPayments=useMemo(()=>allSupplierPayments.filter(p=>p.supplierId===selSupplier).sort((a,b)=>a.date.localeCompare(b.date)),[allSupplierPayments,selSupplier]);
  const supPurchaseTotal=supPurchases.reduce((s,p)=>s+n(p.weight)*n(p.rate),0);
  const supPaidTotal=supPayments.reduce((s,p)=>s+n(p.amount),0);
  const supBalance=supPurchaseTotal-supPaidTotal;
  const supInfo=suppliers.find(s=>s.id===selSupplier);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div><h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>📋 Reports</h1><p style={{color:C.muted,fontSize:13}}>View and print business reports</p></div>
        <Btn color="ghost" onClick={()=>window.print()}>🖨 Print</Btn>
      </div>
      <div style={{display:"flex",gap:2,marginBottom:24,background:C.card,padding:4,borderRadius:10,border:`1px solid ${C.border}`,width:"fit-content"}} className="no-print">
        {TABS.map(t=>(<button key={t} onClick={()=>setTab(t)} style={{padding:"7px 18px",borderRadius:7,background:tab===t?C.amber:"transparent",color:tab===t?"#000":C.muted,border:"none",fontWeight:tab===t?700:500,fontSize:13}}>{TAB_LABELS[t]}</button>))}
      </div>

      {/* ── SALE REPORT ── */}
      {tab==="sales"&&(
        <>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 18px",marginBottom:20,display:"flex",gap:16,alignItems:"flex-end",flexWrap:"wrap"}} className="no-print">
            <Fld label="From Date" sx={{marginBottom:0,width:160}}><input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)}/></Fld>
            <Fld label="To Date" sx={{marginBottom:0,width:160}}><input type="date" value={toDate} onChange={e=>setToDate(e.target.value)}/></Fld>
            <Fld label="Filter by Customer (optional)" sx={{marginBottom:0,flex:1,minWidth:220,position:"relative"}}>
              <SearchPicker
                items={customers}
                value={salesCustFilter}
                onChange={setSalesCustFilter}
                placeholder="🔍  Search customer to filter…"
                renderItem={c=>`${c.name}${c.city?` · ${c.city}`:""}`}
                renderChip={c=><span>👤 <strong>{c.name}</strong>{c.city?<span style={{color:C.muted,fontWeight:400}}> · {c.city}</span>:""}</span>}
                emptyText="No customers found"
              />
            </Fld>
            {salesCustFilter&&<Btn color="ghost" small onClick={()=>setSalesCustFilter("")}>✕ Clear Filter</Btn>}
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,marginBottom:20}} className="print-card">
            <div style={{fontSize:18,fontWeight:800,marginBottom:2}}>📊 Sale Report</div>
            <div style={{color:C.muted,fontSize:13,marginBottom:16}}>
              {fromDate} → {toDate}
              {salesCustFilter&&custInfo&&<span style={{marginLeft:8,background:C.amberSoft,color:C.amber,padding:"2px 10px",borderRadius:10,fontSize:12,fontWeight:700}}>👤 {customers.find(c=>c.id===salesCustFilter)?.name}</span>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
              <StatBox label="Total Sales" value={salesInRange.length} color={C.amber}/>
              <StatBox label="Total Weight" value={fmtKg(salesWt)} color={C.blue}/>
              <StatBox label="Total Value" value={fmtRs(salesTotal)} color={C.green}/>
              <StatBox label="Pending" value={fmtRs(salesPending)} color={salesPending>0?C.red:C.muted}/>
            </div>
            {salesInRange.length===0?<Empty icon="📊" text="No sales in this date range"/>:(
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr><TH ch="Date"/><TH ch="Receipt #"/><TH ch="Customer"/><TH ch="Vehicle"/><TH ch="Weight" right/><TH ch="Rate" right/><TH ch="Amount" right/><TH ch="Collected" right/><TH ch="Pending" right/></tr></thead>
                  <tbody>
                    {salesInRange.map(s=>{const collected=(s.receipts||[]).reduce((a,r)=>a+n(r.amount),0);const pending=n(s.weight)*n(s.rate)-collected;
                      return(<tr key={s.id}><TD color={C.muted}>{s.date}</TD><TD color={C.amber} mono>{s.receiptNo}</TD><TD bold>{s.customerName}</TD><TD color={C.muted}>{s.vehicleNo}</TD><TD right mono>{fmtKg(s.weight)}</TD><TD right mono color={C.muted}>Rs.{fmt(s.rate)}</TD><TD right mono color={C.green} bold>{fmtRs(n(s.weight)*n(s.rate))}</TD><TD right mono color={C.green}>{fmtRs(collected)}</TD><TD right mono color={pending>0?C.red:C.muted}>{pending>0?fmtRs(pending):"—"}</TD></tr>);
                    })}
                    <tr><td colSpan={4} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>TOTAL</td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.blue,fontWeight:700}}>{fmtKg(salesWt)}</span></td><td style={{padding:"10px 12px",background:C.card2}}/><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(salesTotal)}</span></td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(salesCollected)}</span></td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.red,fontWeight:700}}>{fmtRs(salesPending)}</span></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── RECEIPTS REPORT ── */}
      {tab==="receipts"&&(
        <>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 18px",marginBottom:20,display:"flex",gap:16,alignItems:"flex-end",flexWrap:"wrap"}} className="no-print">
            <Fld label="From Date" sx={{marginBottom:0,width:160}}><input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)}/></Fld>
            <Fld label="To Date" sx={{marginBottom:0,width:160}}><input type="date" value={toDate} onChange={e=>setToDate(e.target.value)}/></Fld>
            <Fld label="Filter by Customer (optional)" sx={{marginBottom:0,flex:1,minWidth:220,position:"relative"}}>
              <SearchPicker
                items={customers}
                value={receiptsCustFilter}
                onChange={setReceiptsCustFilter}
                placeholder="🔍  Search customer to filter…"
                renderItem={c=>`${c.name}${c.city?` · ${c.city}`:""}`}
                renderChip={c=><span>👤 <strong>{c.name}</strong>{c.city?<span style={{color:C.muted,fontWeight:400}}> · {c.city}</span>:""}</span>}
                emptyText="No customers found"
              />
            </Fld>
            {receiptsCustFilter&&<Btn color="ghost" small onClick={()=>setReceiptsCustFilter("")}>✕ Clear Filter</Btn>}
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,marginBottom:20}} className="print-card">
            <div style={{fontSize:18,fontWeight:800,marginBottom:2}}>🧾 Receipts Report</div>
            <div style={{color:C.muted,fontSize:13,marginBottom:16}}>
              {fromDate} → {toDate}
              {receiptsCustFilter&&<span style={{marginLeft:8,background:C.amberSoft,color:C.amber,padding:"2px 10px",borderRadius:10,fontSize:12,fontWeight:700}}>👤 {customers.find(c=>c.id===receiptsCustFilter)?.name}</span>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:14,marginBottom:20}}>
              <StatBox label="Total Receipts" value={receiptsInRange.length} color={C.amber}/>
              <StatBox label="Total Collected" value={fmtRs(receiptsTotal)} color={C.green}/>
              <StatBox label="Unique Customers" value={new Set(receiptsInRange.map(r=>r.customerId)).size} color={C.blue}/>
            </div>
            {receiptsInRange.length===0?<Empty icon="🧾" text="No receipts in this date range"/>:(
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr><TH ch="Date"/><TH ch="Customer"/><TH ch="Invoice #"/><TH ch="Vehicle"/><TH ch="Method"/><TH ch="Collector"/><TH ch="Amount" right/></tr></thead>
                  <tbody>
                    {receiptsInRange.map((r,i)=>(<tr key={i}><TD color={C.muted}>{r.date}</TD><TD bold>{r.customerName}</TD><TD color={C.amber} mono>{r.receiptNo}</TD><TD color={C.muted}>{r.vehicleNo}</TD><TD><Tag color={C.blue}>{r.method||"Cash"}</Tag></TD><TD color={C.muted}>{r.collector||"—"}</TD><TD right mono color={C.green} bold>{fmtRs(r.amount)}</TD></tr>))}
                    <tr><td colSpan={6} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>TOTAL</td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(receiptsTotal)}</span></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── CUSTOMER STATEMENT ── */}
      {tab==="customer"&&(
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:20}} className="no-print">
            <Label>Search & Select Customer</Label>
            <SearchPicker
              items={customers}
              value={selCustomer}
              onChange={setSelCustomer}
              placeholder="🔍  Type customer name or city…"
              renderItem={c=>`${c.name}${c.city?` · ${c.city}`:""}${c.phone?` · ${c.phone}`:""}`}
              renderChip={c=>(
                <span style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:18}}>👤</span>
                  <span>
                    <span style={{fontWeight:800,fontSize:14}}>{c.name}</span>
                    {c.city&&<span style={{color:C.muted,fontWeight:400,fontSize:12,marginLeft:8}}>{c.city}</span>}
                    {c.phone&&<span style={{color:C.muted,fontWeight:400,fontSize:12,marginLeft:8}}>· {c.phone}</span>}
                  </span>
                </span>
              )}
              emptyText="No customers found"
            />
            {customers.length>0&&!selCustomer&&(
              <div style={{marginTop:10,fontSize:12,color:C.muted}}>{customers.length} customers available — type to search</div>
            )}
            {selCustomer&&(
              <div style={{marginTop:14,display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <Fld label="From Date" sx={{marginBottom:0,width:160}}><input type="date" value={custFromDate} onChange={e=>setCustFromDate(e.target.value)}/></Fld>
                <Fld label="To Date" sx={{marginBottom:0,width:160}}><input type="date" value={custToDate} onChange={e=>setCustToDate(e.target.value)}/></Fld>
                <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",userSelect:"none",marginTop:18}}>
                  <input type="checkbox" checked={custBF} onChange={e=>setCustBF(e.target.checked)}
                    style={{width:16,height:16,accentColor:C.amber,cursor:"pointer"}}/>
                  <span style={{fontSize:13,fontWeight:700,color:custBF?C.amber:C.muted}}>B/F (Brought Forward)</span>
                </label>
              </div>
            )}
          </div>
          {!selCustomer?<Empty icon="👤" text="Search and select a customer above to view their statement"/>:(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:24}} className="print-card">
              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,paddingBottom:16,borderBottom:`1px solid ${C.border}`}}>
                <div>
                  <div style={{fontSize:20,fontWeight:800,marginBottom:4}}>👤 {custInfo?.name}</div>
                  <div style={{color:C.muted,fontSize:13}}>{custInfo?.city||""} {custInfo?.phone?`· ${custInfo.phone}`:""}</div>
                  <div style={{fontSize:12,color:C.muted,marginTop:4}}>Statement: {custFromDate} → {custToDate}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:12,color:C.muted,marginBottom:4}}>NET BALANCE</div>
                  <div className="mono" style={{fontSize:28,fontWeight:800,color:custNetBalance>0?C.red:C.green}}>{fmtRs(Math.abs(custNetBalance))}</div>
                  <div style={{fontSize:12,color:C.muted}}>{custNetBalance>0?"Receivable":"Fully Paid"}</div>
                </div>
              </div>

              {/* Summary stat boxes */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
                {custInfo?.openingBalance>0&&<StatBox label="Opening Balance" value={fmtRs(custOpeningBal)} color={C.orange}/>}
                <StatBox label="Total Sales" value={fmtRs(custSalesTotal)} color={C.amber}/>
                <StatBox label="Total Received" value={fmtRs(custReceiptsTotal)} color={C.green}/>
                <StatBox label="Net Balance" value={fmtRs(custNetBalance)} color={custNetBalance>0?C.red:C.green}/>
              </div>

              {/* Combined Ledger */}
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:20}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:C.card3}}>
                      <TH ch="Date"/>
                      <TH ch="Description"/>
                      <TH ch="Collector"/>
                      <TH ch="Invoice (Dr)" right/>
                      <TH ch="Receipt (Cr)" right/>
                      <TH ch="Balance" right/>
                    </tr>
                  </thead>
                  <tbody>
                    {/* B/F row */}
                    {custBF&&(
                      <tr style={{background:C.orangeSoft}}>
                        <TD color={C.orange} bold>{custFromDate}</TD>
                        <TD color={C.orange} bold>Including B/F {custInfo?.openingBalance>0?`(Opening: ${fmtRs(custOpeningBal)})`:""}</TD>
                        <TD color={C.muted}>—</TD>
                        <TD right mono color={C.muted}>—</TD>
                        <TD right mono color={C.muted}>—</TD>
                        <TD right mono bold color={bfBalance>0?C.red:bfBalance<0?C.green:C.muted}>{fmtRs(Math.abs(bfBalance))}{bfBalance>0?" Dr":bfBalance<0?" Cr":""}</TD>
                      </tr>
                    )}
                    {!custBF&&custOpeningBal>0&&(
                      <tr style={{background:C.orangeSoft}}>
                        <TD color={C.orange} bold>—</TD>
                        <TD color={C.orange} bold>Opening Balance</TD>
                        <TD color={C.muted}>—</TD>
                        <TD right mono color={C.orange} bold>{fmtRs(custOpeningBal)}</TD>
                        <TD right mono color={C.muted}>—</TD>
                        <TD right mono bold color={C.orange}>{fmtRs(custOpeningBal)} Dr</TD>
                      </tr>
                    )}
                    {/* Ledger rows */}
                    {custLedgerWithBal.length===0?(
                      <tr><td colSpan={6} style={{padding:"20px",textAlign:"center",color:C.muted,fontSize:13}}>No transactions in this date range</td></tr>
                    ):custLedgerWithBal.map((row,i)=>(
                      <tr key={i} style={{background:row.type==="receipt"?C.greenSoft:"transparent"}}>
                        <TD color={C.muted}>{row.date}</TD>
                        <TD bold={row.type==="invoice"} color={row.type==="invoice"?C.text:C.green}>{row.description}</TD>
                        <TD color={C.muted}>{row.collector||"—"}</TD>
                        <TD right mono color={row.type==="invoice"?C.amber:C.muted}>{row.debit>0?fmtRs(row.debit):"—"}</TD>
                        <TD right mono color={row.type==="receipt"?C.green:C.muted}>{row.credit>0?fmtRs(row.credit):"—"}</TD>
                        <TD right mono bold color={row.runningBal>0?C.red:row.runningBal<0?C.green:C.muted}>{fmtRs(Math.abs(row.runningBal))}{row.runningBal>0?" Dr":row.runningBal<0?" Cr":""}</TD>
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr style={{background:C.card2}}>
                      <td colSpan={3} style={{padding:"10px 12px",fontWeight:700,fontSize:12,color:C.muted}}>PERIOD TOTALS</td>
                      <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:C.amber,fontWeight:700}}>{fmtRs(custSalesTotal)}</span></td>
                      <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(custReceiptsTotal)}</span></td>
                      <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:custNetBalance>0?C.red:C.green,fontWeight:700}}>{fmtRs(Math.abs(custNetBalance))}{custNetBalance>0?" Dr":custNetBalance<0?" Cr":""}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Net Balance footer */}
              <div style={{background:custNetBalance>0?C.redSoft:C.greenSoft,border:`1px solid ${custNetBalance>0?C.red:C.green}33`,borderRadius:10,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div style={{fontWeight:700,fontSize:14,color:custNetBalance>0?C.red:C.green}}>NET BALANCE (Overall)</div>
                <div style={{display:"flex",alignItems:"center",gap:16}}>
                  {custOpeningBal>0&&<span style={{fontSize:12,color:C.orange}}>Opening: {fmtRs(custOpeningBal)}</span>}
                  <span className="mono" style={{fontSize:22,fontWeight:800,color:custNetBalance>0?C.red:C.green}}>{fmtRs(Math.abs(custNetBalance))}</span>
                  <span style={{fontSize:12,color:custNetBalance>0?C.red:C.green,fontWeight:700}}>{custNetBalance>0?"RECEIVABLE":"FULLY PAID"}</span>
                  <button onClick={()=>{const msg=`*ChickenFlow Statement*\nCustomer: ${custInfo?.name}\nDate: ${today()}\nBalance Due: Rs.${Math.round(Math.abs(custNetBalance)).toLocaleString()}\n${custNetBalance>0?"Amount Receivable":"Account Clear"}\n\nSent via ChickenFlow`;window.open("https://wa.me/?text="+encodeURIComponent(msg),"_blank");}} style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>📲 WhatsApp</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SUPPLIER STATEMENT ── */}
      {tab==="supplier"&&(
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:20}} className="no-print">
            <Label>Search & Select Supplier</Label>
            <SearchPicker
              items={suppliers}
              value={selSupplier}
              onChange={setSelSupplier}
              placeholder="🔍  Type supplier name or city…"
              renderItem={s=>`${s.name}${s.city?` · ${s.city}`:""}${s.region?` · ${s.region}`:""}`}
              renderChip={s=>(
                <span style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:18}}>🏭</span>
                  <span>
                    <span style={{fontWeight:800,fontSize:14}}>{s.name}</span>
                    {s.city&&<span style={{color:C.muted,fontWeight:400,fontSize:12,marginLeft:8}}>{s.city}</span>}
                    {s.region&&<span style={{color:C.muted,fontWeight:400,fontSize:12,marginLeft:8}}>· {s.region}</span>}
                  </span>
                </span>
              )}
              emptyText="No suppliers found"
            />
            {suppliers.length>0&&!selSupplier&&(
              <div style={{marginTop:10,fontSize:12,color:C.muted}}>{suppliers.length} suppliers available — type to search</div>
            )}
          </div>
          {!selSupplier?<Empty icon="🏭" text="Search and select a supplier above to view their statement"/>:(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:24}} className="print-card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,paddingBottom:16,borderBottom:`1px solid ${C.border}`}}>
                <div><div style={{fontSize:20,fontWeight:800,marginBottom:4}}>🏭 {supInfo?.name}</div><div style={{color:C.muted,fontSize:13}}>{supInfo?.city||""} · {supInfo?.region||""}</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:12,color:C.muted,marginBottom:4}}>NET BALANCE</div><div className="mono" style={{fontSize:28,fontWeight:800,color:supBalance>0?C.red:C.green}}>{fmtRs(Math.abs(supBalance))}</div><div style={{fontSize:12,color:C.muted}}>{supBalance>0?"Payable":"Fully Paid"}</div></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:14,marginBottom:20}}>
                <StatBox label="Total Purchases" value={fmtRs(supPurchaseTotal)} color={C.amber}/>
                <StatBox label="Total Paid" value={fmtRs(supPaidTotal)} color={C.green}/>
                <StatBox label="Balance Due" value={fmtRs(supBalance)} color={supBalance>0?C.red:C.green}/>
              </div>
              <div style={{fontSize:14,fontWeight:700,marginBottom:10,color:C.muted}}>PURCHASE HISTORY</div>
              {supPurchases.length===0?<div style={{color:C.muted,fontSize:13,marginBottom:16}}>No purchases</div>:(
                <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:20}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr><TH ch="Date"/><TH ch="Vehicle"/><TH ch="Weight" right/><TH ch="Rate" right/><TH ch="Amount" right/><TH ch="Paid" right/><TH ch="Balance" right/></tr></thead>
                    <tbody>{supPurchases.map(p=>{const paid=(p.payments||[]).reduce((s,r)=>s+n(r.amount),0);const bal=n(p.weight)*n(p.rate)-paid;return(<tr key={p.id}><TD color={C.muted}>{p.date}</TD><TD color={C.muted}>{p.vehicleNo}</TD><TD right mono>{fmtKg(p.weight)}</TD><TD right mono color={C.muted}>Rs.{fmt(p.rate)}</TD><TD right mono color={C.amber} bold>{fmtRs(n(p.weight)*n(p.rate))}</TD><TD right mono color={C.green}>{fmtRs(paid)}</TD><TD right mono color={bal>0?C.red:C.muted} bold>{bal>0?fmtRs(bal):"✓"}</TD></tr>);})}</tbody>
                  </table>
                </div>
              )}
              <div style={{fontSize:14,fontWeight:700,marginBottom:10,color:C.muted}}>PAYMENT HISTORY</div>
              {supPayments.length===0?<div style={{color:C.muted,fontSize:13}}>No payments recorded</div>:(
                <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr><TH ch="Date"/><TH ch="Vehicle"/><TH ch="Method"/><TH ch="Note"/><TH ch="Amount" right/></tr></thead>
                    <tbody>{supPayments.map((p,i)=>(<tr key={i}><TD color={C.muted}>{p.date}</TD><TD color={C.muted}>{p.vehicleNo}</TD><TD><Tag color={C.amber}>{p.method||"Cash"}</Tag></TD><TD color={C.muted}>{p.note||"—"}</TD><TD right mono color={C.green} bold>{fmtRs(p.amount)}</TD></tr>))}<tr><td colSpan={4} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>TOTAL PAID</td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(supPaidTotal)}</span></td></tr></tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab==="receivables"&&(()=>{
        const map={};
        vehicles.forEach(v=>v.sales.filter(s=>!s.deletedAt).forEach(sale=>{
          const col=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
          const bal=sale.totalAmount-col;
          if(bal<0.01)return;
          if(!map[sale.customerId])map[sale.customerId]={id:sale.customerId,name:sale.customerName,due:0,oldest:sale.date,count:0};
          map[sale.customerId].due+=bal;map[sale.customerId].count+=1;
          if(sale.date<map[sale.customerId].oldest)map[sale.customerId].oldest=sale.date;
        }));
        const rows=Object.values(map).sort((a,b)=>b.due-a.due);
        const totalDue=rows.reduce((s,r)=>s+r.due,0);
        const daysDiff=d=>Math.round((new Date()-new Date(d))/(864e5));
        return(<div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:14,marginBottom:20}}>
            <StatBox label="Customers with Balance" value={rows.length} color={C.amber}/>
            <StatBox label="Total Receivable" value={fmtRs(totalDue)} color={C.red}/>
          </div>
          {rows.length===0?<Empty icon="🎉" text="All customers are fully paid!"/>:(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr><TH ch="#"/><TH ch="Customer"/><TH ch="Invoices"/><TH ch="Total Due" right/><TH ch="Oldest Invoice"/><TH ch="Days Outstanding" right/></tr></thead>
                <tbody>{rows.map((r,i)=>{
                  const days=daysDiff(r.oldest);
                  const dc=days>60?C.red:days>30?C.orange:days>15?C.amber:C.green;
                  return(<tr key={r.id}><TD color={C.muted} small>{i+1}</TD><TD bold>{r.name}</TD><TD color={C.muted}>{r.count}</TD><TD right mono color={C.red} bold>{fmtRs(r.due)}</TD><TD color={C.muted}>{r.oldest}</TD><TD right mono color={dc} bold>{days}d</TD></tr>);
                })}</tbody>
              </table>
            </div>
          )}
        </div>);
      })()}

      {tab==="sup_due"&&(()=>{
        const map={};
        vehicles.forEach(v=>v.purchases.filter(p=>!p.deletedAt).forEach(p=>{
          const paid=(p.payments||[]).reduce((s,r)=>s+n(r.amount),0);
          const bal=n(p.weight)*n(p.rate)-paid;
          if(bal<0.01)return;
          if(!map[p.supplierId])map[p.supplierId]={id:p.supplierId,name:p.supplierName,owed:0,count:0};
          map[p.supplierId].owed+=bal;map[p.supplierId].count+=1;
        }));
        const rows=Object.values(map).sort((a,b)=>b.owed-a.owed);
        const total=rows.reduce((s,r)=>s+r.owed,0);
        return(<div>
          <StatBox label="Total Payable to Suppliers" value={fmtRs(total)} color={C.red}/>
          <div style={{marginTop:16,background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Supplier"/><TH ch="Unpaid Purchases"/><TH ch="Total Owed" right/></tr></thead>
              <tbody>{rows.length===0?<tr><td colSpan={3} style={{padding:20,textAlign:"center",color:C.muted,fontSize:13}}>All suppliers fully paid</td></tr>:rows.map(r=><tr key={r.id}><TD bold>{r.name}</TD><TD color={C.muted}>{r.count}</TD><TD right mono color={C.red} bold>{fmtRs(r.owed)}</TD></tr>)}</tbody>
            </table>
          </div>
        </div>);
      })()}

      {tab==="pnl"&&(()=>{
        const rows=vehicles.filter(v=>(!fromDate||v.date>=fromDate)&&(!toDate||v.date<=toDate)).map(v=>{
          const c=calcVehicle(v,transactions);
          return{id:v.id,no:v.vehicleNo,date:v.date,status:v.status,rev:c.totalSaleValue,cost:c.totalCost,pnl:c.pnl};
        });
        const totRev=rows.reduce((s,r)=>s+r.rev,0);
        const totCost=rows.reduce((s,r)=>s+r.cost,0);
        const totPnl=rows.reduce((s,r)=>s+r.pnl,0);
        return(<div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:14,marginBottom:20}}>
            <StatBox label="Total Revenue" value={fmtRs(totRev)} color={C.green}/>
            <StatBox label="Total Cost" value={fmtRs(totCost)} color={C.red}/>
            <StatBox label="Net Profit/Loss" value={fmtRs(Math.abs(totPnl))} color={totPnl>=0?C.green:C.red} sub={totPnl>=0?"Profit":"Loss"}/>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Vehicle"/><TH ch="Date"/><TH ch="Status"/><TH ch="Revenue" right/><TH ch="Total Cost" right/><TH ch="P&L" right/></tr></thead>
              <tbody>
                {rows.map(r=><tr key={r.id}><TD bold>{r.no}</TD><TD color={C.muted}>{r.date}</TD><TD><Tag color={r.status==="active"?C.green:C.muted}>{r.status}</Tag></TD><TD right mono color={C.green}>{fmtRs(r.rev)}</TD><TD right mono color={C.red}>{fmtRs(r.cost)}</TD><TD right mono bold color={r.pnl>=0?C.green:C.red}>{r.pnl>=0?"+":"-"}{fmtRs(Math.abs(r.pnl))}</TD></tr>)}
                <tr style={{background:C.card2}}><td colSpan={3} style={{padding:"10px 12px",fontWeight:700,color:C.muted,fontSize:12}}>TOTAL ({rows.length} vehicles)</td><td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(totRev)}</span></td><td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:C.red,fontWeight:700}}>{fmtRs(totCost)}</span></td><td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{color:totPnl>=0?C.green:C.red,fontWeight:800,fontSize:16}}>{totPnl>=0?"+":"-"}{fmtRs(Math.abs(totPnl))}</span></td></tr>
              </tbody>
            </table>
          </div>
        </div>);
      })()}

      {tab==="aging"&&(()=>{
        const buckets={"0–15 days":[],"16–30 days":[],"31–60 days":[],"60+ days":[]};
        const now=new Date();
        vehicles.forEach(v=>v.sales.filter(s=>!s.deletedAt).forEach(sale=>{
          const col=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
          const bal=sale.totalAmount-col;
          if(bal<0.01)return;
          const days=Math.round((now-new Date(sale.date))/864e5);
          const key=days<=15?"0–15 days":days<=30?"16–30 days":days<=60?"31–60 days":"60+ days";
          buckets[key].push({...sale,bal,days,vehicleNo:v.vehicleNo});
        }));
        const BCOLORS={"0–15 days":C.green,"16–30 days":C.amber,"31–60 days":C.orange,"60+ days":C.red};
        return(<div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:16}}>
            {Object.entries(buckets).map(([bucket,items])=>(
              <div key={bucket} style={{background:C.card,border:`2px solid ${BCOLORS[bucket]}44`,borderRadius:12,padding:16}}>
                <div style={{fontWeight:700,color:BCOLORS[bucket],marginBottom:4}}>{bucket}</div>
                <div className="mono" style={{fontSize:18,fontWeight:800,color:BCOLORS[bucket],marginBottom:12}}>{fmtRs(items.reduce((s,x)=>s+x.bal,0))}</div>
                {items.length===0?<div style={{color:C.muted,fontSize:12}}>No outstanding invoices</div>:items.slice(0,8).map(x=>(
                  <div key={x.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:`1px solid ${C.border}22`}}>
                    <span style={{color:C.muted}}>{x.customerName}</span>
                    <span className="mono" style={{color:BCOLORS[bucket],fontWeight:700}}>{fmtRs(x.bal)}</span>
                  </div>
                ))}
                {items.length>8&&<div style={{fontSize:11,color:C.muted,marginTop:6}}>+{items.length-8} more…</div>}
              </div>
            ))}
          </div>
        </div>);
      })()}

    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({vehicles,transactions,onOpen,onNew}){
  const [projSearch,setProjSearch]=useState("");
  const [projStatus,setProjStatus]=useState("all");
  const filteredVehicles=useMemo(()=>vehicles.filter(v=>{
    const q=projSearch.toLowerCase();
    const matchQ=!q||(v.vehicleNo||"").toLowerCase().includes(q)||(v.driverName||"").toLowerCase().includes(q)||(v.date||"").includes(q);
    const matchS=projStatus==="all"||v.status===projStatus;
    return matchQ&&matchS;
  }),[vehicles,projSearch,projStatus]);
  const active=vehicles.filter(v=>v.status==="active");
  const totalPnl=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).pnl,0);
  const totalRev=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).totalSaleValue,0);
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,marginBottom:2}}>Vehicle Projects</h1>
          <p style={{color:C.muted,fontSize:13}}>{active.length} active · {vehicles.length} total</p>
        </div>
        <Btn onClick={onNew} sx={{fontSize:13,padding:"10px 16px",minHeight:44}}>+ New</Btn>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <input value={projSearch} onChange={e=>setProjSearch(e.target.value)} placeholder="🔍 Search vehicle / driver…" style={{flex:1,minWidth:0,padding:"9px 12px",borderRadius:10,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:16}}/>
        {["all","active","closed"].map(s=><button key={s} onClick={()=>setProjStatus(s)} style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,background:projStatus===s?C.amberSoft:"transparent",color:projStatus===s?C.amber:C.muted,border:projStatus===s?`1px solid ${C.amber}44`:"1px solid transparent",cursor:"pointer"}}>{s==="all"?"All Vehicles":s==="active"?"Active":"Closed"}</button>)}
        {(projSearch||projStatus!=="all")&&<button onClick={()=>{setProjSearch("");setProjStatus("all");}} style={{padding:"5px 10px",borderRadius:8,fontSize:11,background:C.card2,color:C.muted,border:`1px solid ${C.border}`,cursor:"pointer"}}>✕ Clear</button>}
      </div>
      {vehicles.length>0&&(
        <div className="stat-grid" style={{marginBottom:16}}>
          <StatBox label="Active" value={active.length} color={C.amber}/>
          <StatBox label="Sale Value" value={fmtRs(totalRev)} color={C.green}/>
          <StatBox label="P&L" value={fmtRs(Math.abs(totalPnl))} color={totalPnl>=0?C.green:C.red} sub={totalPnl>=0?"Profit":"Loss"}/>
        </div>
      )}
      {filteredVehicles.length===0&&vehicles.length>0?<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"40px 20px",textAlign:"center",color:C.muted}}>No vehicles match your search.</div>:filteredVehicles.length===0?(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,textAlign:"center",padding:"80px 20px"}}>
          <div style={{fontSize:48,marginBottom:14}}>🚛</div>
          <div style={{fontSize:18,fontWeight:700,marginBottom:8}}>No vehicles yet</div>
          <div style={{color:C.muted,marginBottom:22}}>Create a vehicle project when a new delivery arrives</div>
          <Btn onClick={onNew}>+ Create First Vehicle</Btn>
        </div>
      ):(
        <div className="card-grid">
          {vehicles.map(v=>{
            const c=calcVehicle(v,transactions);
            return(
              <div key={v.id} onClick={()=>onOpen(v.id)}
                style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:16,cursor:"pointer",transition:"border-color 0.15s",WebkitTapHighlightColor:"transparent"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=C.amber;e.currentTarget.style.transform="translateY(-2px)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.transform="none";}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                  <div><div style={{fontSize:17,fontWeight:800,marginBottom:3}}>🚛 {v.vehicleNo||"—"}</div>
                    <div style={{fontSize:12,color:C.muted}}>{v.date} {v.time?`· ${v.time}`:""} · {v.driverName||"No driver"}</div></div>
                  <Tag color={v.status==="active"?C.green:C.muted}>{v.status}</Tag>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                  <StatBox label="Received" value={fmtKg(c.received)} color={C.blue}/>
                  <StatBox label="Remaining" value={fmtKg(c.remaining)} color={c.remaining>0?C.amber:C.muted}/>
                  <StatBox label="Sale Value" value={fmtRs(c.totalSaleValue)} color={C.green}/>
                  <StatBox label="P&L" value={fmtRs(Math.abs(c.pnl))} color={c.pnl>=0?C.green:C.red} sub={c.pnl>=0?"Profit":"Loss"}/>
                </div>
                {c.linkedExpenses>0&&<div style={{fontSize:12,color:C.teal,marginBottom:6}}>+ {fmtRs(c.linkedExpenses)} linked expenses/salaries</div>}
                <div style={{fontSize:12,color:C.muted}}>{v.purchases.length} purchases · {v.sales.length} sales</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── VEHICLE DETAIL ───────────────────────────────────────────────────────────
function VehicleDetail({vehicle,setVehicles,suppliers,customers,accounts,labourers,addTxn,expenseCategories,transactions,onBack}){
  const [tab,setTab]=useState("overview");
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [selId,setSelId]=useState(null);
  const [batchDate,setBatchDate]=useState(today());
  const [batchDriver,setBatchDriver]=useState("");
  const [batchDriverName,setBatchDriverName]=useState("");
  const [batchItems,setBatchItems]=useState([]);
  const [batchSearch,setBatchSearch]=useState("");
  const [batchCustSearch,setBatchCustSearch]=useState("");
  const [importSalesPreview,setImportSalesPreview]=useState([]);
  const [importSalesError,setImportSalesError]=useState("");
  const [importReceiptsPreview,setImportReceiptsPreview]=useState([]);
  const [importReceiptsError,setImportReceiptsError]=useState("");
  const importSalesRef=useRef();
  const importReceiptsRef=useRef();

  const c=calcVehicle(vehicle,transactions);
  const fv=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const openModal=(name,def={})=>{setModal(name);setForm({date:today(),time:nowTime(),...def});};
  const closeModal=()=>{setModal(null);setForm({});};
  const mut=fn=>setVehicles(vs=>vs.map(v=>v.id===vehicle.id?fn(v):v));

  const openBatchSale=()=>{setBatchDate(today());setBatchDriver("");setBatchDriverName("");setBatchItems([]);setBatchSearch("");setBatchCustSearch("");setModal("batchSale");};

  const availableForBatch=useMemo(()=>customers.filter(cu=>!batchItems.find(b=>b.customerId===cu.id)&&cu.name.toLowerCase().includes(batchCustSearch.toLowerCase())),[customers,batchItems,batchCustSearch]);
  const addToBatch=(cu)=>{setBatchItems(p=>[...p,{customerId:cu.id,name:cu.name,city:cu.city||"",rate:cu.defaultRate||"",weight:""}]);setBatchCustSearch("");};
  const removeFromBatch=(id)=>setBatchItems(p=>p.filter(r=>r.customerId!==id));
  const updBatch=(id,field,val)=>setBatchItems(p=>p.map(r=>r.customerId===id?{...r,[field]:val}:r));
  const batchValid=batchItems.filter(r=>n(r.weight)>0&&n(r.rate)>0);
  const batchTotalWt=batchItems.reduce((s,r)=>s+n(r.weight),0);
  const batchTotalAmt=batchItems.reduce((s,r)=>s+n(r.weight)*n(r.rate),0);
  const batchFiltered=useMemo(()=>batchItems.filter(r=>r.name.toLowerCase().includes(batchSearch.toLowerCase())||r.city.toLowerCase().includes(batchSearch.toLowerCase())),[batchItems,batchSearch]);

  const confirmBatchSale=()=>{
    if(!batchValid.length) return alert("Enter weight for at least one customer");
    if(batchTotalWt>c.remaining) return alert(`Total weight exceeds remaining stock`);
    const driver=batchDriver?labourers.find(l=>l.id===batchDriver)?.name||batchDriverName:batchDriverName;
    const newSales=batchValid.map(r=>({id:genId(),customerId:r.customerId,customerName:r.name,date:batchDate,weight:n(r.weight),rate:n(r.rate),totalAmount:n(r.weight)*n(r.rate),receiptNo:`RCP-${genId()}`,notes:`Batch entry${driver?` · Driver: ${driver}`:""}`,driver,receipts:[]}));
    mut(v=>({...v,sales:[...v.sales,...newSales]}));
    closeModal();
  };

  // ── IMPORT SALES ──
  const handleImportSalesFile=async e=>{
    const file=e.target.files[0];if(!file)return;
    setImportSalesError("");setImportSalesPreview([]);
    try{
      const XLSX=await loadXLSX();
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(buf,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      const parsed=rows.map((r,i)=>{
        const custName=(r["CustomerName"]||r["Customer"]||r["customer_name"]||r["customer"]||"").toString().trim();
        const date=(r["Date"]||r["date"]||today()).toString().trim()||today();
        const weight=n(r["Weight"]||r["weight"]||r["Kg"]||r["kg"]||0);
        const rateVal=n(r["Rate"]||r["rate"]||r["Price"]||r["price"]||0);
        const notes=(r["Notes"]||r["notes"]||r["Note"]||r["note"]||"").toString().trim();
        const cu=customers.find(cc=>cc.name.toLowerCase()===custName.toLowerCase());
        return{_row:i+2,custName,date,weight,rate:rateVal||(cu?.defaultRate||0),notes,customerId:cu?.id||null,customerFound:!!cu};
      }).filter(r=>r.custName||r.weight>0);
      if(!parsed.length) return setImportSalesError("No valid rows found. Check column headers: CustomerName, Date, Weight, Rate");
      setImportSalesPreview(parsed);
    }catch(err){setImportSalesError("Failed to read file: "+err.message);}
    e.target.value="";
  };
  const confirmImportSales=()=>{
    const valid=importSalesPreview.filter(r=>r.customerId&&r.weight>0&&r.rate>0);
    if(!valid.length) return alert("No valid rows to import (check customer names match exactly)");
    const totalWt=valid.reduce((s,r)=>s+n(r.weight),0);
    if(totalWt>c.remaining) return alert(`Total import weight (${fmtKg(totalWt)}) exceeds remaining stock (${fmtKg(c.remaining)})`);
    const newSales=valid.map(r=>({id:genId(),customerId:r.customerId,customerName:r.custName,date:r.date,weight:n(r.weight),rate:n(r.rate),totalAmount:n(r.weight)*n(r.rate),receiptNo:`RCP-${genId()}`,notes:r.notes||"Imported",receipts:[]}));
    mut(v=>({...v,sales:[...v.sales,...newSales]}));
    setImportSalesPreview([]);setImportSalesError("");
    closeModal();
    alert(`\u2705 ${newSales.length} sales imported successfully!`);
  };
  const downloadSalesTemplate=async()=>{
    const XLSX=await loadXLSX();
    const ws=XLSX.utils.aoa_to_sheet([["CustomerName","Date","Weight","Rate","Notes"],["Ali Chicken Shop","2025-01-15","500","420","Sample sale"]]);
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Sales");XLSX.writeFile(wb,"sales_import_template.xlsx");
  };

  // ── IMPORT RECEIPTS ──
  const handleImportReceiptsFile=async e=>{
    const file=e.target.files[0];if(!file)return;
    setImportReceiptsError("");setImportReceiptsPreview([]);
    try{
      const XLSX=await loadXLSX();
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(buf,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      const parsed=rows.map((r,i)=>{
        const receiptNo=(r["ReceiptNo"]||r["Receipt No"]||r["receipt_no"]||"").toString().trim();
        const custName=(r["CustomerName"]||r["Customer"]||r["customer"]||"").toString().trim();
        const date=(r["Date"]||r["date"]||today()).toString().trim()||today();
        const amount=n(r["Amount"]||r["amount"]||0);
        const method=(r["Method"]||r["method"]||r["PaymentMethod"]||"Cash").toString().trim()||"Cash";
        const note=(r["Note"]||r["note"]||r["Notes"]||"").toString().trim();
        let matchedSale=null;
        if(receiptNo) matchedSale=vehicle.sales.find(s=>s.receiptNo===receiptNo);
        if(!matchedSale&&custName){
          const custSales=vehicle.sales.filter(s=>s.customerName.toLowerCase()===custName.toLowerCase());
          matchedSale=custSales.reduce((best,s)=>{
            const bal=s.totalAmount-(s.receipts||[]).reduce((a,rr)=>a+n(rr.amount),0);
            const bestBal=best?best.totalAmount-(best.receipts||[]).reduce((a,rr)=>a+n(rr.amount),0):0;
            return bal>bestBal?s:best;
          },null);
        }
        const saleBalance=matchedSale?matchedSale.totalAmount-(matchedSale.receipts||[]).reduce((a,rr)=>a+n(rr.amount),0):0;
        return{_row:i+2,receiptNo,custName,date,amount,method,note,matchedSale,saleBalance,saleFound:!!matchedSale};
      }).filter(r=>r.amount>0);
      if(!parsed.length) return setImportReceiptsError("No valid rows found. Check columns: ReceiptNo (or CustomerName), Date, Amount, Method");
      setImportReceiptsPreview(parsed);
    }catch(err){setImportReceiptsError("Failed to read file: "+err.message);}
    e.target.value="";
  };
  const [importReceiptsAccountId,setImportReceiptsAccountId]=useState("");
  const confirmImportReceipts=()=>{
    if(!importReceiptsAccountId) return alert("Select an account to deposit into");
    const acct=accounts.find(a=>a.id===importReceiptsAccountId);
    const valid=importReceiptsPreview.filter(r=>r.matchedSale&&r.amount>0);
    if(!valid.length) return alert("No valid rows to import");
    valid.forEach(r=>{
      const receipt={id:genId(),amount:n(r.amount),date:r.date,method:r.method||"Cash",accountId:importReceiptsAccountId,accountName:acct?.name||"",note:r.note||"Imported"};
      mut(v=>({...v,sales:v.sales.map(s=>s.id===r.matchedSale.id?{...s,receipts:[...(s.receipts||[]),receipt]}:s)}));
      addTxn({date:r.date,type:"receipt",amount:n(r.amount),debitAccountId:importReceiptsAccountId,creditAccountId:null,description:`Receipt \u2014 ${r.matchedSale.customerName} (${r.matchedSale.receiptNo} \u00b7 ${vehicle.vehicleNo})`,note:r.note||"Imported"});
    });
    setImportReceiptsPreview([]);setImportReceiptsError("");setImportReceiptsAccountId("");
    closeModal();
    alert(`\u2705 ${valid.length} receipts imported successfully!`);
  };
  const downloadReceiptsTemplate=async()=>{
    const XLSX=await loadXLSX();
    const ws=XLSX.utils.aoa_to_sheet([["ReceiptNo","CustomerName","Date","Amount","Method","Note"],["RCP-ABC123","Ali Chicken Shop","2025-01-20","50000","Cash","Partial payment"]]);
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Receipts");XLSX.writeFile(wb,"receipts_import_template.xlsx");
  };

  const addPurchase=()=>{
    if(!form.supplierId) return alert("Select a supplier");if(!form.weight) return alert("Enter weight");
    const sup=suppliers.find(s=>s.id===form.supplierId);
    mut(v=>({...v,purchases:[...v.purchases,{id:genId(),supplierId:form.supplierId,supplierName:sup?.name||"",date:form.date,time:form.time,weight:n(form.weight),rate:n(form.rate),transitLoss:n(form.transitLoss),notes:form.notes||"",payments:[]}]}));
    closeModal();
  };
  const addSupplierPayment=purchaseId=>{
    if(!form.amount) return alert("Enter amount");
    const pur=vehicle.purchases.find(p=>p.id===purchaseId);
    mut(v=>({...v,purchases:v.purchases.map(p=>p.id===purchaseId?{...p,payments:[...p.payments,{id:genId(),amount:n(form.amount),date:form.date,method:form.method||"Cash",note:form.note||""}]}:p)}));
    if(form.accountId) addTxn({date:form.date,type:"supplier_pay",amount:n(form.amount),creditAccountId:form.accountId,debitAccountId:null,description:`Supplier Payment — ${pur?.supplierName} (${vehicle.vehicleNo})`,note:form.note||""});
    closeModal();
  };
  const addSale=()=>{
    if(!form.customerId) return alert("Select a customer");if(!form.weight) return alert("Enter weight");
    const cu=customers.find(c=>c.id===form.customerId);const wt=n(form.weight),rate=n(form.rate);
    mut(v=>({...v,sales:[...v.sales,{id:genId(),customerId:form.customerId,customerName:cu?.name||"",date:form.date,weight:wt,rate,totalAmount:wt*rate,receiptNo:`RCP-${genId()}`,notes:form.notes||"",receipts:[]}]}));
    closeModal();
  };
  const addReceipt=saleId=>{
    if(!form.amount) return alert("Enter amount");
    const sale=vehicle.sales.find(s=>s.id===saleId);
    const acct=accounts.find(a=>a.id===form.accountId);
    mut(v=>({...v,sales:v.sales.map(s=>s.id===saleId?{...s,receipts:[...(s.receipts||[]),{id:genId(),amount:n(form.amount),date:form.date,method:form.method||"Cash",accountId:form.accountId,accountName:acct?.name||"",note:form.note||""}]}:s)}));
    if(form.accountId) addTxn({date:form.date,type:"receipt",amount:n(form.amount),debitAccountId:form.accountId,creditAccountId:null,description:`Receipt — ${sale?.customerName} (${sale?.receiptNo} · ${vehicle.vehicleNo})`,note:form.note||""});
    closeModal();
  };
  const addTransfer=()=>{
    if(!form.weight) return alert("Enter weight");
    mut(v=>({...v,transfers:[...v.transfers,{id:genId(),weight:n(form.weight),date:form.date,note:form.note||""}]}));
    closeModal();
  };
  const addExpense=()=>{
    if(!form.description||!form.amount) return alert("Fill required fields");
    const acct=accounts.find(a=>a.id===form.accountId);
    mut(v=>({...v,expenses:[...v.expenses,{id:genId(),description:form.description,amount:n(form.amount),date:form.date,type:form.type||"Transit",accountId:form.accountId,accountName:acct?.name||"",note:form.note||""}]}));
    if(form.accountId) addTxn({date:form.date,type:"vehicle_exp",amount:n(form.amount),creditAccountId:form.accountId,debitAccountId:null,description:`${form.description} [${form.type||"Transit"}] — ${vehicle.vehicleNo}`,note:form.note||"",linkedVehicleId:vehicle.id,linkedVehicleNo:vehicle.vehicleNo});
    closeModal();
  };

  // Linked expenses and salaries from transactions
  const linkedTxns = useMemo(()=>transactions.filter(t=>t.linkedVehicleId===vehicle.id&&(t.type==="general_exp"||t.type==="salary"||t.type==="advance")),[transactions,vehicle.id]);

  const TABS=["overview","purchases","sales","transfers","expenses","p&l"];

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <Btn color="ghost" onClick={onBack}>← Back</Btn>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:2}}>
            <span style={{fontSize:20,fontWeight:800}}>🚛 {vehicle.vehicleNo||"Vehicle"}</span>
            <Tag color={vehicle.status==="active"?C.green:C.muted}>{vehicle.status}</Tag>
          </div>
          <span style={{fontSize:12,color:C.muted}}>{vehicle.date} {vehicle.time?`· ${vehicle.time}`:""} · Driver: {vehicle.driverName||"—"} · {vehicle.origin||"Punjab"}</span>
        </div>
        {vehicle.status==="active"&&(
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <Btn color="green" onClick={openBatchSale}>⚡ Batch Sale</Btn>
            <Btn color="ghost" onClick={()=>openModal("sale")}>+ Single Sale</Btn>
            <Btn color="blue"  onClick={()=>openModal("transfer")}>+ Transfer</Btn>
            <Btn color="ghost" onClick={()=>openModal("expense")}>+ Expense</Btn>
            <Btn color="red"   onClick={()=>setVehicles(vs=>vs.map(v=>v.id===vehicle.id?{...v,status:"closed"}:v))}>Close</Btn>
          </div>
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:10,marginBottom:20}}>
        <StatBox label="Purchased" value={fmtKg(c.purchased)} color={C.blue}/>
        <StatBox label="Transit Loss" value={fmtKg(c.transitLoss)} color={C.red}/>
        <StatBox label="Received" value={fmtKg(c.received)} color={C.amber}/>
        <StatBox label="Sold" value={fmtKg(c.soldWt)} color={C.green}/>
        <StatBox label="Transferred" value={fmtKg(c.transferWt)} color={C.purple}/>
        <StatBox label="Remaining" value={fmtKg(c.remaining)} color={c.remaining>0?C.green:C.muted}/>
      </div>
      <div style={{display:"flex",gap:2,marginBottom:20,background:C.card,padding:4,borderRadius:10,border:`1px solid ${C.border}`,width:"fit-content"}}>
        {TABS.map(t=>(<button key={t} onClick={()=>setTab(t)} style={{padding:"6px 16px",borderRadius:7,background:tab===t?C.amber:"transparent",color:tab===t?"#000":C.muted,border:"none",fontWeight:tab===t?700:500,textTransform:"uppercase",fontSize:11,letterSpacing:"0.05em"}}>{t}</button>))}
      </div>

      {tab==="overview"&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          <InfoCard title="Inventory Status">
            <Row2 label="Purchased" value={fmtKg(c.purchased)}/><Row2 label="Transit Loss" value={fmtKg(c.transitLoss)} color={C.red}/>
            <Row2 label="Received" value={fmtKg(c.received)} color={C.blue} bold/><Row2 label="Sold" value={fmtKg(c.soldWt)} color={C.green}/>
            <Row2 label="Transferred" value={fmtKg(c.transferWt)} color={C.purple}/><Row2 label="Remaining" value={fmtKg(c.remaining)} color={c.remaining>0?C.amber:C.muted} bold border={false}/>
          </InfoCard>
          <InfoCard title="Sales Collection">
            <Row2 label="Total Sale Value" value={fmtRs(c.totalSaleValue)}/>
            <Row2 label="Collected" value={fmtRs(c.totalReceiptsCollected)} color={C.green}/>
            <Row2 label="Pending" value={fmtRs(c.totalSaleBalance)} color={c.totalSaleBalance>0?C.red:C.green} bold border={false}/>
          </InfoCard>
          <InfoCard title="Supplier Payments">
            <Row2 label="Total Cost" value={fmtRs(c.purchaseCost)}/><Row2 label="Paid" value={fmtRs(c.supplierPaid)} color={C.green}/>
            <Row2 label="Balance Due" value={fmtRs(c.supplierBalance)} color={c.supplierBalance>0?C.red:C.green} bold border={false}/>
          </InfoCard>
          <InfoCard title="Profit & Loss">
            <Row2 label="Sale Value" value={fmtRs(c.totalSaleValue)} color={C.green}/>
            <Row2 label="Purchase Cost" value={fmtRs(c.purchaseCost)} color={C.red}/>
            <Row2 label="Vehicle Expenses" value={fmtRs(vehicle.expenses.reduce((s,x)=>s+n(x.amount),0))} color={C.red}/>
            {c.linkedExpenses>0&&<Row2 label="Linked Exp/Salaries" value={fmtRs(c.linkedExpenses)} color={C.orange}/>}
            <div style={{marginTop:12,padding:14,borderRadius:10,background:c.pnl>=0?C.greenSoft:C.redSoft,border:`1px solid ${c.pnl>=0?C.green:C.red}33`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontWeight:800}}>{c.pnl>=0?"✅ Profit":"❌ Loss"}</span>
              <span className="mono" style={{fontSize:20,fontWeight:800,color:c.pnl>=0?C.green:C.red}}>{fmtRs(Math.abs(c.pnl))}</span>
            </div>
          </InfoCard>
        </div>
      )}

      {tab==="purchases"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h2 style={{fontSize:16,fontWeight:700}}>Purchases <span style={{color:C.muted,fontWeight:400}}>({vehicle.purchases.length})</span></h2>
            {vehicle.status==="active"&&<Btn onClick={()=>openModal("purchase")}>+ Add Purchase</Btn>}
          </div>
          {vehicle.purchases.length===0?<Empty icon="📦" text="No purchases"/>:vehicle.purchases.map(p=>{
            const paid=(p.payments||[]).reduce((s,r)=>s+n(r.amount),0);const bal=n(p.weight)*n(p.rate)-paid;
            return(
              <div key={p.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                  <div><div style={{fontWeight:800,fontSize:15,marginBottom:3}}>📦 {p.supplierName}</div>
                    <div style={{fontSize:12,color:C.muted}}>{p.date} {p.time?`at ${p.time}`:""} · {fmtKg(p.weight)} @ Rs.{fmt(p.rate)}/kg{p.transitLoss>0&&<span style={{color:C.red}}> · Loss: {fmtKg(p.transitLoss)}</span>}</div></div>
                  <div style={{textAlign:"right"}}><div className="mono" style={{fontSize:16,fontWeight:800,color:C.amber}}>{fmtRs(n(p.weight)*n(p.rate))}</div><Tag color={bal>0?C.red:C.green}>{bal>0?`Due: ${fmtRs(bal)}`:"Fully Paid"}</Tag></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
                  <StatBox label="Total Cost" value={fmtRs(n(p.weight)*n(p.rate))} color={C.amber}/>
                  <StatBox label="Paid" value={fmtRs(paid)} color={C.green}/>
                  <StatBox label="Balance" value={fmtRs(bal)} color={bal>0?C.red:C.green}/>
                </div>
                {p.payments?.length>0&&(<table style={{width:"100%",borderCollapse:"collapse",marginBottom:10}}><thead><tr>{["Date","Amount","Method","Note"].map(h=><TH key={h} ch={h}/>)}</tr></thead><tbody>{p.payments.map(r=><tr key={r.id}><TD>{r.date}</TD><TD color={C.green} mono bold>{fmtRs(r.amount)}</TD><TD><Tag color={C.amber}>{r.method}</Tag></TD><TD color={C.muted}>{r.note||"—"}</TD></tr>)}</tbody></table>)}
                {vehicle.status==="active"&&bal>0&&<Btn color="amber" small onClick={()=>{setSelId(p.id);openModal("supplierpay");}}>+ Record Payment to Supplier</Btn>}
              </div>
            );
          })}
        </div>
      )}

      {tab==="sales"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h2 style={{fontSize:16,fontWeight:700}}>Sales <span style={{color:C.muted,fontWeight:400}}>({vehicle.sales.length})</span></h2>
          {vehicle.status==="active"&&<div style={{display:"flex",gap:8}}>
            <Btn color="blue" small onClick={()=>{setImportReceiptsPreview([]);setImportReceiptsError("");setImportReceiptsAccountId("");setModal("importReceipts");}}>📥 Import Receipts</Btn>
            <Btn color="purple" small onClick={()=>{setImportSalesPreview([]);setImportSalesError("");setModal("importSales");}}>📥 Import Sales</Btn>
            <Btn color="green" onClick={openBatchSale}>⚡ Batch Sale</Btn><Btn color="amber" onClick={()=>openModal("sale")}>+ Single Sale</Btn>
          </div>}
          </div>
          {vehicle.sales.length>0&&(
            <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",gap:24}}>
              <div><Label>Total Sale Value</Label><span className="mono" style={{color:C.text,fontWeight:700}}>{fmtRs(c.totalSaleValue)}</span></div>
              <div><Label>Collected</Label><span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(c.totalReceiptsCollected)}</span></div>
              <div><Label>Pending</Label><span className="mono" style={{color:c.totalSaleBalance>0?C.red:C.green,fontWeight:700}}>{fmtRs(c.totalSaleBalance)}</span></div>
            </div>
          )}
          {vehicle.sales.length===0?<Empty icon="🧾" text="No sales yet."/>:vehicle.sales.map(sale=>{
            const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);const saleBalance=sale.totalAmount-collected;
            return(
              <div key={sale.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18,marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                  <div><div style={{fontWeight:800,fontSize:15,marginBottom:3}}>🧾 <span style={{color:C.amber}}>{sale.receiptNo}</span> — {sale.customerName}{sale.notes?.includes("Batch")&&<span style={{marginLeft:8,background:C.purpleSoft,color:C.purple,padding:"1px 8px",borderRadius:10,fontSize:10,fontWeight:700}}>BATCH</span>}</div>
                    <div style={{fontSize:12,color:C.muted}}>{sale.date} · {fmtKg(sale.weight)} @ Rs.{fmt(sale.rate)}/kg{sale.driver?<span> · Driver: {sale.driver}</span>:""}</div></div>
                  <div style={{textAlign:"right"}}><div className="mono" style={{fontSize:16,fontWeight:800,color:C.green}}>{fmtRs(sale.totalAmount)}</div><Tag color={saleBalance>0?C.red:C.green}>{saleBalance>0?`Pending: ${fmtRs(saleBalance)}`:"Fully Collected"}</Tag></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
                  <StatBox label="Sale Amount" value={fmtRs(sale.totalAmount)} color={C.amber}/>
                  <StatBox label="Collected" value={fmtRs(collected)} color={C.green}/>
                  <StatBox label="Balance" value={fmtRs(saleBalance)} color={saleBalance>0?C.red:C.green}/>
                </div>
                {(sale.receipts||[]).length>0&&(<table style={{width:"100%",borderCollapse:"collapse",marginBottom:10}}><thead><tr>{["Date","Amount","Method","Account","Collector","Note"].map(h=><TH key={h} ch={h}/>)}</tr></thead><tbody>{sale.receipts.map(r=><tr key={r.id}><TD>{r.date}</TD><TD color={C.green} mono bold>{fmtRs(r.amount)}</TD><TD><Tag color={C.blue}>{r.method||"Cash"}</Tag></TD><TD color={C.muted}>{r.accountName||"—"}</TD><TD color={C.muted}>{r.collector||"—"}</TD><TD color={C.muted}>{r.note||"—"}</TD></tr>)}</tbody></table>)}
                {saleBalance>0&&<Btn color="green" small onClick={()=>{setSelId(sale.id);openModal("receipt");}}>+ Add Receipt</Btn>}
              </div>
            );
          })}
        </div>
      )}

      {tab==="transfers"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h2 style={{fontSize:16,fontWeight:700}}>Farm Transfers</h2>
            {vehicle.status==="active"&&<Btn onClick={()=>openModal("transfer")}>+ Add Transfer</Btn>}
          </div>
          {vehicle.transfers.length===0?<Empty icon="🌾" text="No transfers"/>:(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr>{["Date","Weight","Note"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                <tbody>{vehicle.transfers.map(t=><tr key={t.id}><TD>{t.date}</TD><TD color={C.purple} mono bold>{fmtKg(t.weight)}</TD><TD color={C.muted}>{t.note||"—"}</TD></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab==="expenses"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h2 style={{fontSize:16,fontWeight:700}}>Expenses</h2>
            {vehicle.status==="active"&&<Btn onClick={()=>openModal("expense")}>+ Add Expense</Btn>}
          </div>
          {/* Vehicle direct expenses */}
          {vehicle.expenses.length>0&&(
            <>
              <div style={{fontSize:13,color:C.muted,fontWeight:700,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"}}>Direct Vehicle Expenses</div>
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr>{["Date","Description","Type","Paid From","Amount"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                  <tbody>
                    {vehicle.expenses.map(e=><tr key={e.id}><TD>{e.date}</TD><TD bold>{e.description}</TD><TD><Tag color={C.purple}>{e.type}</Tag></TD><TD color={C.muted}>{e.accountName||"—"}</TD><TD color={C.red} mono bold>{fmtRs(e.amount)}</TD></tr>)}
                    <tr><td colSpan={4} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>DIRECT TOTAL</td><td style={{padding:"10px 12px",background:C.card2}}><span className="mono" style={{color:C.red,fontWeight:700}}>{fmtRs(vehicle.expenses.reduce((s,x)=>s+n(x.amount),0))}</span></td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
          {/* Linked external expenses */}
          {linkedTxns.length>0&&(
            <>
              <div style={{fontSize:13,color:C.teal,fontWeight:700,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"}}>🔗 Linked Expenses & Salaries (from Accounts/Salaries)</div>
              <div style={{background:C.card,border:`1px solid ${C.teal}33`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr><TH ch="Date"/><TH ch="Description"/><TH ch="Type"/><TH ch="Amount" right/></tr></thead>
                  <tbody>
                    {linkedTxns.map(t=>{const cfg=TXN_TYPES[t.type]||{label:t.type,color:C.muted};return(<tr key={t.id}><TD>{t.date}</TD><TD bold>{t.description}</TD><TD><Tag color={cfg.color}>{cfg.label}</Tag></TD><TD right mono color={C.orange} bold>{fmtRs(t.amount)}</TD></tr>);})}
                    <tr><td colSpan={3} style={{padding:"10px 12px",background:C.card2,fontWeight:700,fontSize:12,color:C.muted}}>LINKED TOTAL</td><td style={{padding:"10px 12px",background:C.card2,textAlign:"right"}}><span className="mono" style={{color:C.orange,fontWeight:700}}>{fmtRs(c.linkedExpenses)}</span></td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
          {vehicle.expenses.length===0&&linkedTxns.length===0&&<Empty icon="💸" text="No expenses linked to this project"/>}
          <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontWeight:700}}>TOTAL ALL EXPENSES</span>
            <span className="mono" style={{color:C.red,fontWeight:700,fontSize:16}}>{fmtRs(c.totalExpenses)}</span>
          </div>
        </div>
      )}

      {tab==="p&l"&&(
        <div style={{maxWidth:520}}>
          <h2 style={{fontSize:16,fontWeight:700,marginBottom:20}}>Profit & Loss — {vehicle.vehicleNo}</h2>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:24}}>
            <Label>REVENUE</Label><Row2 label="Total Sale Value" value={fmtRs(c.totalSaleValue)} color={C.green}/>
            <div style={{height:1,background:C.border,margin:"14px 0"}}/><Label>COSTS</Label>
            {vehicle.purchases.map(p=><Row2 key={p.id} label={`${p.supplierName} (${fmtKg(p.weight)} × Rs.${fmt(p.rate)})`} value={fmtRs(n(p.weight)*n(p.rate))} color={C.red}/>)}
            {vehicle.expenses.map(e=><Row2 key={e.id} label={`${e.description} [${e.type}]`} value={fmtRs(e.amount)} color={C.red}/>)}
            {linkedTxns.length>0&&(
              <>
                <div style={{fontSize:11,color:C.teal,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",margin:"12px 0 6px"}}>Linked Exp/Salaries</div>
                {linkedTxns.map(t=><Row2 key={t.id} label={t.description} value={fmtRs(t.amount)} color={C.orange}/>)}
              </>
            )}
            <div style={{height:1,background:C.border,margin:"14px 0"}}/>
            <Row2 label="Total Revenue" value={fmtRs(c.totalSaleValue)} color={C.green} bold/>
            <Row2 label="Total Cost" value={fmtRs(c.totalCost)} color={C.red} bold/>
            <div style={{height:1,background:C.border,margin:"14px 0"}}/>
            <div style={{padding:18,borderRadius:10,background:c.pnl>=0?C.greenSoft:C.redSoft,border:`1px solid ${c.pnl>=0?C.green:C.red}33`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:15,fontWeight:800}}>{c.pnl>=0?"✅ Net Profit":"❌ Net Loss"}</span>
              <span className="mono" style={{fontSize:22,fontWeight:800,color:c.pnl>=0?C.green:C.red}}>{fmtRs(Math.abs(c.pnl))}</span>
            </div>
          </div>
        </div>
      )}

      {modal==="purchase"&&(
        <Modal title="Add Purchase" onSave={addPurchase} saveLabel="Add" onClose={closeModal} width={540}>
          <Fld label="Supplier"><select value={form.supplierId||""} onChange={fv("supplierId")}><option value="">— Select Supplier —</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.name} ({s.city||s.region||""})</option>)}</select></Fld>
          <div style={{display:"flex",gap:12}}><Fld label="Date" half><input type="date" value={form.date||""} onChange={fv("date")}/></Fld><Fld label="Time" half><input type="time" value={form.time||""} onChange={fv("time")}/></Fld></div>
          <div style={{display:"flex",gap:12}}><Fld label="Weight (kg)" half><input type="number" value={form.weight||""} onChange={fv("weight")} placeholder="e.g. 8000"/></Fld><Fld label="Rate (Rs/kg)" half><input type="number" value={form.rate||""} onChange={fv("rate")} placeholder="e.g. 350"/></Fld></div>
          <Fld label="Transit Loss (kg)"><input type="number" value={form.transitLoss||""} onChange={fv("transitLoss")} placeholder="Weight lost on the way"/></Fld>
          {form.weight&&form.transitLoss&&<div style={{background:C.blueSoft,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.blue,marginBottom:12}}>Received: <strong className="mono">{fmtKg(n(form.weight)-n(form.transitLoss))}</strong>{form.rate&&<span> · Cost: <strong className="mono">{fmtRs(n(form.weight)*n(form.rate))}</strong></span>}</div>}
        </Modal>
      )}
      {modal==="supplierpay"&&(()=>{
        const pur=vehicle.purchases.find(p=>p.id===selId);const paid=(pur?.payments||[]).reduce((s,r)=>s+n(r.amount),0);const bal=pur?n(pur.weight)*n(pur.rate)-paid:0;
        return(<Modal title="Record Payment to Supplier" onSave={()=>addSupplierPayment(selId)} saveLabel="Record" onClose={closeModal}>
          <div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.red}}>Balance due to <strong>{pur?.supplierName}</strong>: <strong className="mono">{fmtRs(bal)}</strong></div>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={fv("accountId")} label="Pay From Account"/>
          <div style={{display:"flex",gap:12}}><Fld label="Date" half><input type="date" value={form.date||""} onChange={fv("date")}/></Fld><Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={fv("amount")} placeholder="Amount"/></Fld></div>
          <Fld label="Method"><select value={form.method||"Cash"} onChange={fv("method")}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option></select></Fld>
          <Fld label="Note"><input value={form.note||""} onChange={fv("note")} placeholder="Optional"/></Fld>
        </Modal>);
      })()}
      
      {modal==="editSale"&&(()=>{
        const _es=vehicle.sales.find(s=>s.id===selId);
        const saveEdit=()=>{
          if(n(form.weight)<=0) return alert("Weight must be > 0");
          if(n(form.rate)<=0) return alert("Rate must be > 0");
          mut(v=>({...v,sales:v.sales.map(s=>s.id===selId?{...s,date:form.date||s.date,weight:n(form.weight),rate:n(form.rate),totalAmount:n(form.weight)*n(form.rate)}:s)}));
          closeModal();
        };
        return <Modal title="✏️ Edit Sale" onSave={saveEdit} saveLabel="Save Changes" onClose={closeModal} width={480}>
          <div style={{background:C.amberSoft,borderRadius:8,padding:"9px 14px",marginBottom:12,fontSize:13,color:C.amber}}>Editing: <b>{_es?.customerName}</b> · {_es?.receiptNo}</div>
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Weight (kg)" half><input type="number" min="0" value={form.weight||""} onChange={fv("weight")}/></Fld>
            <Fld label="Rate (Rs/kg)" half><input type="number" min="0" value={form.rate||""} onChange={fv("rate")}/></Fld>
          </div>
          {form.weight&&form.rate&&<div style={{background:C.greenSoft,borderRadius:8,padding:"9px 14px",fontSize:14,color:C.green,fontWeight:700}}>New Amount: <span className="mono">{fmtRs(n(form.weight)*n(form.rate))}</span></div>}
        </Modal>;
      })()}

      {modal==="sale"&&(
        <Modal title="Record Sale" onSave={addSale} saveLabel="Record" onClose={closeModal} width={540}>
          <div style={{background:C.amberSoft,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.amber}}>⚖️ Available: <strong className="mono">{fmtKg(c.remaining)}</strong></div>
          <Fld label="Customer"><select value={form.customerId||""} onChange={e=>{const cu=customers.find(c=>c.id===e.target.value);setForm(p=>({...p,customerId:e.target.value,rate:cu?.defaultRate||p.rate||""}));}}><option value="">— Select Customer —</option>{customers.map(cu=><option key={cu.id} value={cu.id}>{cu.name} ({cu.city||""})</option>)}</select></Fld>
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <div style={{display:"flex",gap:12}}><Fld label="Weight (kg)" half><input type="number" value={form.weight||""} onChange={fv("weight")} placeholder="e.g. 200"/></Fld><Fld label="Rate (Rs/kg)" half><input type="number" value={form.rate||""} onChange={fv("rate")} placeholder="auto from customer"/></Fld></div>
          {form.weight&&form.rate&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:8,padding:"9px 14px",fontSize:14,color:C.green,fontWeight:700,marginBottom:12}}>Sale Amount: <span className="mono">{fmtRs(n(form.weight)*n(form.rate))}</span></div>}
        </Modal>
      )}
      {modal==="receipt"&&(()=>{
        const sale=vehicle.sales.find(s=>s.id===selId);const col=(sale?.receipts||[]).reduce((s,r)=>s+n(r.amount),0);const bal=sale?sale.totalAmount-col:0;
        return(<Modal title="Add Receipt from Customer" onSave={()=>addReceipt(selId)} saveLabel="Add Receipt" onClose={closeModal}>
          <div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.green}}>{sale?.customerName} · {sale?.receiptNo} · Pending: <strong className="mono">{fmtRs(bal)}</strong></div>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={e=>{const a=accounts.find(x=>x.id===e.target.value);setForm(p=>({...p,accountId:e.target.value,accountName:a?.name||""}));}} label="Deposit Into Account"/>
          <div style={{display:"flex",gap:12}}><Fld label="Date" half><input type="date" value={form.date||""} onChange={fv("date")}/></Fld><Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={fv("amount")} placeholder="Amount"/></Fld></div>
          <Fld label="Method"><select value={form.method||"Cash"} onChange={fv("method")}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option></select></Fld>
          <Fld label="Note"><input value={form.note||""} onChange={fv("note")} placeholder="Optional"/></Fld>
        </Modal>);
      })()}
      {modal==="transfer"&&(
        <Modal title="Transfer to Farm" onSave={addTransfer} saveLabel="Record" onClose={closeModal}>
          <div style={{background:C.amberSoft,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.amber}}>⚖️ Available: <strong className="mono">{fmtKg(c.remaining)}</strong></div>
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <Fld label="Weight (kg)"><input type="number" value={form.weight||""} onChange={fv("weight")} placeholder="e.g. 2000"/></Fld>
          <Fld label="Note"><input value={form.note||""} onChange={fv("note")} placeholder="e.g. Transferred to Khuzdar farm"/></Fld>
        </Modal>
      )}
      {modal==="expense"&&(
        <Modal title="Add Expense" onSave={addExpense} saveLabel="Add" onClose={closeModal}>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={e=>{const a=accounts.find(x=>x.id===e.target.value);setForm(p=>({...p,accountId:e.target.value,accountName:a?.name||""}));}} label="Pay From Account"/>
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <Fld label="Description"><input value={form.description||""} onChange={fv("description")} placeholder="e.g. Toll tax, Petrol"/></Fld>
          <div style={{display:"flex",gap:12}}><Fld label="Type" half><select value={form.type||"Transit"} onChange={fv("type")}>{expenseCategories.map(ec=><option key={ec}>{ec}</option>)}</select></Fld><Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={fv("amount")} placeholder="e.g. 5000"/></Fld></div>
        </Modal>
      )}
      {modal==="importSales"&&(
        <Modal title="📥 Import Sales from Excel" onClose={closeModal} noFooter width={780}>
          <div style={{background:C.purpleSoft,border:`1px solid ${C.purple}33`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13}}>
            <div style={{fontWeight:700,color:C.purple,marginBottom:4}}>Required Columns: CustomerName, Date, Weight, Rate</div>
            <div style={{color:C.muted}}>Optional: Notes · Customer names must match exactly as in your Customers list</div>
          </div>
          <div style={{background:C.amberSoft,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.amber}}>
            ⚖️ Available Stock: <strong className="mono">{fmtKg(c.remaining)}</strong>
          </div>
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <Btn color="ghost" onClick={downloadSalesTemplate}>⬇ Sample Template</Btn>
            <Btn color="purple" onClick={()=>importSalesRef.current.click()}>📂 Choose Excel/CSV File</Btn>
            <input ref={importSalesRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleImportSalesFile}/>
          </div>
          {importSalesError&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px 14px",color:C.red,fontSize:13,marginBottom:12}}>⚠ {importSalesError}</div>}
          {importSalesPreview.length>0?(
            <div>
              <div style={{fontWeight:700,marginBottom:10}}>
                <span style={{color:C.green}}>{importSalesPreview.filter(r=>r.customerFound&&r.weight>0&&r.rate>0).length} ready</span>
                {importSalesPreview.filter(r=>!r.customerFound).length>0&&<span style={{color:C.red,marginLeft:10}}>{importSalesPreview.filter(r=>!r.customerFound).length} unmatched customers</span>}
                {importSalesPreview.filter(r=>r.customerFound&&(!r.weight||!r.rate)).length>0&&<span style={{color:C.amber,marginLeft:10}}>{importSalesPreview.filter(r=>r.customerFound&&(!r.weight||!r.rate)).length} missing weight/rate</span>}
              </div>
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:320,overflowY:"auto",marginBottom:14}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}>
                    <tr><TH ch="#"/><TH ch="Customer"/><TH ch="Date"/><TH ch="Weight"/><TH ch="Rate"/><TH ch="Amount" right/><TH ch="Status"/></tr>
                  </thead>
                  <tbody>{importSalesPreview.map((r,i)=>{
                    const amt=n(r.weight)*n(r.rate);const ok=r.customerFound&&r.weight>0&&r.rate>0;
                    return(<tr key={i} style={{background:ok?C.greenSoft:C.redSoft}}>
                      <TD color={C.muted} small>{r._row}</TD>
                      <TD bold>{r.custName}</TD>
                      <TD color={C.muted}>{r.date}</TD>
                      <TD mono>{r.weight>0?fmtKg(r.weight):<span style={{color:C.red}}>missing</span>}</TD>
                      <TD mono>{r.rate>0?`Rs.${fmt(r.rate)}`:<span style={{color:C.red}}>missing</span>}</TD>
                      <TD right mono color={ok?C.green:C.muted}>{ok?fmtRs(amt):"—"}</TD>
                      <TD><Tag color={ok?C.green:C.red}>{ok?"✓ Ready":!r.customerFound?"No customer":"Missing data"}</Tag></TD>
                    </tr>);
                  })}</tbody>
                </table>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:13,color:C.muted}}>Total: <span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(importSalesPreview.filter(r=>r.customerFound&&r.weight>0&&r.rate>0).reduce((s,r)=>s+n(r.weight)*n(r.rate),0))}</span> · {fmtKg(importSalesPreview.filter(r=>r.customerFound&&r.weight>0&&r.rate>0).reduce((s,r)=>s+n(r.weight),0))}</div>
                <div style={{display:"flex",gap:8}}>
                  <Btn color="ghost" onClick={closeModal}>Cancel</Btn>
                  <Btn color="purple" onClick={confirmImportSales} sx={{opacity:importSalesPreview.filter(r=>r.customerFound&&r.weight>0&&r.rate>0).length===0?0.5:1}}>
                    ⬆ Import {importSalesPreview.filter(r=>r.customerFound&&r.weight>0&&r.rate>0).length} Sales
                  </Btn>
                </div>
              </div>
            </div>
          ):<div style={{textAlign:"center",padding:"30px 20px",color:C.muted,border:`2px dashed ${C.border}`,borderRadius:10}}>📂 Select an Excel or CSV file to preview</div>}
          {importSalesPreview.length===0&&<div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}><Btn color="ghost" onClick={closeModal}>Close</Btn></div>}
        </Modal>
      )}
      {modal==="importReceipts"&&(
        <Modal title="📥 Import Receipts from Excel" onClose={closeModal} noFooter width={820}>
          <div style={{background:C.blueSoft,border:`1px solid ${C.blue}33`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13}}>
            <div style={{fontWeight:700,color:C.blue,marginBottom:4}}>Columns: ReceiptNo (or CustomerName), Date, Amount, Method, Note</div>
            <div style={{color:C.muted}}>Match by ReceiptNo first, or by CustomerName (applies to highest-pending sale)</div>
          </div>
          <div style={{display:"flex",gap:10,marginBottom:12}}>
            <Btn color="ghost" onClick={downloadReceiptsTemplate}>⬇ Sample Template</Btn>
            <Btn color="blue" onClick={()=>importReceiptsRef.current.click()}>📂 Choose Excel/CSV File</Btn>
            <input ref={importReceiptsRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleImportReceiptsFile}/>
          </div>
          <Fld label="Deposit Into Account">
            <select value={importReceiptsAccountId} onChange={e=>setImportReceiptsAccountId(e.target.value)}>
              <option value="">— Select Account —</option>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Fld>
          {importReceiptsError&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"10px 14px",color:C.red,fontSize:13,marginBottom:12}}>⚠ {importReceiptsError}</div>}
          {importReceiptsPreview.length>0?(
            <div>
              <div style={{fontWeight:700,marginBottom:10}}>
                <span style={{color:C.green}}>{importReceiptsPreview.filter(r=>r.saleFound&&r.amount>0).length} matched</span>
                {importReceiptsPreview.filter(r=>!r.saleFound).length>0&&<span style={{color:C.red,marginLeft:10}}>{importReceiptsPreview.filter(r=>!r.saleFound).length} unmatched</span>}
              </div>
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:320,overflowY:"auto",marginBottom:14}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}>
                    <tr><TH ch="#"/><TH ch="Match (ReceiptNo/Customer)"/><TH ch="Date"/><TH ch="Amount"/><TH ch="Method"/><TH ch="Sale Balance"/><TH ch="Status"/></tr>
                  </thead>
                  <tbody>{importReceiptsPreview.map((r,i)=>{
                    const ok=r.saleFound&&r.amount>0;
                    return(<tr key={i} style={{background:ok?C.greenSoft:C.redSoft}}>
                      <TD color={C.muted} small>{r._row}</TD>
                      <TD bold>{r.receiptNo||r.custName||"—"}<div style={{fontSize:11,color:C.muted,fontWeight:400}}>{r.matchedSale?r.matchedSale.customerName:""}</div></TD>
                      <TD color={C.muted}>{r.date}</TD>
                      <TD mono color={C.green} bold>{fmtRs(r.amount)}</TD>
                      <TD><Tag color={C.blue}>{r.method||"Cash"}</Tag></TD>
                      <TD mono color={r.saleBalance>0?C.amber:C.muted}>{r.matchedSale?fmtRs(r.saleBalance):"—"}</TD>
                      <TD><Tag color={ok?C.green:C.red}>{ok?"✓ Matched":"No sale found"}</Tag></TD>
                    </tr>);
                  })}</tbody>
                </table>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:13,color:C.muted}}>Total to collect: <span className="mono" style={{color:C.green,fontWeight:700}}>{fmtRs(importReceiptsPreview.filter(r=>r.saleFound).reduce((s,r)=>s+n(r.amount),0))}</span></div>
                <div style={{display:"flex",gap:8}}>
                  <Btn color="ghost" onClick={closeModal}>Cancel</Btn>
                  <Btn color="blue" onClick={confirmImportReceipts} sx={{opacity:importReceiptsPreview.filter(r=>r.saleFound&&r.amount>0).length===0||!importReceiptsAccountId?0.5:1}}>
                    ⬆ Import {importReceiptsPreview.filter(r=>r.saleFound&&r.amount>0).length} Receipts
                  </Btn>
                </div>
              </div>
            </div>
          ):<div style={{textAlign:"center",padding:"30px 20px",color:C.muted,border:`2px dashed ${C.border}`,borderRadius:10}}>📂 Select an Excel or CSV file to preview</div>}
          {importReceiptsPreview.length===0&&<div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}><Btn color="ghost" onClick={closeModal}>Close</Btn></div>}
        </Modal>
      )}
      {modal==="batchSale"&&(
        <Modal title="⚡ Batch Sale Entry" onSave={confirmBatchSale} saveLabel={`Add ${batchValid.length} Sales`} onClose={closeModal} width={900}>
          <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",gap:20,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div><Label>Available Stock</Label><span className="mono" style={{fontWeight:700,color:C.amber}}>{fmtKg(c.remaining)}</span></div>
            <div><Label>Total Weight</Label><span className="mono" style={{fontWeight:700,color:batchTotalWt>c.remaining?C.red:C.green}}>{fmtKg(batchTotalWt)}</span></div>
            <div><Label>Total Value</Label><span className="mono" style={{fontWeight:700,color:C.green}}>{fmtRs(batchTotalAmt)}</span></div>
            <div><Label>Customers</Label><span className="mono" style={{fontWeight:700,color:C.blue}}>{batchValid.length}</span></div>
            <Fld label="Date" sx={{marginBottom:0,width:150}}><input type="date" value={batchDate} onChange={e=>setBatchDate(e.target.value)}/></Fld>
            <Fld label="Driver / Distributor" sx={{marginBottom:0,flex:1,minWidth:160}}>
              <select value={batchDriver} onChange={e=>{setBatchDriver(e.target.value);setBatchDriverName(e.target.value?labourers.find(l=>l.id===e.target.value)?.name||"":"");}}>
                <option value="">— Select Driver —</option>
                {labourers.map(l=><option key={l.id} value={l.id}>{l.name} {l.role?`(${l.role})`:""}</option>)}
              </select>
            </Fld>
            {!batchDriver&&(<Fld label="Or Type Name" sx={{marginBottom:0,flex:1,minWidth:120}}><input value={batchDriverName} onChange={e=>setBatchDriverName(e.target.value)} placeholder="Driver name"/></Fld>)}
          </div>
          {batchTotalWt>c.remaining&&<div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.red,marginBottom:12}}>⚠️ Total weight exceeds available stock by {fmtKg(batchTotalWt-c.remaining)}</div>}
          <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:C.muted}}>ADD CUSTOMERS TO BATCH</div>
            <input placeholder="🔍  Search customer by name or city to add…" value={batchCustSearch} onChange={e=>setBatchCustSearch(e.target.value)}/>
            {batchCustSearch&&(
              <div style={{marginTop:8,background:C.card,border:`1px solid ${C.border}`,borderRadius:8,maxHeight:180,overflowY:"auto"}}>
                {availableForBatch.length===0?<div style={{padding:"12px 14px",color:C.muted,fontSize:13}}>No customers found</div>
                  :availableForBatch.slice(0,12).map(cu=>(
                    <div key={cu.id} onClick={()=>addToBatch(cu)} style={{padding:"10px 14px",cursor:"pointer",borderBottom:`1px solid ${C.border}22`,display:"flex",justifyContent:"space-between",alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.background=C.card2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span style={{fontWeight:600}}>{cu.name} <span style={{color:C.muted,fontWeight:400,fontSize:12}}>{cu.city?`· ${cu.city}`:""}</span></span>
                      <span style={{fontSize:12,color:C.amber}}>{cu.defaultRate?`Rs.${fmt(cu.defaultRate)}/kg`:"no rate"} <span style={{color:C.muted}}>→ Add</span></span>
                    </div>
                  ))}
              </div>
            )}
          </div>
          {batchItems.length===0?(
            <div style={{textAlign:"center",padding:"30px",color:C.muted,border:`2px dashed ${C.border}`,borderRadius:10}}>🔍 Search and add customers above to start the batch</div>
          ):(
            <>
              {batchItems.length>5&&<input placeholder="🔍  Filter added customers…" value={batchSearch} onChange={e=>setBatchSearch(e.target.value)} style={{marginBottom:10}}/>}
              <div style={{border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",maxHeight:360,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead style={{position:"sticky",top:0,background:C.card3,zIndex:1}}><tr><TH ch="#"/><TH ch="Customer"/><TH ch="City"/><TH ch="Rate (Rs/kg)"/><TH ch="Weight (kg)"/><TH ch="Amount" right/><TH ch=""/></tr></thead>
                  <tbody>
                    {batchFiltered.map((r,i)=>{const amt=n(r.weight)*n(r.rate);return(
                      <tr key={r.customerId} style={{background:n(r.weight)>0?C.greenSoft:"transparent"}}>
                        <TD color={C.muted} small>{i+1}</TD><TD bold>{r.name}</TD><TD color={C.muted}>{r.city||"—"}</TD>
                        <TD><input className="ci" type="number" value={r.rate} placeholder="Rate" onChange={e=>updBatch(r.customerId,"rate",e.target.value)} style={{width:90}}/></TD>
                        <TD><input className="ci" type="number" value={r.weight} placeholder="0" onChange={e=>updBatch(r.customerId,"weight",e.target.value)} style={{width:90}} autoFocus={i===batchItems.length-1}/></TD>
                        <TD mono color={amt>0?C.green:C.muted} right>{amt>0?fmtRs(amt):"—"}</TD>
                        <TD><button onClick={()=>removeFromBatch(r.customerId)} style={{background:"transparent",color:C.red,fontSize:16,padding:"2px 6px"}}>✕</button></TD>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
              <div style={{marginTop:10,fontSize:12,color:C.muted}}>{batchItems.length} customer{batchItems.length!==1?"s":""} added</div>
            </>
          )}
          <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
            <Btn color="ghost" onClick={closeModal}>Cancel</Btn>
            <Btn color="amber" onClick={confirmBatchSale} sx={{opacity:batchValid.length===0||batchTotalWt>c.remaining?0.5:1}}>⚡ Add {batchValid.length} Sales ({fmtRs(batchTotalAmt)})</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── NEW VEHICLE MODAL ────────────────────────────────────────────────────────
function NewVehicleModal({suppliers,onClose,onCreate}){
  const [form,setForm]=useState({date:today(),time:nowTime(),origin:"Punjab"});
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    if(!form.vehicleNo) return alert("Enter vehicle number");
    onCreate({id:genId(),status:"active",vehicleNo:form.vehicleNo,driverName:form.driverName||"",date:form.date,time:form.time,origin:form.origin||"Punjab",
      supplierName:suppliers.find(s=>s.id===form.supplierId)?.name||"",purchases:[],sales:[],transfers:[],expenses:[]});
    onClose();
  };
  return(
    <Modal title="🚛 New Vehicle Project" onSave={save} saveLabel="Create Project" onClose={onClose}>
      <div style={{display:"flex",gap:12}}>
        <Fld label="Vehicle Number" half><input value={form.vehicleNo||""} onChange={f("vehicleNo")} placeholder="e.g. LEA-1234"/></Fld>
        <Fld label="Driver Name" half><input value={form.driverName||""} onChange={f("driverName")} placeholder="Driver name"/></Fld>
      </div>
      <div style={{display:"flex",gap:12}}>
        <Fld label="Arrival Date" half><input type="date" value={form.date||""} onChange={f("date")}/></Fld>
        <Fld label="Arrival Time" half><input type="time" value={form.time||""} onChange={f("time")}/></Fld>
      </div>
      <div style={{display:"flex",gap:12}}>
        <Fld label="Origin" half><select value={form.origin||"Punjab"} onChange={f("origin")}><option>Punjab</option><option>Sindh</option><option>KPK</option><option>Other</option></select></Fld>
        <Fld label="Default Supplier (Optional)" half><select value={form.supplierId||""} onChange={f("supplierId")}><option value="">— Optional —</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Fld>
      </div>
    </Modal>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────

// ─── FIREBASE PERSISTED STATE ────────────────────────────────────────────────
function useFirestoreState(uid, key, defaultValue) {
  const [state, setState] = useState(defaultValue);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!uid) return;
    // Timeout fallback: if Firestore doesn't respond in 8s, use default and continue
    const timeout = setTimeout(() => {
      setLoaded(true);
    }, 8000);

    const ref = doc(db, "users", uid, "data", key);
    const unsub = onSnapshot(ref, (snap) => {
      clearTimeout(timeout);
      if (snap.exists()) {
        const val = snap.data().value;
        setState(val !== undefined ? val : defaultValue);
      } else {
        setState(defaultValue);
      }
      setLoaded(true);
    }, (err) => {
      clearTimeout(timeout);
      console.error("Firestore error for", key, ":", err.code, err.message);
      setLoaded(true); // Don't block the app
    });
    return () => { clearTimeout(timeout); unsub(); };
  }, [uid, key]);

  const setPersisted = useCallback((value) => {
    setState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      if (uid) {
        const ref = doc(db, "users", uid, "data", key);
        setDoc(ref, { value: next }, { merge: true }).catch(e => console.error("Save error:", e));
      }
      return next;
    });
  }, [uid, key]);

  return [state, setPersisted, loaded];
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(err.message.replace("Firebase: ", "").replace(/\(auth.*\)/, ""));
    }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100dvh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:20,padding:"32px 24px",width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:36,marginBottom:8}}>🐔</div>
          <div style={{fontSize:22,fontWeight:800,color:C.amber,letterSpacing:"-0.02em"}}>ChickenFlow</div>
          <div style={{fontSize:12,color:C.muted,marginTop:4}}>{isRegister ? "Create your account" : "Sign in to your account"}</div>
        </div>
        <form onSubmit={handle}>
          <div style={{marginBottom:14}}>
            <label style={{display:"block",fontSize:12,color:C.muted,marginBottom:5,fontWeight:600}}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="you@example.com" required autoComplete="email" style={{fontSize:16}}/>
          </div>
          <div style={{marginBottom:20}}>
            <label style={{display:"block",fontSize:12,color:C.muted,marginBottom:5,fontWeight:600}}>Password</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
              placeholder="••••••••" required minLength={6} autoComplete={isRegister?"new-password":"current-password"} style={{fontSize:16}}/>
          </div>
          {error && <div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"8px 12px",
            fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{width:"100%",background:C.amber,color:"#000",fontWeight:700,fontSize:16,
              padding:"14px 0",borderRadius:12,border:"none",cursor:loading?"not-allowed":"pointer",
              opacity:loading?0.7:1,minHeight:52}}>
            {loading ? "Please wait..." : isRegister ? "Create Account" : "Sign In"}
          </button>
        </form>
        <div style={{textAlign:"center",marginTop:18,fontSize:12,color:C.muted}}>
          {isRegister ? "Already have an account? " : "Don't have an account? "}
          <span onClick={()=>{setIsRegister(!isRegister);setError("");}}
            style={{color:C.amber,cursor:"pointer",fontWeight:600}}>
            {isRegister ? "Sign In" : "Register"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── LOADING SCREEN ───────────────────────────────────────────────────────────
function LoadingScreen() {
  const [dots, setDots] = React.useState(".");
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{minHeight:"100dvh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:40,marginBottom:12}}>🐔</div>
        <div style={{color:C.muted,fontSize:14}}>Loading ChickenFlow...</div>
      </div>
    </div>
  );
}

function exportAllData(data) {
  const snapshot = { ...data, _exportedAt: new Date().toISOString(), _version: "1.0" };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0,10);
  a.href = url; a.download = `ChickenFlow_Backup_${dateStr}.json`; a.click();
  URL.revokeObjectURL(url);
}
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  componentDidCatch(err) { this.setState({ error: err.message || String(err) }); }
  render() {
    if (this.state.error) return (
      <div style={{minHeight:"100dvh",background:"#080B12",color:"#fff",display:"flex",
        flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"sans-serif"}}>
        <div style={{fontSize:36,marginBottom:12}}>🐔</div>
        <div style={{fontSize:14,color:"#F59E0B",marginBottom:12,fontWeight:700}}>ChickenFlow - Error</div>
        <div style={{fontSize:12,color:"#ef4444",background:"#200",borderRadius:8,
          padding:14,maxWidth:320,wordBreak:"break-word"}}>{this.state.error}</div>
        <button onClick={()=>window.location.reload()}
          style={{marginTop:20,background:"#F59E0B",color:"#000",border:"none",
            borderRadius:10,padding:"12px 28px",fontSize:14,fontWeight:700,cursor:"pointer"}}>
          Reload App
        </button>
      </div>
    );
    return this.props.children;
  }
}

export default function AppRoot() {
  const [user, setUser] = useState(undefined);
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    try {
      const unsub = onAuthStateChanged(auth, u => setUser(u), err => {
        setInitError(err.message); setUser(null);
      });
      return () => unsub();
    } catch(e) {
      setInitError(e.message); setUser(null);
    }
  }, []);

  if (initError) return (
    <div style={{minHeight:"100dvh",background:"#080B12",color:"#fff",display:"flex",
      flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"sans-serif"}}>
      <div style={{fontSize:36,marginBottom:12}}>🐔</div>
      <div style={{fontSize:14,color:"#F59E0B",marginBottom:12,fontWeight:700}}>Startup Error</div>
      <div style={{fontSize:12,color:"#ef4444",background:"#200",borderRadius:8,
        padding:14,maxWidth:320,wordBreak:"break-word"}}>{initError}</div>
      <button onClick={()=>{setInitError(null);setUser(null);}}
        style={{marginTop:16,background:"#F59E0B",color:"#000",border:"none",
          borderRadius:10,padding:"12px 28px",fontSize:14,fontWeight:700}}>Try Again</button>
    </div>
  );

  if (user === undefined) return <><style>{css}</style><LoadingScreen /></>;
  if (!user) return <ErrorBoundary><style>{css}</style><LoginScreen /></ErrorBoundary>;
  return <ErrorBoundary><App uid={user.uid} userEmail={user.email} /></ErrorBoundary>;
}

function App({ uid, userEmail }) {
  const [vehicles,    setVehicles,    v_loaded]  = useFirestoreState(uid, "cf_vehicles",    []);
  const [customers,   setCustomers,   c_loaded]  = useFirestoreState(uid, "cf_customers",   []);
  const [suppliers,   setSuppliers,   s_loaded]  = useFirestoreState(uid, "cf_suppliers",   []);
  const [accounts,    setAccounts,    a_loaded]  = useFirestoreState(uid, "cf_accounts",    [{id:"cash",name:"Cash on Hand",type:"cash",createdAt:today()}]);
  const [transactions,setTransactions,t_loaded]  = useFirestoreState(uid, "cf_transactions",[]);
  const [labourers,   setLabourers,   l_loaded]  = useFirestoreState(uid, "cf_labourers",   []);
  const [expenseCategories,setExpenseCategories,ec_loaded] = useFirestoreState(uid, "cf_categories", ["Transit","Office","Driver","Loading","Home Expense","Personal","Fuel","Utility","Other"]);

  const allLoaded = v_loaded && c_loaded && s_loaded && a_loaded && t_loaded && l_loaded && ec_loaded;

  const [page,    setPage]    = useState("projects");
  const [openId,  setOpenId]  = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [autoBackupMinutes, setAutoBackupMinutes] = useState(0);

  const addTxn = txn => setTransactions(p => [...p, {id:genId(), ...txn}]);
  const openVehicle = vehicles.find(v => v.id === openId);
  const totalBal = accounts.reduce((s,a) => s + getBalance(a.id, transactions), 0);
  const totalPending = vehicles.reduce((s,v) => s + calcVehicle(v,transactions).totalSaleBalance, 0);

  const exportData = () => exportAllData({ vehicles, customers, suppliers, accounts, transactions, labourers, categories: expenseCategories });
  const importCallbacks = { setVehicles, setCustomers, setSuppliers, setAccounts, setTransactions, setLabourers, setExpenseCategories };

  const navItems=[
    {id:"projects",       label:"🚛 Projects"},
    {id:"customers",      label:"👤 Customers"},
    {id:"suppliers",      label:"🏭 Suppliers"},
    {id:"accounts",       label:"💰 Accounts"},
    {id:"salaries",       label:"👷 Salaries"},
    {id:"batch_receipt",  label:"📥 Batch Receipt"},
    {id:"reports",        label:"📋 Reports"},
  ];

  // Show app after 10s even if some data didn't load (prevents black screen)
  const [forceShow, setForceShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setForceShow(true), 10000);
    return () => clearTimeout(t);
  }, []);

  if (!allLoaded && !forceShow) return <LoadingScreen />;

  const pageTitles = {
    projects: "🚛 Projects", customers: "👤 Customers", suppliers: "🏭 Suppliers",
    accounts: "💰 Accounts", salaries: "👷 Salaries", batch_receipt: "📥 Batch Receipt",
    reports: "📋 Reports", more: "⚙️ More"
  };

  // Bottom nav: show 5 most used + More
  const bottomNav = [
    {id:"projects", icon:"🚛", label:"Projects"},
    {id:"customers", icon:"👤", label:"Customers"},
    {id:"accounts", icon:"💰", label:"Accounts"},
    {id:"salaries", icon:"👷", label:"Salaries"},
    {id:"more", icon:"☰", label:"More"},
  ];

  const [showMore, setShowMore] = useState(false);

  const navigate = (id) => {
    setPage(id); setOpenId(null); setShowMore(false);
  };

  return(
    <>
      <style>{css}</style>

      {/* ── TOP HEADER ── */}
      <div className="top-header no-print">
        {openVehicle ? (
          <button onClick={()=>setOpenId(null)}
            style={{background:"transparent",color:C.amber,fontSize:22,padding:"4px 8px 4px 0",minHeight:44,marginRight:4}}>‹</button>
        ) : null}
        <div style={{fontSize:17,fontWeight:800,color:C.amber,letterSpacing:"-0.02em",flex:1}}>
          {openVehicle ? `🚛 ${openVehicle.vehicleNo}` : pageTitles[page] || "ChickenFlow"}
        </div>
        {/* Balance shown in header */}
        <div style={{fontSize:12,color:totalBal>=0?C.green:C.red,fontWeight:700,marginRight:8}} className="mono">
          {fmtRs(totalBal)}
        </div>
        {/* Desktop nav */}
        <div className="top-nav-desktop" style={{gap:4,alignItems:"center"}}>
          {navItems.map(item=>(
            <button key={item.id} onClick={()=>navigate(item.id)}
              style={{background:page===item.id?C.amberSoft:"transparent",color:page===item.id?C.amber:C.muted,
                border:page===item.id?`1px solid ${C.amber}44`:"1px solid transparent",
                padding:"5px 10px",borderRadius:8,fontWeight:600,fontSize:12,whiteSpace:"nowrap",minHeight:36}}>
              {item.label}
            </button>
          ))}
          <BackupPanel autoBackupMinutes={autoBackupMinutes} setAutoBackupMinutes={setAutoBackupMinutes}
            importCallbacks={importCallbacks} onExport={exportData}/>
          <button onClick={()=>signOut(auth)}
            style={{background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,
              padding:"5px 10px",borderRadius:8,fontSize:11,fontWeight:600,minHeight:36}}>
            Sign Out
          </button>
        </div>
      </div>

      {/* ── MORE DRAWER (mobile) ── */}
      {showMore && (
        <div style={{position:"fixed",inset:0,zIndex:200}} onClick={()=>setShowMore(false)}>
          <div style={{position:"absolute",bottom:"calc(62px + env(safe-area-inset-bottom))",left:0,right:0,
            background:C.card,borderTop:`1px solid ${C.border}`,borderRadius:"16px 16px 0 0",padding:16}}
            onClick={e=>e.stopPropagation()}>
            <div style={{width:36,height:4,background:C.border,borderRadius:2,margin:"0 auto 16px"}}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              {[
                {id:"suppliers",icon:"🏭",label:"Suppliers"},
                {id:"batch_receipt",icon:"📥",label:"Batch Receipt"},
                {id:"reports",icon:"📋",label:"Reports"},
              ].map(item=>(
                <button key={item.id} onClick={()=>navigate(item.id)}
                  style={{background:page===item.id?C.amberSoft:C.card2,
                    color:page===item.id?C.amber:C.text,border:`1px solid ${page===item.id?C.amber+"44":C.border}`,
                    borderRadius:12,padding:"14px 12px",fontSize:14,fontWeight:600,
                    display:"flex",alignItems:"center",gap:8,minHeight:52}}>
                  <span style={{fontSize:20}}>{item.icon}</span>{item.label}
                </button>
              ))}
            </div>
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:12,display:"flex",flexDirection:"column",gap:8}}>
              <div style={{fontSize:12,color:C.muted,marginBottom:4}}>{userEmail}</div>
              <div style={{display:"flex",gap:8}}>
                <BackupPanel autoBackupMinutes={autoBackupMinutes} setAutoBackupMinutes={setAutoBackupMinutes}
                  importCallbacks={importCallbacks} onExport={exportData}/>
                <button onClick={()=>signOut(auth)}
                  style={{flex:1,background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,
                    padding:"10px",borderRadius:10,fontSize:13,fontWeight:600}}>
                  🚪 Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PAGE CONTENT ── */}
      <div className="page-content">
        {page==="projects"&&!openVehicle&&<Dashboard vehicles={vehicles} transactions={transactions} onOpen={id=>setOpenId(id)} onNew={()=>setShowNew(true)}/>}
        {page==="projects"&&openVehicle&&(
          <VehicleDetail vehicle={openVehicle} setVehicles={setVehicles}
            suppliers={suppliers} customers={customers} accounts={accounts}
            labourers={labourers} addTxn={addTxn} expenseCategories={expenseCategories}
            transactions={transactions} onBack={()=>setOpenId(null)}/>
        )}
        {page==="customers"&&<CustomersPage customers={customers} setCustomers={setCustomers}/>}
        {page==="suppliers"&&<SuppliersPage suppliers={suppliers} setSuppliers={setSuppliers}/>}
        {page==="accounts"&&<AccountsPage accounts={accounts} setAccounts={setAccounts}
          transactions={transactions} setTransactions={setTransactions}
          expenseCategories={expenseCategories} setExpenseCategories={setExpenseCategories}
          vehicles={vehicles}/>}
        {page==="salaries"&&<SalariesPage labourers={labourers} setLabourers={setLabourers}
          accounts={accounts} transactions={transactions} setTransactions={setTransactions}
          vehicles={vehicles}/>}
        {page==="batch_receipt"&&<BatchReceiptPage vehicles={vehicles} setVehicles={setVehicles}
          customers={customers} accounts={accounts} labourers={labourers} addTxn={addTxn}/>}
        {page==="reports"&&<ReportsPage vehicles={vehicles} customers={customers} suppliers={suppliers} transactions={transactions}/>}
        {page==="more"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {[
              {id:"suppliers",icon:"🏭",label:"Suppliers",desc:"Manage your suppliers"},
              {id:"batch_receipt",icon:"📥",label:"Batch Receipt",desc:"Record multiple receipts"},
              {id:"reports",icon:"📋",label:"Reports",desc:"View business reports"},
            ].map(item=>(
              <button key={item.id} onClick={()=>navigate(item.id)}
                style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,
                  padding:"16px",display:"flex",alignItems:"center",gap:14,textAlign:"left",width:"100%",minHeight:64}}>
                <span style={{fontSize:28}}>{item.icon}</span>
                <div>
                  <div style={{fontSize:15,fontWeight:700,color:C.text}}>{item.label}</div>
                  <div style={{fontSize:12,color:C.muted}}>{item.desc}</div>
                </div>
                <span style={{marginLeft:"auto",color:C.muted,fontSize:18}}>›</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── BOTTOM NAV (mobile only) ── */}
      <nav className="bottom-nav no-print">
        {bottomNav.map(item=>(
          <button key={item.id} className="bottom-nav-item"
            onClick={()=>item.id==="more"?setShowMore(s=>!s):navigate(item.id)}
            style={{color:(page===item.id||(item.id==="more"&&showMore))?C.amber:C.muted}}>
            <span className="bottom-nav-icon">{item.icon}</span>
            <span className="bottom-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {showNew&&<NewVehicleModal suppliers={suppliers} onClose={()=>setShowNew(false)}
        onCreate={v=>{setVehicles(p=>[v,...p]);setOpenId(v.id);setPage("projects");}}/>}
    </>
  );
}
