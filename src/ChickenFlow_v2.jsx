import React, { useState, useRef, useMemo, useEffect, useCallback } from "react";

// ─── FIREBASE CONFIG ─ Replace with your own from Firebase Console ──────────
const firebaseConfig = {
  apiKey: "AIzaSyDcoWautL9x8jhmrOvZc8n6CYL_csWskU0",
  authDomain: "chickenflow-a3cf2.firebaseapp.com",
  projectId: "chickenflow-a3cf2",
  storageBucket: "chickenflow-a3cf2.firebasestorage.app",
  messagingSenderId: "264036211412",
  appId: "1:264036211412:web:13436225e08ef36a42b941"
};

// Firebase loaded lazily to prevent startup crash
let auth = null;
let db = null;
let _fbLoaded = false;

async function loadFirebase() {
  if (_fbLoaded) return true;
  try {
    const [{ initializeApp, getApps }, { getAuth }, { getFirestore }] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
      import("firebase/firestore"),
    ]);
    const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
    auth = getAuth(app);
    db = getFirestore(app);
    _fbLoaded = true;
    return true;
  } catch(e) {
    console.error("Firebase load failed:", e);
    return false;
  }
}

async function fbSignIn(email, password) {
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  return signInWithEmailAndPassword(auth, email, password);
}
async function fbRegister(email, password) {
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  return createUserWithEmailAndPassword(auth, email, password);
}
async function fbSignOut() {
  const { signOut } = await import("firebase/auth");
  return signOut(auth);
}
async function fbOnSnapshot(uid, key, callback) {
  const { doc, onSnapshot } = await import("firebase/firestore");
  const ref = doc(db, "users", uid, "data", key);
  return onSnapshot(ref, callback, (err) => { console.error("snapshot err:", err); callback(null); });
}
async function fbSetDoc(uid, key, value) {
  const { doc, setDoc } = await import("firebase/firestore");
  const ref = doc(db, "users", uid, "data", key);
  return setDoc(ref, { value }, { merge: true });
}


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
function loadJsPDF(){return new Promise(resolve=>{if(window.jspdf)return resolve(window.jspdf.jsPDF);const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";s.onload=()=>resolve(window.jspdf.jsPDF);document.head.appendChild(s);});}
function loadHtml2Canvas(){return new Promise(resolve=>{if(window.html2canvas)return resolve(window.html2canvas);const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";s.onload=()=>resolve(window.html2canvas);document.head.appendChild(s);});}

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
  const transferWt=v.transfers.filter(x=>x.direction!=="in").reduce((s,x)=>s+n(x.weight),0);
  const transferIn=v.transfers.filter(x=>x.direction==="in").reduce((s,x)=>s+n(x.weight),0);
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
  const receivedAdj=received+transferIn;
  const remainingAdj=receivedAdj-soldWt-transferWt;
  return{purchased,transitLoss,received:receivedAdj,soldWt,transferWt,remaining:remainingAdj,transferIn,
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
// ── Theme palettes (dark + light) ─────────────────────────────
const THEMES={
  dark:{
    bg:"#080B12",card:"#101420",card2:"#161D2E",card3:"#1C2438",
    border:"#232D42",text:"#D9E4F5",muted:"#4E5E7A",
    amber:"#F59E0B",amberD:"#B45309",amberSoft:"#F59E0B18",
    green:"#22C55E",greenSoft:"#22C55E18",
    red:"#EF4444",redSoft:"#EF444418",
    blue:"#60A5FA",blueSoft:"#60A5FA18",
    purple:"#A78BFA",purpleSoft:"#A78BFA18",
    teal:"#2DD4BF",tealSoft:"#2DD4BF18",
    orange:"#FB923C",orangeSoft:"#FB923C18",
  },
  light:{
    bg:"#F0F2F8",card:"#FFFFFF",card2:"#E8ECF6",card3:"#DDE3F0",
    border:"#C8D0E8",text:"#1A2035",muted:"#64748B",
    amber:"#D97706",amberD:"#92400E",amberSoft:"#D9770615",
    green:"#16A34A",greenSoft:"#16A34A15",
    red:"#DC2626",redSoft:"#DC262615",
    blue:"#2563EB",blueSoft:"#2563EB15",
    purple:"#7C3AED",purpleSoft:"#7C3AED15",
    teal:"#0D9488",tealSoft:"#0D948815",
    orange:"#EA580C",orangeSoft:"#EA580C15",
  },
};
let C=THEMES.dark;  // overwritten at runtime by useTheme()

// ── Haptic feedback ───────────────────────────────────────────
function haptic(type="light"){
  try{
    if(!navigator.vibrate) return;
    if(type==="light")   navigator.vibrate(10);
    else if(type==="medium")  navigator.vibrate(25);
    else if(type==="heavy")   navigator.vibrate([20,30,20]);
    else if(type==="success") navigator.vibrate([10,50,10]);
    else if(type==="error")   navigator.vibrate([30,20,30,20,30]);
  }catch(e){}
}

// ── SwipeCard: swipe-left reveals Edit/Delete ─────────────────
function SwipeCard({onEdit,onDelete,children,disabled=false}){
  const [offset,setOffset]=React.useState(0);
  const startX=React.useRef(null);
  const REVEAL=onEdit&&onDelete?140:70;

  const ts=e=>{ if(!disabled) startX.current=e.touches[0].clientX; };
  const tm=e=>{
    if(startX.current===null) return;
    const dx=e.touches[0].clientX-startX.current;
    if(dx<0) setOffset(Math.max(dx,-REVEAL));
  };
  const te=()=>{
    const triggered=offset<-REVEAL*0.45;
    setOffset(triggered?-REVEAL:0);
    if(triggered) haptic("light");
    startX.current=null;
  };
  const close=()=>setOffset(0);

  return(
    <div style={{position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",right:0,top:0,bottom:0,display:"flex",zIndex:0}}>
        {onEdit&&<button onClick={()=>{close();onEdit();haptic("light");}}
          style={{width:70,background:"#2563EB",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2}}>
          <span style={{fontSize:18}}>✏️</span>Edit
        </button>}
        {onDelete&&<button onClick={()=>{close();onDelete();haptic("error");}}
          style={{width:70,background:"#DC2626",color:"#fff",border:"none",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2}}>
          <span style={{fontSize:18}}>🗑</span>Del
        </button>}
      </div>
      <div onTouchStart={ts} onTouchMove={tm} onTouchEnd={te}
        onClick={offset<0?close:undefined}
        style={{transform:`translateX(${offset}px)`,transition:startX.current?"none":"transform 0.2s ease",position:"relative",zIndex:1}}>
        {children}
      </div>
    </div>
  );
}
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
  @keyframes spin{to{transform:rotate(360deg)}}
  body{transition:background 0.3s,color 0.3s;}
  *{-webkit-tap-highlight-color:transparent;}
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
  <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 8px"}}>
    <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
    <div className="mono" style={{fontSize:13,fontWeight:700,color:color||C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{value}</div>
    {sub&&<div style={{fontSize:9,color:C.muted,marginTop:2}}>{sub}</div>}
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
  const [catBudget,setCatBudget]=useState("");
  const [budgetMonth,setBudgetMonth]=useState(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;});
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
  // Normalise category: always {name, budget}
  const normCat=c=>typeof c==="string"?{name:c,budget:0}:c;
  const addCategory=()=>{
    if(!catInput.trim()) return;
    setExpenseCategories(p=>[...p,{name:catInput.trim(),budget:n(catBudget)||0}]);
    setCatInput(""); setCatBudget("");
  };
  const updateCatBudget=(i,newBudget)=>{
    setExpenseCategories(p=>p.map((c,idx)=>idx===i?{...normCat(c),budget:n(newBudget)||0}:normCat(c)));
  };
  const deleteCategory=(i)=>setExpenseCategories(p=>p.filter((_,j)=>j!==i).map(normCat));
  const filteredTxns=useMemo(()=>{
    const t=[...transactions].sort((a,b)=>b.date.localeCompare(a.date));
    if(selAccId==="all") return t;
    return t.filter(t=>t.debitAccountId===selAccId||t.creditAccountId===selAccId);
  },[transactions,selAccId]);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12}}>
        <div><h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>💰 Accounts & Ledger</h1>
          <p style={{color:C.muted,fontSize:13}}>Total Balance: <span className="mono" style={{color:totalBalance>=0?C.green:C.red,fontWeight:700}}>{fmtRs(totalBalance)}</span></p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <Btn color="teal"   onClick={()=>{setForm({date:today()});setModal("transfer");}}>⇄ Transfer</Btn>
          <Btn color="green"  onClick={()=>{setForm({date:today()});setModal("income");}}>+ Income</Btn>
          <Btn color="red"    onClick={()=>{setForm({date:today()});setModal("expense");}}>− Expense</Btn>
          <Btn color="ghost"  onClick={()=>setModal("category")}>📋 Budget</Btn>
          <Btn color="amber"  onClick={()=>{setForm({type:"bank"});setModal("addAccount");}}>+ Add Account</Btn>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
          <Fld label="Category"><select value={form.category||""} onChange={f("category")}><option value="">— Category —</option>{expenseCategories.map((c,i)=>{const nc=normCat(c);return <option key={i} value={nc.name}>{nc.name}</option>;})}</select></Fld>
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
        <Modal title="📋 Categories & Budget Tracker" onClose={close} noFooter width={580}>
          {/* Month selector */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:18,flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.muted,fontWeight:700}}>Budget Month:</span>
            <input type="month" value={budgetMonth} onChange={e=>setBudgetMonth(e.target.value)}
              style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 10px",color:C.text,fontSize:13,fontWeight:700,outline:"none"}}/>
            <button onClick={()=>{const d=new Date();setBudgetMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`)}}
              style={{background:C.amberSoft,color:C.amber,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>This Month</button>
          </div>

          {/* Budget summary totals */}
          {(()=>{
            const [y,m]=budgetMonth.split("-").map(Number);
            const monthStart=`${budgetMonth}-01`;
            const monthEnd=`${budgetMonth}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`;
            const monthTxns=transactions.filter(t=>!t.voided&&t.date>=monthStart&&t.date<=monthEnd&&(t.type==="expense"||t.type==="vehicle_exp"||t.type==="general_expense"));
            const totalBudget=expenseCategories.reduce((s,c)=>s+n(normCat(c).budget),0);
            const totalSpent=monthTxns.reduce((s,t)=>s+n(t.amount),0);
            if(totalBudget>0) return(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:18}}>
                {[["💰 Total Budget",fmtRs(totalBudget),C.blue],["💸 Spent",fmtRs(totalSpent),totalSpent>totalBudget?C.red:C.orange],["✅ Remaining",fmtRs(Math.max(0,totalBudget-totalSpent)),totalSpent>totalBudget?C.red:C.green]].map(([l,v,c])=>(
                  <div key={l} style={{background:C.card2,borderRadius:10,padding:"10px 14px",textAlign:"center",border:`1px solid ${c}44`}}>
                    <div style={{fontSize:10,color:C.muted,fontWeight:700,marginBottom:4}}>{l}</div>
                    <div className="mono" style={{fontSize:14,fontWeight:800,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            );
            return null;
          })()}

          {/* Per-category budget rows */}
          <div style={{marginBottom:16,maxHeight:380,overflowY:"auto"}}>
            {expenseCategories.length===0&&<div style={{color:C.muted,fontSize:13,textAlign:"center",padding:20}}>No categories yet. Add one below.</div>}
            {expenseCategories.map((c,i)=>{
              const nc=normCat(c);
              const [y,m]=budgetMonth.split("-").map(Number);
              const monthStart=`${budgetMonth}-01`;
              const monthEnd=`${budgetMonth}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`;
              const spent=transactions.filter(t=>!t.voided&&t.date>=monthStart&&t.date<=monthEnd&&(t.category===nc.name||t.type==="vehicle_exp")).reduce((s,t)=>t.category===nc.name||t.description?.toLowerCase().includes(nc.name.toLowerCase())?s+n(t.amount):s,0);
              const budget=nc.budget||0;
              const pct=budget>0?Math.min(100,Math.round(spent/budget*100)):0;
              const over=budget>0&&spent>budget;
              return(
                <div key={i} style={{background:C.card2,border:`1px solid ${over?C.red+"44":C.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontWeight:700,fontSize:13}}>{nc.name}</span>
                      {over&&<span style={{fontSize:10,background:C.redSoft,color:C.red,border:`1px solid ${C.red}44`,borderRadius:10,padding:"1px 7px",fontWeight:700}}>OVER BUDGET</span>}
                    </div>
                    <button onClick={()=>deleteCategory(i)} style={{background:"transparent",color:C.red,fontSize:13,border:`1px solid ${C.red}44`,borderRadius:6,padding:"2px 8px",cursor:"pointer"}}>✕ Remove</button>
                  </div>
                  <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:budget>0?8:0}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,color:C.muted,marginBottom:3}}>Monthly Budget (Rs) — leave 0 for no limit</div>
                      <input type="number" value={nc.budget||""} placeholder="0 = no budget"
                        onChange={e=>updateCatBudget(i,e.target.value)}
                        style={{width:"100%",background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 10px",color:C.text,fontSize:13,outline:"none"}}/>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:10,color:C.muted,marginBottom:2}}>Spent this month</div>
                      <div className="mono" style={{fontSize:14,fontWeight:800,color:over?C.red:spent>0?C.orange:C.muted}}>{fmtRs(spent)}</div>
                    </div>
                  </div>
                  {budget>0&&(
                    <div>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:10,color:C.muted}}>{fmtRs(spent)} of {fmtRs(budget)}</span>
                        <span style={{fontSize:10,fontWeight:700,color:over?C.red:pct>75?C.orange:C.green}}>{pct}%</span>
                      </div>
                      <div style={{background:C.card,borderRadius:20,height:6,overflow:"hidden"}}>
                        <div style={{width:pct+"%",height:"100%",background:over?C.red:pct>75?C.orange:C.green,borderRadius:20,transition:"width 0.3s"}}/>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add new category */}
          <div style={{borderTop:`1px solid ${C.border}`,paddingTop:14}}>
            <div style={{fontSize:12,color:C.muted,fontWeight:700,marginBottom:8}}>ADD NEW CATEGORY</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <input value={catInput} onChange={e=>setCatInput(e.target.value)} placeholder="Category name e.g. Fuel"
                onKeyDown={e=>e.key==="Enter"&&addCategory()}
                style={{flex:2,minWidth:120,padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13,outline:"none"}}/>
              <input type="number" value={catBudget} onChange={e=>setCatBudget(e.target.value)} placeholder="Budget Rs (optional)"
                style={{flex:1,minWidth:100,padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13,outline:"none"}}/>
              <Btn color="amber" onClick={addCategory}>Add</Btn>
            </div>
          </div>
          <div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}><Btn color="ghost" onClick={close}>Close</Btn></div>
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
  const [labTab,setLabTab]=useState("summary");
  const [attMonth,setAttMonth]=useState(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;});
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const close=()=>{setModal(null);setForm({});setSelLabourer(null);};

  // ── Attendance helpers ──
  const markAttendance=(labId,date,status)=>{
    setLabourers(p=>p.map(l=>{
      if(l.id!==labId) return l;
      const att={...(l.attendance||{})};
      if(status==="none") delete att[date]; else att[date]=status;
      return {...l,attendance:att};
    }));
  };
  const getMonthDays=(ym)=>{
    const [y,m]=ym.split("-").map(Number);
    const days=[];
    const daysInMonth=new Date(y,m,0).getDate();
    for(let d=1;d<=daysInMonth;d++) days.push(`${ym}-${String(d).padStart(2,"0")}`);
    return days;
  };
  const calcAttendanceSummary=(labourer,ym)=>{
    const att=labourer.attendance||{};
    const days=getMonthDays(ym);
    const dailyRate=getSalaryRateForDate(labourer,ym+"-01")/30;
    let present=0,absent=0,halfDay=0,earned=0;
    days.forEach(d=>{
      const s=att[d];
      if(s==="P"){present++;earned+=dailyRate;}
      else if(s==="A") absent++;
      else if(s==="H"){halfDay++;earned+=dailyRate*0.5;}
    });
    const marked=days.filter(d=>att[d]).length;
    return {present,absent,halfDay,earned,marked,total:days.length,days,dailyRate};
  };

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
      <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12}}>
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
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
            <Btn color="ghost" onClick={()=>{setViewId(null);setLabTab("summary");}}>← Back</Btn>
            <span style={{fontSize:18,fontWeight:800}}>{viewLabourer.name}</span>
            {viewLabourer.role&&<Tag color={C.blue}>{viewLabourer.role}</Tag>}
          </div>
          {/* Tab bar */}
          <div style={{display:"flex",gap:2,marginBottom:20,background:C.card,padding:4,borderRadius:10,border:`1px solid ${C.border}`,width:"fit-content"}}>
            {[["summary","📊 Summary"],["attendance","📋 Attendance"],["payments","💸 Payments"]].map(([id,label])=>(
              <button key={id} onClick={()=>setLabTab(id)} style={{padding:"7px 14px",borderRadius:20,background:labTab===id?C.amber:"transparent",color:labTab===id?"#000":C.muted,border:"none",fontWeight:labTab===id?700:500,fontSize:12,whiteSpace:"nowrap",cursor:"pointer",minHeight:34}}>{label}</button>
            ))}
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
                {/* ── SUMMARY TAB ── */}
                {labTab==="summary"&&<div>
                {/* Stats */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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

                </div>}

                {/* ── ATTENDANCE TAB ── */}
                {labTab==="attendance"&&(()=>{
                  const att=viewLabourer.attendance||{};
                  const summary=calcAttendanceSummary(viewLabourer,attMonth);
                  const STATUS_CONFIG={P:{label:"P",full:"Present",bg:C.greenSoft,color:C.green,border:C.green+"44"},A:{label:"A",full:"Absent",bg:C.redSoft,color:C.red,border:C.red+"44"},H:{label:"H",full:"Half Day",bg:C.orangeSoft,color:C.orange,border:C.orange+"44"}};
                  const [y,m]=attMonth.split("-").map(Number);
                  const firstDayOfWeek=new Date(y,m-1,1).getDay();
                  const DOW=["Su","Mo","Tu","We","Th","Fr","Sa"];

                  return(
                    <div>
                      {/* Month navigator */}
                      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
                        <button onClick={()=>{const d=new Date(attMonth+"-01");d.setMonth(d.getMonth()-1);setAttMonth(d.toISOString().slice(0,7));}} style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.muted,cursor:"pointer",fontSize:13}}>← Prev</button>
                        <input type="month" value={attMonth} onChange={e=>setAttMonth(e.target.value)} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.text,fontSize:14,fontWeight:700,outline:"none"}}/>
                        <button onClick={()=>{const d=new Date(attMonth+"-01");d.setMonth(d.getMonth()+1);setAttMonth(d.toISOString().slice(0,7));}} style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.muted,cursor:"pointer",fontSize:13}}>Next →</button>
                        <button onClick={()=>{const d=new Date();setAttMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);}} style={{background:C.amberSoft,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"7px 12px",color:C.amber,cursor:"pointer",fontSize:12,fontWeight:700}}>This Month</button>
                      </div>

                      {/* Summary row */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
                        {[["✅ Present",summary.present,C.green],["❌ Absent",summary.absent,C.red],["½ Half Day",summary.halfDay,C.orange],["💰 Earned",fmtRs(Math.round(summary.earned)),C.amber]].map(([l,v,c])=>(
                          <div key={l} style={{background:C.card,border:`1px solid ${c}44`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
                            <div style={{fontSize:10,color:C.muted,fontWeight:700,marginBottom:4}}>{l}</div>
                            <div className="mono" style={{fontSize:15,fontWeight:800,color:c}}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:11,color:C.muted,marginBottom:12,textAlign:"right"}}>{summary.marked} of {summary.total} days marked · Daily rate: {fmtRs(Math.round(summary.dailyRate))}/day</div>

                      {/* Legend */}
                      <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap"}}>
                        {Object.entries(STATUS_CONFIG).map(([k,v])=>(
                          <div key={k} style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}>
                            <div style={{width:22,height:22,background:v.bg,border:`1px solid ${v.border}`,borderRadius:5,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:11,color:v.color}}>{v.label}</div>
                            <span style={{color:C.muted}}>{v.full}</span>
                          </div>
                        ))}
                        <div style={{display:"flex",alignItems:"center",gap:5,fontSize:12}}>
                          <div style={{width:22,height:22,background:C.card2,border:`1px solid ${C.border}`,borderRadius:5}}/>
                          <span style={{color:C.muted}}>Not marked</span>
                        </div>
                      </div>

                      {/* Calendar grid */}
                      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:14}}>
                        {/* Day of week headers */}
                        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginBottom:6}}>
                          {DOW.map(d=><div key={d} style={{textAlign:"center",fontSize:10,color:C.muted,fontWeight:700,padding:"4px 0"}}>{d}</div>)}
                        </div>
                        {/* Empty cells for first week offset */}
                        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
                          {Array(firstDayOfWeek).fill(null).map((_,i)=><div key={"e"+i}/>)}
                          {summary.days.map(dateStr=>{
                            const dayNum=parseInt(dateStr.split("-")[2]);
                            const status=att[dateStr];
                            const cfg=status?STATUS_CONFIG[status]:null;
                            const isToday=dateStr===today();
                            const isFuture=dateStr>today();
                            return(
                              <div key={dateStr} style={{position:"relative"}}>
                                <button
                                  disabled={isFuture}
                                  onClick={()=>{
                                    const next=!status?"P":status==="P"?"A":status==="A"?"H":"none";
                                    markAttendance(viewLabourer.id,dateStr,next);
                                  }}
                                  style={{width:"100%",aspectRatio:"1",background:cfg?cfg.bg:C.card2,border:`2px solid ${isToday?C.amber:cfg?cfg.border:C.border}`,borderRadius:8,cursor:isFuture?"not-allowed":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,opacity:isFuture?0.3:1,transition:"all 0.15s"}}>
                                  <div style={{fontSize:11,color:isToday?C.amber:C.muted,fontWeight:isToday?800:500}}>{dayNum}</div>
                                  {cfg&&<div style={{fontSize:10,fontWeight:800,color:cfg.color}}>{cfg.label}</div>}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div style={{marginTop:10,fontSize:11,color:C.muted,textAlign:"center"}}>Tap a day to cycle: Not marked → Present → Absent → Half Day → Not marked</div>
                    </div>
                  );
                })()}

                {/* ── PAYMENTS TAB ── */}
                {labTab==="payments"&&<div>
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
                </div>}
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
    setCustomers(p=>[{id:genId(),...form,defaultRate:n(form.defaultRate),openingBalance:n(form.openingBalance),creditLimit:n(form.creditLimit)||0,createdAt:today()},...p]);
    setModal(null);setForm({});
  };
  const saveEditCustomer=()=>{
    setCustomers(p=>p.map(c=>c.id===selCustomer.id?{...c,defaultRate:n(form.defaultRate),openingBalance:n(form.openingBalance),creditLimit:n(form.creditLimit)||0}:c));
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
      <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>👤 Customers</h1>
          <p style={{color:C.muted,fontSize:13}}>
            {customers.length} customers
            {totalOpeningBal>0&&<span style={{marginLeft:12,color:C.orange}}>· Opening Bal: {fmtRs(totalOpeningBal)}</span>}
          </p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <Btn color="amber" full onClick={()=>{setForm({});setModal("add");}}>+ Add Customer</Btn>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <Btn color="ghost" onClick={downloadTemplate}>⬇ Template</Btn>
            <Btn color="blue" onClick={()=>setModal("import")}>📥 Import</Btn>
            <Btn color="teal" onClick={openBatchBalance}>💰 Balances</Btn>
            <Btn color="purple" onClick={openBatchRate}>✏️ Rates</Btn>
          </div>
        </div>
      </div>
      <div style={{marginBottom:14}}><input placeholder="🔍  Search by name or city…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:340}}/></div>
      {customers.length===0?<Empty icon="👤" text="No customers yet."/>:(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Name","Phone","City","Default Rate","Credit Limit","Balance Status","Action"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
            <tbody>{filtered.map(cu=>(
              <tr key={cu.id}>
                <TD bold>{cu.name}{cu.creditLimit>0&&<span style={{marginLeft:6,fontSize:10,background:C.blueSoft,color:C.blue,padding:"1px 6px",borderRadius:10,fontWeight:700}}>LIMIT</span>}</TD>
                <TD color={C.muted}>{cu.phone||"—"}</TD>
                <TD color={C.muted}>{cu.city||"—"}</TD>
                <TD><span className="mono" style={{color:cu.defaultRate?C.amber:C.muted,fontWeight:700}}>{cu.defaultRate?`Rs.${fmt(cu.defaultRate)}/kg`:"Not set"}</span></TD>
                <TD>{cu.creditLimit>0?<span className="mono" style={{color:C.blue,fontWeight:700}}>{fmtRs(cu.creditLimit)}</span>:<span style={{color:C.muted,fontSize:12}}>No limit</span>}</TD>
                <TD>{(()=>{
                  if(!cu.creditLimit||cu.creditLimit<=0) return <span style={{color:C.muted,fontSize:12}}>—</span>;
                  const due=vehicles.reduce((s,v)=>s+v.sales.filter(sl=>sl.customerId===cu.id).reduce((ss,sl)=>{const col=(sl.receipts||[]).reduce((a,r)=>a+n(r.amount),0);return ss+Math.max(0,sl.totalAmount-col);},0),0)+(n(cu.openingBalance)||0);
                  const pct=Math.min(100,Math.round(due/cu.creditLimit*100));
                  const over=due>cu.creditLimit;
                  return <div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:11,color:over?C.red:C.muted}}>{over?"⚠️ OVER LIMIT":"Within limit"}</span>
                      <span className="mono" style={{fontSize:11,color:over?C.red:C.green,fontWeight:700}}>{pct}%</span>
                    </div>
                    <div style={{background:C.card2,borderRadius:20,height:5,overflow:"hidden"}}>
                      <div style={{width:pct+"%",height:"100%",background:over?C.red:pct>75?C.orange:C.green,borderRadius:20,transition:"width 0.3s"}}/>
                    </div>
                  </div>;
                })()}</TD>
                <TD>
                  <div style={{display:"flex",gap:6}}>
                    <Btn small color="ghost" onClick={()=>{setSelCustomer(cu);setForm({defaultRate:cu.defaultRate||"",openingBalance:cu.openingBalance||"",creditLimit:cu.creditLimit||""});setModal("editCustomer");}}>Edit</Btn>
                    <button onClick={()=>{if(window.confirm(`Delete customer "${cu.name}"? This cannot be undone.`))setCustomers(p=>p.filter(c=>c.id!==cu.id));}} style={{background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:700,cursor:"pointer"}}>🗑</button>
                  </div>
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
          <Fld label="Credit Limit (Rs) — 0 = No Limit" half><input type="number" value={form.creditLimit||""} onChange={f("creditLimit")} placeholder="e.g. 500000"/></Fld>
        </div>
        {n(form.openingBalance)>0&&(
          <div style={{background:C.orangeSoft,border:`1px solid ${C.orange}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.orange,marginTop:4}}>
            💰 This customer starts with a previous balance of <strong>{fmtRs(n(form.openingBalance))}</strong> — it will be added to their total receivable.
          </div>
        )}
        {n(form.creditLimit)>0&&(
          <div style={{background:C.blueSoft,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.blue,marginTop:4}}>
            🔒 Credit limit set to <strong>{fmtRs(n(form.creditLimit))}</strong> — a warning will show when this customer's balance exceeds this amount.
          </div>
        )}
      </Modal>)}

      {/* ── EDIT CUSTOMER ── */}
      {modal==="editCustomer"&&selCustomer&&(
        <Modal title={`Edit — ${selCustomer.name}`} onSave={saveEditCustomer} saveLabel="Save" onClose={()=>setModal(null)} width={500}>
          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
            <Fld label="Default Rate (Rs/kg)" half><input type="number" value={form.defaultRate||""} onChange={f("defaultRate")} placeholder="e.g. 420" autoFocus/></Fld>
            <Fld label="Opening Balance (Rs)" half><input type="number" value={form.openingBalance||""} onChange={f("openingBalance")} placeholder="Previous due balance"/></Fld>
            <Fld label="Credit Limit (Rs) — 0 = No Limit" half><input type="number" value={form.creditLimit||""} onChange={f("creditLimit")} placeholder="0 = unlimited"/></Fld>
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
function SuppliersPage({suppliers,setSuppliers,vehicles}){
  const [modal,setModal]=useState(false);
  const [form,setForm]=useState({});
  const [viewId,setViewId]=useState(null);
  const [editMode,setEditMode]=useState(false);
  const [search,setSearch]=useState("");
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));

  // Build per-supplier stats from all vehicles
  const supStats=useMemo(()=>{
    const map={};
    (vehicles||[]).forEach(v=>{
      v.purchases.forEach(p=>{
        const sid=p.supplierId||p.supplierName;
        if(!map[sid]) map[sid]={supplierId:sid,supplierName:p.supplierName,purchases:[],totalWt:0,totalAmt:0,totalPaid:0,rates:[]};
        const amt=n(p.weight)*n(p.rate);
        const paid=(p.payments||[]).reduce((s,r)=>s+n(r.amount),0);
        map[sid].purchases.push({...p,vehicleNo:v.vehicleNo,vehicleId:v.id,amt,paid,bal:amt-paid});
        map[sid].totalWt+=n(p.weight);
        map[sid].totalAmt+=amt;
        map[sid].totalPaid+=paid;
        if(n(p.rate)>0) map[sid].rates.push({date:p.date,rate:n(p.rate),weight:n(p.weight)});
      });
    });
    Object.values(map).forEach(s=>{
      s.avgRate=s.rates.length?s.rates.reduce((a,r)=>a+r.rate,0)/s.rates.length:0;
      s.minRate=s.rates.length?Math.min(...s.rates.map(r=>r.rate)):0;
      s.maxRate=s.rates.length?Math.max(...s.rates.map(r=>r.rate)):0;
      s.balance=s.totalAmt-s.totalPaid;
      s.rates.sort((a,b)=>a.date.localeCompare(b.date));
    });
    return map;
  },[vehicles]);

  const allRates=Object.values(supStats).filter(s=>s.avgRate>0);
  const globalMin=allRates.length?Math.min(...allRates.map(s=>s.minRate)):0;
  const globalMax=allRates.length?Math.max(...allRates.map(s=>s.maxRate)):0;
  const bestSupId=allRates.length?allRates.reduce((a,b)=>a.avgRate<b.avgRate?a:b).supplierId:null;

  const save=()=>{
    if(!form.name) return alert("Name required");
    if(editMode&&viewId){
      setSuppliers(p=>p.map(s=>s.id===viewId?{...s,...form}:s));
      setEditMode(false);
    } else {
      setSuppliers(p=>[{id:genId(),...form,createdAt:today()},...p]);
      setModal(false);setForm({});
    }
  };

  const filtered=suppliers.filter(s=>!search||(s.name||"").toLowerCase().includes(search.toLowerCase())||(s.city||"").toLowerCase().includes(search.toLowerCase()));
  const viewSup=suppliers.find(s=>s.id===viewId);
  const viewStats=viewId?supStats[viewId]||supStats[viewSup?.name]||{purchases:[],totalWt:0,totalAmt:0,totalPaid:0,rates:[],avgRate:0,minRate:0,maxRate:0,balance:0}:{};

  // ── SUPPLIER DETAIL VIEW ──
  if(viewSup&&!editMode){
    const st=viewStats;
    const sparkW=280,sparkH=50;
    const rateVals=st.rates.map(r=>r.rate);
    const rMin=rateVals.length?Math.min(...rateVals):0;
    const rMax=rateVals.length?Math.max(...rateVals):rMin+1;
    const sparkPts=rateVals.map((v,i)=>{
      const x=rateVals.length<2?sparkW/2:i*(sparkW/(rateVals.length-1));
      const y=sparkH-Math.round(((v-rMin)/(rMax-rMin+0.01))*(sparkH-8))-4;
      return `${x},${y}`;
    }).join(" ");
    const isBest=bestSupId===viewId||bestSupId===viewSup.name;

    return(
      <div>
        <button onClick={()=>setViewId(null)} style={{background:"transparent",color:C.amber,fontSize:14,fontWeight:700,marginBottom:16,padding:"4px 0",border:"none",cursor:"pointer"}}>‹ Back to Suppliers</button>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4,flexWrap:"wrap"}}>
              <h1 style={{fontSize:22,fontWeight:800}}>🏭 {viewSup.name}</h1>
              {isBest&&<span style={{background:C.greenSoft,color:C.green,border:`1px solid ${C.green}44`,borderRadius:20,padding:"2px 10px",fontSize:11,fontWeight:800}}>⭐ BEST RATE</span>}
            </div>
            <div style={{fontSize:13,color:C.muted}}>{viewSup.phone||"No phone"}{viewSup.city?" · "+viewSup.city:""}{viewSup.region?" · "+viewSup.region:""}</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn color="amber" onClick={()=>{setForm({...viewSup});setEditMode(true);}}>✏️ Edit</Btn>
            <Btn color="red" onClick={()=>{if(window.confirm("Delete supplier?"))setSuppliers(p=>p.filter(s=>s.id!==viewId));setViewId(null);}}>🗑</Btn>
          </div>
        </div>

        {/* KPI cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
          {[
            ["📦 Total Purchased",`${(st.totalWt/1000).toFixed(1)} tons`,C.amber],
            ["💰 Total Amount",fmtRs(st.totalAmt),C.orange],
            ["✅ Paid",fmtRs(st.totalPaid),C.green],
            ["⚠️ Balance Due",fmtRs(st.balance),st.balance>0?C.red:C.green],
          ].map(([l,v,col])=>(
            <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
              <div className="mono" style={{fontSize:15,fontWeight:800,color:col}}>{v}</div>
            </div>
          ))}
        </div>

        {/* Rate analytics card */}
        {st.rates.length>0&&(
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14}}>📊 Rate Analytics</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
              {[["Avg Rate",`Rs.${fmt(st.avgRate)}/kg`,C.blue],["Min Rate",`Rs.${fmt(st.minRate)}/kg`,C.green],["Max Rate",`Rs.${fmt(st.maxRate)}/kg`,C.red]].map(([l,v,col])=>(
                <div key={l} style={{background:C.card2,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:4}}>{l}</div>
                  <div className="mono" style={{fontSize:13,fontWeight:800,color:col}}>{v}</div>
                </div>
              ))}
            </div>
            {/* Rate trend sparkline */}
            {rateVals.length>1&&(
              <>
                <div style={{fontSize:11,color:C.muted,fontWeight:700,marginBottom:8}}>Rate Trend ({st.rates.length} purchases)</div>
                <div style={{overflowX:"auto"}}>
                  <svg width={Math.max(sparkW,rateVals.length*28)} height={sparkH+20} style={{display:"block"}}>
                    <polyline points={sparkPts} fill="none" stroke={C.blue} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
                    {rateVals.map((v,i)=>{
                      const x=i*(sparkW/(rateVals.length-1));
                      const y=sparkH-Math.round(((v-rMin)/(rMax-rMin+0.01))*(sparkH-8))-4;
                      return <circle key={i} cx={x} cy={y} r="4" fill={C.blue} stroke={C.card} strokeWidth="2"/>;
                    })}
                    {st.rates.map((r,i)=>{
                      const x=i*(sparkW/(rateVals.length-1));
                      return <text key={i} x={x} y={sparkH+16} textAnchor="middle" fontSize="8" fill={C.muted}>{r.date.slice(5)}</text>;
                    })}
                  </svg>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted,marginTop:4}}>
                  <span>{rateVals.length<2?"Single purchase":"Trend over time"}</span>
                  <span>Spread: <span style={{color:C.orange,fontWeight:700}}>Rs.{fmt(st.maxRate-st.minRate)}/kg</span></span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Purchase history table */}
        <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Purchase History ({st.purchases.length})</div>
        {st.purchases.length===0?<Empty icon="📦" text="No purchases from this supplier"/>:(
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Date"/><TH ch="Vehicle"/><TH ch="Weight"/><TH ch="Rate"/><TH ch="Amount" right/><TH ch="Paid" right/><TH ch="Balance" right/></tr></thead>
              <tbody>
                {st.purchases.sort((a,b)=>b.date.localeCompare(a.date)).map(p=>(
                  <tr key={p.id}>
                    <TD color={C.muted}>{p.date}</TD>
                    <TD><Tag color={C.teal}>🚛 {p.vehicleNo}</Tag></TD>
                    <TD mono>{fmtKg(p.weight)}</TD>
                    <TD mono color={C.blue}>Rs.{fmt(p.rate)}/kg</TD>
                    <TD right mono color={C.amber} bold>{fmtRs(p.amt)}</TD>
                    <TD right mono color={C.green}>{fmtRs(p.paid)}</TD>
                    <TD right mono color={p.bal>0?C.red:C.green} bold>{fmtRs(p.bal)}</TD>
                  </tr>
                ))}
                <tr style={{background:C.card2}}>
                  <td colSpan={4} style={{padding:"9px 12px",fontSize:11,fontWeight:700,color:C.muted}}>TOTALS</td>
                  <td style={{padding:"9px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:C.amber}}>{fmtRs(st.totalAmt)}</span></td>
                  <td style={{padding:"9px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:C.green}}>{fmtRs(st.totalPaid)}</span></td>
                  <td style={{padding:"9px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:st.balance>0?C.red:C.green}}>{fmtRs(st.balance)}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── EDIT FORM (inline) ──
  if(editMode&&viewSup) return(
    <div>
      <button onClick={()=>{setEditMode(false);setForm({});}} style={{background:"transparent",color:C.amber,fontSize:14,fontWeight:700,marginBottom:16,padding:"4px 0",border:"none",cursor:"pointer"}}>‹ Cancel</button>
      <h2 style={{fontSize:18,fontWeight:800,marginBottom:18}}>✏️ Edit Supplier</h2>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:20}}>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <Fld label="Name"><input value={form.name||""} onChange={f("name")} placeholder="Supplier name"/></Fld>
          <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="+92 300..."/></Fld>
          <Fld label="City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Lahore"/></Fld>
          <Fld label="Region" half><select value={form.region||"Punjab"} onChange={f("region")}><option>Punjab</option><option>Sindh</option><option>KPK</option><option>Balochistan</option><option>Other</option></select></Fld>
        </div>
        <div style={{marginTop:16,display:"flex",gap:8}}>
          <Btn color="amber" onClick={save}>Save Changes</Btn>
          <Btn color="ghost" onClick={()=>{setEditMode(false);setForm({});}}>Cancel</Btn>
        </div>
      </div>
    </div>
  );

  // ── SUPPLIER LIST ──
  const sortedSups=[...suppliers].sort((a,b)=>{
    const as=supStats[a.id]||supStats[a.name]||{totalAmt:0};
    const bs=supStats[b.id]||supStats[b.name]||{totalAmt:0};
    return bs.totalAmt-as.totalAmt;
  });

  // Rate comparison chart across suppliers
  const chartSups=allRates.sort((a,b)=>a.avgRate-b.avgRate);
  const chartMax=chartSups.length?Math.max(...chartSups.map(s=>s.avgRate)):1;

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>🏭 Suppliers</h1>
          <p style={{color:C.muted,fontSize:13}}>{suppliers.length} suppliers · {Object.keys(supStats).length} with purchases</p>
        </div>
        <Btn color="amber" onClick={()=>{setForm({});setModal(true);}}>+ Add Supplier</Btn>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search suppliers…"
        style={{width:"100%",maxWidth:300,padding:"8px 14px",borderRadius:10,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13,marginBottom:16,outline:"none"}}/>

      {/* Rate comparison chart */}
      {chartSups.length>1&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>📊 Avg Rate Comparison (Rs/kg) — lower is better</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {chartSups.map((s,i)=>{
              const pct=Math.round((s.avgRate/chartMax)*100);
              const isBest=i===0;
              const isWorst=i===chartSups.length-1;
              const col=isBest?C.green:isWorst?C.red:C.blue;
              const supObj=suppliers.find(x=>x.id===s.supplierId||x.name===s.supplierName);
              return(
                <div key={s.supplierId}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:12,fontWeight:600}}>{s.supplierName}</span>
                      {isBest&&<span style={{fontSize:9,background:C.greenSoft,color:C.green,borderRadius:10,padding:"1px 6px",fontWeight:800}}>BEST</span>}
                      {isWorst&&<span style={{fontSize:9,background:C.redSoft,color:C.red,borderRadius:10,padding:"1px 6px",fontWeight:800}}>HIGHEST</span>}
                    </div>
                    <span className="mono" style={{fontSize:12,fontWeight:700,color:col}}>Rs.{fmt(s.avgRate)}/kg</span>
                  </div>
                  <div style={{background:C.card2,borderRadius:20,height:10,overflow:"hidden"}}>
                    <div style={{width:pct+"%",height:"100%",background:col,borderRadius:20,transition:"width 0.4s ease"}}/>
                  </div>
                  <div style={{display:"flex",gap:12,marginTop:3}}>
                    <span style={{fontSize:10,color:C.muted}}>Min: Rs.{fmt(s.minRate)}</span>
                    <span style={{fontSize:10,color:C.muted}}>Max: Rs.{fmt(s.maxRate)}</span>
                    <span style={{fontSize:10,color:C.muted}}>{s.purchases.length} purchase{s.purchases.length>1?"s":""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{marginTop:12,padding:"8px 12px",background:C.greenSoft,borderRadius:8,fontSize:12,color:C.green}}>
            💡 Buying from <strong>{chartSups[0]?.supplierName}</strong> saves Rs.{fmt(chartMax-chartSups[0]?.avgRate)}/kg vs highest rate supplier
          </div>
        </div>
      )}

      {/* Supplier cards */}
      {sortedSups.length===0?<Empty icon="🏭" text="No suppliers yet."/>:(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {sortedSups.filter(s=>!search||(s.name||"").toLowerCase().includes(search.toLowerCase())).map(s=>{
            const st=supStats[s.id]||supStats[s.name]||{totalWt:0,totalAmt:0,totalPaid:0,balance:0,avgRate:0,purchases:[]};
            const isBest=bestSupId===s.id||bestSupId===s.name;
            return(
              <div key={s.id} onClick={()=>setViewId(s.id)}
                style={{background:C.card,border:`1px solid ${isBest?C.green+"66":C.border}`,borderRadius:14,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=C.amber}
                onMouseLeave={e=>e.currentTarget.style.borderColor=isBest?C.green+"66":C.border}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                      <span style={{fontSize:15,fontWeight:800}}>🏭 {s.name}</span>
                      {isBest&&st.purchases.length>0&&<span style={{fontSize:10,background:C.greenSoft,color:C.green,border:`1px solid ${C.green}44`,borderRadius:10,padding:"1px 8px",fontWeight:800}}>⭐ BEST RATE</span>}
                    </div>
                    <div style={{fontSize:12,color:C.muted}}>{s.phone||"No phone"}{s.city?" · "+s.city:""}</div>
                  </div>
                  <Tag color={C.purple}>{s.region||"Punjab"}</Tag>
                </div>
                {st.purchases.length>0?(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                    {[["Purchases",st.purchases.length,C.amber],["Volume",`${(st.totalWt/1000).toFixed(1)}t`,C.orange],["Avg Rate",`Rs.${fmt(st.avgRate)}`,C.blue],["Due",fmtRs(st.balance),st.balance>0?C.red:C.green]].map(([l,v,col])=>(
                      <div key={l} style={{background:C.card2,borderRadius:8,padding:"7px 8px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</div>
                        <div className="mono" style={{fontSize:11,fontWeight:700,color:col}}>{v}</div>
                      </div>
                    ))}
                  </div>
                ):<div style={{fontSize:12,color:C.muted,fontStyle:"italic"}}>No purchases yet</div>}
              </div>
            );
          })}
        </div>
      )}

      {modal&&(
        <Modal title="Add Supplier" onSave={save} saveLabel="Add" onClose={()=>{setModal(false);setForm({});}}>
          <Fld label="Name"><input value={form.name||""} onChange={f("name")} placeholder="e.g. Punjab Poultry Farms"/></Fld>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="+92 300..."/></Fld>
            <Fld label="City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Lahore"/></Fld>
          </div>
          <Fld label="Region" half><select value={form.region||"Punjab"} onChange={f("region")}><option>Punjab</option><option>Sindh</option><option>KPK</option><option>Balochistan</option><option>Other</option></select></Fld>
        </Modal>
      )}
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
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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

  const TABS=["daily","sales","receipts","customer","supplier","receivables","sup_due","pnl","aging"];
  const TAB_LABELS={"daily":"📅 Daily","sales":"📊 Sales","receipts":"🧾 Receipts","customer":"👤 Customer","supplier":"🏭 Supplier","receivables":"💳 Receivables","sup_due":"🏭 Sup. Due","pnl":"📈 P&L","aging":"⏳ Aging"};
  const [dailyDate,setDailyDate]=useState(today());

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
      <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12}}>
        <Btn color="ghost" small onClick={()=>window.print()}>🖨 Print</Btn>
      </div>
      <div style={{display:"flex",gap:2,marginBottom:24,background:C.card,padding:4,borderRadius:10,border:`1px solid ${C.border}`,width:"fit-content"}} className="no-print">
        {TABS.map(t=>(<button key={t} onClick={()=>setTab(t)} style={{padding:"8px 16px",borderRadius:20,background:tab===t?C.amber:"transparent",color:tab===t?"#000":C.muted,border:tab===t?"none":`1px solid ${C.border}`,fontWeight:tab===t?700:500,fontSize:12,whiteSpace:"nowrap",minHeight:36,flexShrink:0}}>{TAB_LABELS[t]}</button>))}
      </div>

      {/* ── DAILY SUMMARY REPORT ── */}
      {tab==="daily"&&(()=>{
        // All data for selected day
        const daySales=[];const dayReceipts=[];const dayPurchases=[];const dayExpenses=[];
        vehicles.forEach(v=>{
          v.sales.filter(s=>s.date===dailyDate).forEach(s=>{
            const col=(s.receipts||[]).reduce((a,r)=>a+n(r.amount),0);
            daySales.push({...s,vehicleNo:v.vehicleNo,collected:col,balance:s.totalAmount-col});
          });
          v.sales.forEach(s=>(s.receipts||[]).filter(r=>r.date===dailyDate).forEach(r=>dayReceipts.push({...r,vehicleNo:v.vehicleNo,customerName:s.customerName,receiptNo:s.receiptNo})));
          v.purchases.filter(p=>p.date===dailyDate).forEach(p=>dayPurchases.push({...p,vehicleNo:v.vehicleNo}));
          v.expenses.filter(e=>e.date===dailyDate).forEach(e=>dayExpenses.push({...e,vehicleNo:v.vehicleNo}));
        });
        const dayTxns=transactions.filter(t=>t.date===dailyDate&&!t.voided);

        // Totals
        const totalSaleWt=daySales.reduce((s,x)=>s+n(x.weight),0);
        const totalSaleAmt=daySales.reduce((s,x)=>s+n(x.totalAmount),0);
        const totalCollected=dayReceipts.reduce((s,r)=>s+n(r.amount),0);
        const totalPurchWt=dayPurchases.reduce((s,p)=>s+n(p.weight),0);
        const totalPurchAmt=dayPurchases.reduce((s,p)=>s+n(p.weight)*n(p.rate),0);
        const totalExpAmt=dayExpenses.reduce((s,e)=>s+n(e.amount),0);

        // Per-vehicle breakdown
        const vehicleBreakdown=vehicles.map(v=>{
          const vs=v.sales.filter(s=>s.date===dailyDate);
          const vr=v.sales.flatMap(s=>(s.receipts||[]).filter(r=>r.date===dailyDate));
          const vp=v.purchases.filter(p=>p.date===dailyDate);
          if(!vs.length&&!vr.length&&!vp.length) return null;
          return{vehicleNo:v.vehicleNo,sales:vs.length,salesWt:vs.reduce((s,x)=>s+n(x.weight),0),salesAmt:vs.reduce((s,x)=>s+n(x.totalAmount),0),receipts:vr.reduce((s,r)=>s+n(r.amount),0),purchases:vp.length,purchWt:vp.reduce((s,p)=>s+n(p.weight),0)};
        }).filter(Boolean);

        // Top customers today
        const custMap={};
        daySales.forEach(s=>{if(!custMap[s.customerName])custMap[s.customerName]={name:s.customerName,wt:0,amt:0};custMap[s.customerName].wt+=n(s.weight);custMap[s.customerName].amt+=n(s.totalAmount);});
        const topCusts=Object.values(custMap).sort((a,b)=>b.amt-a.amt).slice(0,5);

        const shareDaily=()=>{
          const lines=[];
          lines.push("🐔 *ChickenFlow Daily Report*");
          lines.push("📅 *Date:* "+dailyDate);
          lines.push("━━━━━━━━━━━━━━━━━━━━━");
          lines.push("🧾 *Sales*");
          lines.push("  Qty: "+daySales.length+" invoices · "+totalSaleWt.toLocaleString()+" kg");
          lines.push("  Value: Rs."+Math.round(totalSaleAmt).toLocaleString());
          lines.push("💰 *Collected:* Rs."+Math.round(totalCollected).toLocaleString());
          lines.push("📦 *Purchased:* "+totalPurchWt.toLocaleString()+" kg · Rs."+Math.round(totalPurchAmt).toLocaleString());
          if(totalExpAmt>0) lines.push("💸 *Expenses:* Rs."+Math.round(totalExpAmt).toLocaleString());
          if(topCusts.length>0){lines.push("━━━━━━━━━━━━━━━━━━━━━");lines.push("👤 *Top Customers:*");topCusts.forEach(c=>lines.push("  "+c.name+" — "+c.wt.toLocaleString()+"kg · Rs."+Math.round(c.amt).toLocaleString()));}
          lines.push("━━━━━━━━━━━━━━━━━━━━━");
          lines.push("_Sent via ChickenFlow_ 🐔");
          window.open("https://wa.me/?text="+encodeURIComponent(lines.join("\n")),"_blank");
        };

        return(
          <div>
            {/* Date picker + share */}
            <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:20,flexWrap:"wrap"}} className="no-print">
              <div style={{display:"flex",alignItems:"center",gap:8,background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 14px"}}>
                <span style={{fontSize:13,color:C.muted,fontWeight:600}}>📅 Date:</span>
                <input type="date" value={dailyDate} onChange={e=>setDailyDate(e.target.value)} style={{border:"none",background:"transparent",color:C.text,fontSize:14,fontWeight:700,outline:"none"}}/>
              </div>
              <button onClick={()=>setDailyDate(today())} style={{background:C.amberSoft,color:C.amber,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Today</button>
              <button onClick={()=>{const d=new Date(dailyDate);d.setDate(d.getDate()-1);setDailyDate(d.toISOString().split("T")[0]);}} style={{background:C.card2,color:C.muted,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",fontSize:12,cursor:"pointer"}}>← Prev</button>
              <button onClick={()=>{const d=new Date(dailyDate);d.setDate(d.getDate()+1);setDailyDate(d.toISOString().split("T")[0]);}} style={{background:C.card2,color:C.muted,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",fontSize:12,cursor:"pointer"}}>Next →</button>
              <button onClick={shareDaily} style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",marginLeft:"auto"}}>📲 Share</button>
            </div>

            {/* KPI Cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
              <div style={{background:C.card,border:`1px solid ${C.green}44`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>🧾 Sales Today</div>
                <div className="mono" style={{fontSize:18,fontWeight:800,color:C.green}}>{fmtRs(totalSaleAmt)}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:3}}>{daySales.length} invoices · {totalSaleWt.toLocaleString()} kg</div>
              </div>
              <div style={{background:C.card,border:`1px solid ${C.teal}44`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>💰 Collected</div>
                <div className="mono" style={{fontSize:18,fontWeight:800,color:C.teal}}>{fmtRs(totalCollected)}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:3}}>{dayReceipts.length} receipt{dayReceipts.length!==1?"s":""}</div>
              </div>
              <div style={{background:C.card,border:`1px solid ${C.amber}44`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>📦 Purchased</div>
                <div className="mono" style={{fontSize:18,fontWeight:800,color:C.amber}}>{fmtKg(totalPurchWt)}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:3}}>{dayPurchases.length} purchase{dayPurchases.length!==1?"s":""} · {fmtRs(totalPurchAmt)}</div>
              </div>
              <div style={{background:C.card,border:`1px solid ${C.red}44`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>💸 Expenses</div>
                <div className="mono" style={{fontSize:18,fontWeight:800,color:C.red}}>{fmtRs(totalExpAmt)}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:3}}>{dayExpenses.length} expense{dayExpenses.length!==1?"s":""}</div>
              </div>
            </div>

            {/* Sales of the day */}
            {daySales.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:C.amber,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>🧾 Sales ({daySales.length})</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>{["Customer","Vehicle","Weight","Rate","Amount","Collected","Balance"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                    <tbody>
                      {daySales.map(s=><tr key={s.id}>
                        <TD bold>{s.customerName}</TD><TD color={C.muted}>{s.vehicleNo}</TD>
                        <TD mono>{fmtKg(s.weight)}</TD><TD mono color={C.muted}>Rs.{fmt(s.rate)}</TD>
                        <TD mono bold color={C.amber}>{fmtRs(s.totalAmount)}</TD>
                        <TD mono color={C.green}>{fmtRs(s.collected)}</TD>
                        <TD mono color={s.balance>0?C.red:C.muted}>{s.balance>0?fmtRs(s.balance):"✓"}</TD>
                      </tr>)}
                      <tr style={{background:C.card2}}><td colSpan={2} style={{padding:"8px 12px",fontSize:12,color:C.muted,fontWeight:700}}>TOTAL</td><td style={{padding:"8px 12px"}} className="mono"><strong>{totalSaleWt.toLocaleString()} kg</strong></td><td/><td style={{padding:"8px 12px"}} className="mono"><strong style={{color:C.amber}}>{fmtRs(totalSaleAmt)}</strong></td><td style={{padding:"8px 12px"}} className="mono"><strong style={{color:C.green}}>{fmtRs(totalCollected)}</strong></td><td/></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Receipts of the day */}
            {dayReceipts.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:C.teal,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>💰 Receipts ({dayReceipts.length})</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>{["Customer","Vehicle","Invoice","Method","Amount"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                    <tbody>
                      {dayReceipts.map(r=><tr key={r.id}><TD bold>{r.customerName}</TD><TD color={C.muted}>{r.vehicleNo}</TD><TD color={C.muted}>{r.receiptNo}</TD><TD><Tag color={C.blue}>{r.method||"Cash"}</Tag></TD><TD mono bold color={C.teal}>{fmtRs(r.amount)}</TD></tr>)}
                      <tr style={{background:C.card2}}><td colSpan={4} style={{padding:"8px 12px",fontSize:12,color:C.muted,fontWeight:700}}>TOTAL COLLECTED</td><td style={{padding:"8px 12px"}} className="mono"><strong style={{color:C.teal}}>{fmtRs(totalCollected)}</strong></td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Top Customers */}
            {topCusts.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:C.purple,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>👤 Top Customers Today</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>{["Customer","Weight","Sale Value"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                    <tbody>{topCusts.map((c,i)=><tr key={i}><TD bold>{c.name}</TD><TD mono>{c.wt.toLocaleString()} kg</TD><TD mono bold color={C.green}>{fmtRs(c.amt)}</TD></tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Vehicle breakdown */}
            {vehicleBreakdown.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:C.blue,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>🚛 Vehicle Breakdown</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>{["Vehicle","Sales","Sale Wt","Sale Amt","Collected","Purchases","Purch Wt"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                    <tbody>{vehicleBreakdown.map((v,i)=><tr key={i}><TD bold color={C.amber}>{v.vehicleNo}</TD><TD color={C.muted}>{v.sales}</TD><TD mono>{v.salesWt.toLocaleString()} kg</TD><TD mono color={C.green}>{fmtRs(v.salesAmt)}</TD><TD mono color={C.teal}>{fmtRs(v.receipts)}</TD><TD color={C.muted}>{v.purchases}</TD><TD mono>{v.purchWt.toLocaleString()} kg</TD></tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}

            {daySales.length===0&&dayReceipts.length===0&&dayPurchases.length===0&&(
              <div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}>
                <div style={{fontSize:48,marginBottom:12}}>📅</div>
                <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>No Activity</div>
                <div style={{fontSize:13}}>No sales, receipts or purchases recorded on {dailyDate}</div>
              </div>
            )}
          </div>
        );
      })()}

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
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
                  <button onClick={()=>{
                    const lines=[];
                    lines.push("🐔 *ChickenFlow Statement*");
                    lines.push("━━━━━━━━━━━━━━━━━━━━━");
                    lines.push("👤 *Customer:* "+custInfo?.name);
                    if(custInfo?.city) lines.push("📍 *City:* "+custInfo.city);
                    if(custInfo?.phone) lines.push("📞 *Phone:* "+custInfo.phone);
                    lines.push("📅 *Period:* "+custFromDate+" → "+custToDate);
                    lines.push("━━━━━━━━━━━━━━━━━━━━━");
                    if(custOpeningBal>0) lines.push("📂 *Opening Balance:* Rs."+Math.round(custOpeningBal).toLocaleString());
                    lines.push("🧾 *Total Sales:* Rs."+Math.round(custSalesTotal).toLocaleString());
                    lines.push("✅ *Total Received:* Rs."+Math.round(custReceiptsTotal).toLocaleString());
                    lines.push("━━━━━━━━━━━━━━━━━━━━━");
                    if(custNetBalance>0){
                      lines.push("🔴 *BALANCE DUE: Rs."+Math.round(Math.abs(custNetBalance)).toLocaleString()+"*");
                      lines.push("_(Amount Receivable)_");
                    } else {
                      lines.push("🟢 *ACCOUNT CLEAR ✓*");
                    }
                    lines.push("");
                    const recentRows=custLedgerWithBal.slice(-5);
                    if(recentRows.length>0){
                      lines.push("📋 *Recent Transactions:*");
                      recentRows.forEach(function(row){
                        if(row.type==="invoice") lines.push("  🧾 "+row.date+" – Sale Rs."+Math.round(row.debit).toLocaleString()+" | Bal: Rs."+Math.round(Math.abs(row.runningBal)).toLocaleString()+(row.runningBal>0?" Dr":" Cr"));
                        if(row.type==="receipt") lines.push("  💰 "+row.date+" – Received Rs."+Math.round(row.credit).toLocaleString()+" | Bal: Rs."+Math.round(Math.abs(row.runningBal)).toLocaleString()+(row.runningBal>0?" Dr":" Cr"));
                      });
                      lines.push("");
                    }
                    lines.push("_Sent via ChickenFlow_ 🐔");
                    window.open("https://wa.me/?text="+encodeURIComponent(lines.join("\n")),"_blank");
                  }} style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer"}}>📲 WhatsApp Statement</button>
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
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
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
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
            <StatBox label="Total Revenue" value={fmtRs(totRev)} color={C.green}/>
            <StatBox label="Total Cost" value={fmtRs(totCost)} color={C.red}/>
            <StatBox label="Net Profit/Loss" value={fmtRs(Math.abs(totPnl))} color={totPnl>=0?C.green:C.red} sub={totPnl>=0?"Profit":"Loss"}/>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Vehicle"/><TH ch="Date"/><TH ch="Status"/><TH ch="Transfers" right/><TH ch="Revenue" right/><TH ch="Total Cost" right/><TH ch="P&L" right/></tr></thead>
              <tbody>
                {rows.map(r=>{
                  const vObj=vehicles.find(v=>v.id===r.id);
                  const tIn=vObj?(vObj.transfers||[]).filter(t=>t.direction==="in").reduce((s,t)=>s+n(t.weight),0):0;
                  const tOut=vObj?(vObj.transfers||[]).filter(t=>t.direction!=="in").reduce((s,t)=>s+n(t.weight),0):0;
                  return(
                    <tr key={r.id}>
                      <TD bold>{r.no}</TD>
                      <TD color={C.muted}>{r.date}</TD>
                      <TD><Tag color={r.status==="active"?C.green:C.muted}>{r.status}</Tag></TD>
                      <TD right>{tIn>0&&<Tag color={C.blue}>📥{fmtKg(tIn)}</Tag>}{tOut>0&&<Tag color={C.orange}>📤{fmtKg(tOut)}</Tag>}</TD>
                      <TD right mono color={C.green}>{fmtRs(r.rev)}</TD>
                      <TD right mono color={C.red}>{fmtRs(r.cost)}</TD>
                      <TD right mono bold color={r.pnl>=0?C.green:C.red}>{r.pnl>=0?"+":"-"}{fmtRs(Math.abs(r.pnl))}</TD>
                    </tr>
                  );
                })}
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
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
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

    {invoiceSale&&<InvoiceModal sale={invoiceSale} vehicleNo={vehicle.vehicleNo} onClose={()=>setInvoiceSale(null)}/>}
    </div>
  );
}

// ─── INVOICE MODAL ───────────────────────────────────────────────────────────
function InvoiceModal({sale,vehicleNo,onClose}){
  const invoiceRef=useRef();
  const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
  const balance=sale.totalAmount-collected;
  const dateStr=new Date().toLocaleDateString("en-PK",{day:"numeric",month:"long",year:"numeric"});

  const downloadPDF=async()=>{
    try{
      const [jsPDF,html2canvas]=await Promise.all([loadJsPDF(),loadHtml2Canvas()]);
      const el=invoiceRef.current;
      const canvas=await html2canvas(el,{scale:2,backgroundColor:"#ffffff",useCORS:true,logging:false});
      const imgData=canvas.toDataURL("image/png");
      const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a5"});
      const pw=pdf.internal.pageSize.getWidth();const ph=pdf.internal.pageSize.getHeight();
      const imgW=pw;const imgH=(canvas.height*imgW)/canvas.width;
      pdf.addImage(imgData,"PNG",0,0,imgW,Math.min(imgH,ph));
      pdf.save("Invoice-"+sale.receiptNo+".pdf");
    }catch(e){alert("PDF error: "+e.message);}
  };

  const printInvoice=()=>{
    const w=window.open("","_blank","width=620,height=850");
    if(!w) return alert("Allow popups to print");
    w.document.write("<!DOCTYPE html><html><head><title>Invoice "+sale.receiptNo+"</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#fff;color:#111;padding:24px}.logo{font-size:22px;font-weight:900;color:#f59e0b;text-align:center;margin-bottom:4px}.sub{text-align:center;font-size:12px;color:#999;margin-bottom:20px;border-bottom:2px solid #f59e0b;padding-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}.box{background:#f9f9f9;border-radius:6px;padding:10px 12px}.lbl{font-size:10px;color:#999;text-transform:uppercase;margin-bottom:2px}.val{font-size:13px;font-weight:700}.bill{background:#fff8e6;border-radius:8px;padding:12px;margin-bottom:16px;border:1px solid #f59e0b44}.pay{display:flex;justify-content:space-between;padding:7px 10px;background:#f0fdf4;border-radius:6px;margin-bottom:4px;border:1px solid #bbf7d0;font-size:12px;color:#16a34a}.bal{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-radius:8px;margin-top:12px;font-weight:700;font-size:14px}.due{background:#fee2e2;color:#dc2626;border:1px solid #fca5a5}.paid{background:#dcfce7;color:#16a34a;border:1px solid #86efac}.footer{text-align:center;font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:12px;margin-top:16px}</style></head><body>");
    w.document.write("<div class='logo'>🐔 ChickenFlow</div><div class='sub'>Invoice #"+sale.receiptNo+" · "+sale.date+" · Vehicle: "+vehicleNo+"</div>");
    w.document.write("<div class='bill'><div class='lbl'>Bill To</div><div style='font-size:16px;font-weight:800'>"+sale.customerName+"</div></div>");
    w.document.write("<div class='grid'><div class='box'><div class='lbl'>Weight</div><div class='val'>"+n(sale.weight).toLocaleString()+" kg</div></div><div class='box'><div class='lbl'>Rate</div><div class='val'>Rs."+fmt(sale.rate)+"/kg</div></div><div class='box'><div class='lbl'>Total Amount</div><div class='val' style='color:#f59e0b'>Rs."+Math.round(sale.totalAmount).toLocaleString()+"</div></div><div class='box'><div class='lbl'>Balance</div><div class='val' style='color:"+(balance>0?"#dc2626":"#16a34a")+"'>Rs."+Math.round(Math.abs(balance)).toLocaleString()+"</div></div></div>");
    if((sale.receipts||[]).length>0){w.document.write("<div style='margin-bottom:8px;font-size:11px;color:#999;text-transform:uppercase;font-weight:700'>Payment History</div>");(sale.receipts||[]).forEach(r=>{w.document.write("<div class='pay'><span>✅ "+r.date+(r.method?" ("+r.method+")":"")+"</span><span style='font-weight:700;font-family:monospace'>Rs."+Math.round(r.amount).toLocaleString()+"</span></div>");});}
    w.document.write("<div class='bal "+(balance>0?"due":"paid")+"'><span>"+(balance>0?"Balance Due":"Fully Paid ✓")+"</span><span style='font-family:monospace'>Rs."+Math.round(Math.abs(balance)).toLocaleString()+"</span></div>");
    if(sale.notes) w.document.write("<div style='margin-top:12px;font-size:12px;color:#666;background:#f9f9f9;padding:8px 12px;border-radius:8px'>Note: "+sale.notes+"</div>");
    w.document.write("<div class='footer'>Powered by ChickenFlow · "+dateStr+"</div></body></html>");
    w.document.close();w.focus();setTimeout(()=>w.print(),600);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:600,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:C.card,borderRadius:16,width:"100%",maxWidth:520,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
        <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{fontWeight:800,fontSize:15}}>📄 Invoice — {sale.receiptNo}</div>
          <button onClick={onClose} style={{background:"transparent",color:C.muted,fontSize:20,border:"none",cursor:"pointer",padding:"2px 8px"}}>✕</button>
        </div>
        <div style={{overflowY:"auto",flex:1,padding:18,background:C.bg}}>
          <div ref={invoiceRef} style={{background:"#ffffff",borderRadius:12,padding:24,color:"#111",fontFamily:"Arial,sans-serif"}}>
            <div style={{textAlign:"center",marginBottom:20,borderBottom:"3px solid #f59e0b",paddingBottom:16}}>
              <div style={{fontSize:22,fontWeight:900,color:"#f59e0b"}}>🐔 ChickenFlow</div>
              <div style={{fontSize:13,color:"#555",marginTop:4}}>Invoice #{sale.receiptNo}</div>
              <div style={{fontSize:12,color:"#999",marginTop:2}}>Date: {sale.date} · Vehicle: {vehicleNo}</div>
            </div>
            <div style={{background:"#fff8e6",borderRadius:10,padding:"12px 14px",marginBottom:16,border:"1px solid #f59e0b44"}}>
              <div style={{fontSize:10,color:"#999",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Bill To</div>
              <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{sale.customerName}</div>
              {sale.driver&&<div style={{fontSize:12,color:"#666",marginTop:2}}>Driver: {sale.driver}</div>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
              {[["Weight",n(sale.weight).toLocaleString()+" kg"],["Rate","Rs."+fmt(sale.rate)+"/kg"],["Total","Rs."+Math.round(sale.totalAmount).toLocaleString()]].map(([l,v])=>(
                <div key={l} style={{background:"#f9f9f9",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#999",textTransform:"uppercase",marginBottom:4}}>{l}</div>
                  <div style={{fontSize:13,fontWeight:700}}>{v}</div>
                </div>
              ))}
            </div>
            {(sale.receipts||[]).length>0&&(
              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,color:"#999",fontWeight:700,textTransform:"uppercase",marginBottom:6}}>Payment History</div>
                {(sale.receipts||[]).map(r=>(
                  <div key={r.id} style={{display:"flex",justifyContent:"space-between",padding:"7px 10px",background:"#f0fdf4",borderRadius:6,marginBottom:4,border:"1px solid #bbf7d0"}}>
                    <div style={{fontSize:12,color:"#16a34a"}}>✅ {r.date}{r.method?" ("+r.method+")":""}</div>
                    <div style={{fontSize:12,fontWeight:700,color:"#16a34a",fontFamily:"monospace"}}>Rs.{Math.round(r.amount).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{background:balance>0?"#fee2e2":"#dcfce7",borderRadius:10,padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid "+(balance>0?"#fca5a5":"#86efac")}}>
              <div style={{fontSize:13,fontWeight:700,color:balance>0?"#dc2626":"#16a34a"}}>{balance>0?"Balance Due":"Fully Paid ✓"}</div>
              <div style={{fontSize:18,fontWeight:900,color:balance>0?"#dc2626":"#16a34a",fontFamily:"monospace"}}>Rs.{Math.round(Math.abs(balance)).toLocaleString()}</div>
            </div>
            {sale.notes&&<div style={{marginTop:12,fontSize:12,color:"#666",background:"#f9f9f9",padding:"8px 12px",borderRadius:8}}>Note: {sale.notes}</div>}
            <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#bbb",borderTop:"1px solid #eee",paddingTop:12}}>Powered by ChickenFlow · {dateStr}</div>
          </div>
        </div>
        <div style={{padding:"12px 18px",borderTop:`1px solid ${C.border}`,display:"flex",gap:8,flexShrink:0}}>
          <button onClick={printInvoice} style={{flex:1,background:C.card2,color:C.text,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 12px",fontSize:13,fontWeight:700,cursor:"pointer"}}>🖨 Print</button>
          <button onClick={downloadPDF} style={{flex:1,background:C.blueSoft,color:C.blue,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"11px 12px",fontSize:13,fontWeight:700,cursor:"pointer"}}>📥 PDF</button>
          <button onClick={onClose} style={{background:C.card2,color:C.muted,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 14px",fontSize:13,fontWeight:600,cursor:"pointer"}}>✕</button>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({vehicles,transactions,accounts,customers,onOpen,onNew}){
  const [projSearch,setProjSearch]=useState("");
  const [projStatus,setProjStatus]=useState("all");
  const [summaryExpanded,setSummaryExpanded]=useState(true);
  const filteredVehicles=useMemo(()=>vehicles.filter(v=>{
    const q=projSearch.toLowerCase();
    const matchQ=!q||(v.vehicleNo||"").toLowerCase().includes(q)||(v.driverName||"").toLowerCase().includes(q)||(v.date||"").includes(q);
    const matchS=projStatus==="all"||v.status===projStatus;
    return matchQ&&matchS;
  }),[vehicles,projSearch,projStatus]);
  const active=vehicles.filter(v=>v.status==="active");
  const totalPnl=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).pnl,0);
  const totalRev=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).totalSaleValue,0);

  // ── Summary calculations ──
  const todayStr=today();
  const totalCash=accounts.reduce((s,a)=>s+getBalance(a.id,transactions),0);
  const totalReceivable=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).totalSaleBalance,0);
  const totalSupplierDue=vehicles.reduce((s,v)=>s+calcVehicle(v,transactions).supplierBalance,0);

  // Today's activity
  const todaySales=useMemo(()=>{let w=0,a=0;vehicles.forEach(v=>v.sales.filter(s=>s.date===todayStr).forEach(s=>{w+=n(s.weight);a+=n(s.totalAmount);}));return{weight:w,amount:a};},[vehicles,todayStr]);
  const todayReceipts=useMemo(()=>{let a=0,c=0;vehicles.forEach(v=>v.sales.forEach(s=>(s.receipts||[]).filter(r=>r.date===todayStr).forEach(r=>{a+=n(r.amount);c++;})));return{amount:a,count:c};},[vehicles,todayStr]);
  const todayPurchases=useMemo(()=>{let w=0,a=0;vehicles.forEach(v=>v.purchases.filter(p=>p.date===todayStr).forEach(p=>{w+=n(p.weight);a+=n(p.weight)*n(p.rate);}));return{weight:w,amount:a};},[vehicles,todayStr]);

  // Customers with high balance
  const topReceivables=useMemo(()=>{
    const map={};
    vehicles.forEach(v=>v.sales.filter(s=>!s.deletedAt).forEach(sale=>{
      const col=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
      const bal=sale.totalAmount-col;
      if(bal>0.01){
        if(!map[sale.customerId]) map[sale.customerId]={name:sale.customerName,due:0};
        map[sale.customerId].due+=bal;
      }
    }));
    return Object.values(map).sort((a,b)=>b.due-a.due).slice(0,3);
  },[vehicles]);

  return(
    <div>
      {/* ── TOP ACTION ROW ── */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,marginBottom:2}}>🐔 ChickenFlow</h1>
          <p style={{color:C.muted,fontSize:12}}>{active.length} active vehicles · {new Date().toLocaleDateString("en-PK",{day:"numeric",month:"short",year:"numeric"})}</p>
        </div>
        <Btn onClick={onNew} sx={{fontSize:13,padding:"10px 16px",minHeight:44}}>+ New Vehicle</Btn>
      </div>

      {/* ── BUSINESS SUMMARY CARDS ── */}
      {vehicles.length>0&&(
        <div style={{marginBottom:16}}>
          <button onClick={()=>setSummaryExpanded(p=>!p)} style={{background:"transparent",border:"none",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:8,display:"flex",alignItems:"center",gap:4,textTransform:"uppercase",letterSpacing:"0.05em"}}>
            📊 Business Summary {summaryExpanded?"▲":"▼"}
          </button>
          {summaryExpanded&&(
            <>
              {/* Main KPIs */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>💰 Cash in Hand</div>
                  <div className="mono" style={{fontSize:15,fontWeight:800,color:totalCash>=0?C.green:C.red,whiteSpace:"nowrap"}}>{fmtRs(Math.abs(totalCash))}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>{accounts.length} account{accounts.length!==1?"s":""}</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${C.red}44`,borderRadius:12,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>🔴 Receivable</div>
                  <div className="mono" style={{fontSize:15,fontWeight:800,color:C.red,whiteSpace:"nowrap"}}>{fmtRs(totalReceivable)}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>from customers</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${C.amber}44`,borderRadius:12,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>🏭 Supplier Due</div>
                  <div className="mono" style={{fontSize:15,fontWeight:800,color:C.amber,whiteSpace:"nowrap"}}>{fmtRs(totalSupplierDue)}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>to be paid</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${totalPnl>=0?C.green:C.red}44`,borderRadius:12,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{totalPnl>=0?"📈 Net Profit":"📉 Net Loss"}</div>
                  <div className="mono" style={{fontSize:15,fontWeight:800,color:totalPnl>=0?C.green:C.red,whiteSpace:"nowrap"}}>{fmtRs(Math.abs(totalPnl))}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>all time</div>
                </div>
              </div>

              {/* Today's Activity */}
              <div style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",marginBottom:10}}>
                <div style={{fontSize:11,color:C.amber,fontWeight:700,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em"}}>⚡ Today's Activity</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:C.green}}>{todaySales.weight>0?fmtKg(todaySales.weight):"—"}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>Sold Today</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:C.blue}}>{todayPurchases.weight>0?fmtKg(todayPurchases.weight):"—"}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>Purchased</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:C.teal}}>{todayReceipts.amount>0?fmtRs(todayReceipts.amount):"—"}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>Collected</div>
                  </div>
                </div>
                {todaySales.amount===0&&todayPurchases.amount===0&&todayReceipts.amount===0&&(
                  <div style={{textAlign:"center",color:C.muted,fontSize:12,marginTop:6}}>No activity recorded today</div>
                )}
              </div>

              {/* Top receivables */}
              {topReceivables.length>0&&(
                <div style={{background:C.card2,border:`1px solid ${C.red}33`,borderRadius:12,padding:"12px 14px",marginBottom:10}}>
                  <div style={{fontSize:11,color:C.red,fontWeight:700,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>🔴 Top Pending Balances</div>
                  {topReceivables.map((r,i)=>(
                    <div key={r.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:i<topReceivables.length-1?`1px solid ${C.border}33`:"none"}}>
                      <div style={{fontSize:13,fontWeight:600}}>{r.name}</div>
                      <div className="mono" style={{fontSize:13,fontWeight:800,color:C.red}}>{fmtRs(r.due)}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── VEHICLE FILTER ── */}
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <input value={projSearch} onChange={e=>setProjSearch(e.target.value)} placeholder="🔍 Search vehicle / driver…" style={{flex:1,minWidth:0,padding:"9px 12px",borderRadius:10,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:16}}/>
        {["all","active","closed"].map(s=><button key={s} onClick={()=>setProjStatus(s)} style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,background:projStatus===s?C.amberSoft:"transparent",color:projStatus===s?C.amber:C.muted,border:projStatus===s?`1px solid ${C.amber}44`:"1px solid transparent",cursor:"pointer"}}>{s==="all"?"All":s==="active"?"Active":"Closed"}</button>)}
        {(projSearch||projStatus!=="all")&&<button onClick={()=>{setProjSearch("");setProjStatus("all");}} style={{padding:"5px 10px",borderRadius:8,fontSize:11,background:C.card2,color:C.muted,border:`1px solid ${C.border}`,cursor:"pointer"}}>✕</button>}
      </div>
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


// ─── INVOICE MODAL ───────────────────────────────────────────────────────────
function InvoiceModal({sale,vehicleNo,onClose}){
  const invoiceRef=useRef();
  const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
  const balance=sale.totalAmount-collected;
  const dateStr=new Date().toLocaleDateString("en-PK",{day:"numeric",month:"long",year:"numeric"});

  const downloadPDF=async()=>{
    try{
      const [jsPDF,html2canvas]=await Promise.all([loadJsPDF(),loadHtml2Canvas()]);
      const el=invoiceRef.current;
      const canvas=await html2canvas(el,{scale:2,backgroundColor:"#ffffff",useCORS:true,logging:false});
      const imgData=canvas.toDataURL("image/png");
      const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a5"});
      const pw=pdf.internal.pageSize.getWidth();
      const ph=pdf.internal.pageSize.getHeight();
      const imgW=pw;
      const imgH=(canvas.height*imgW)/canvas.width;
      pdf.addImage(imgData,"PNG",0,0,imgW,Math.min(imgH,ph));
      pdf.save(`Invoice-${sale.receiptNo}.pdf`);
    }catch(e){alert("PDF generation failed: "+e.message);}
  };

  const printInvoice=()=>{
    const w=window.open("","_blank","width=600,height=800");
    w.document.write(`<!DOCTYPE html><html><head><title>Invoice ${sale.receiptNo}</title>
    <style>body{margin:0;font-family:Arial,sans-serif;background:#fff;color:#000;}
    .inv{max-width:480px;margin:0 auto;padding:24px;}
    .header{text-align:center;margin-bottom:20px;border-bottom:2px solid #f59e0b;padding-bottom:16px;}
    .logo{font-size:24px;font-weight:900;color:#f59e0b;letter-spacing:-0.02em;}
    .receipt-no{font-size:13px;color:#666;margin-top:4px;}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;}
    .info-box{background:#f9f9f9;border-radius:8px;padding:10px 12px;}
    .info-label{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;}
    .info-value{font-size:13px;font-weight:700;color:#111;}
    .table{width:100%;border-collapse:collapse;margin-bottom:16px;}
    .table th{background:#f59e0b;color:#000;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;}
    .table td{padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;}
    .total-row{background:#fff8e6;}
    .total-row td{font-weight:700;font-size:14px;color:#f59e0b;}
    .balance{text-align:center;padding:14px;border-radius:10px;margin-top:16px;font-size:15px;font-weight:700;}
    .balance.due{background:#fee2e2;color:#dc2626;}
    .balance.paid{background:#dcfce7;color:#16a34a;}
    .footer{text-align:center;margin-top:20px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px;}
    </style></head><body><div class="inv">
    <div class="header"><div class="logo">🐔 ChickenFlow</div>
    <div class="receipt-no">Invoice #${sale.receiptNo}</div>
    <div style="font-size:12px;color:#999;margin-top:4px;">Date: ${sale.date}</div></div>
    <div class="info-grid">
      <div class="info-box"><div class="info-label">Customer</div><div class="info-value">${sale.customerName}</div></div>
      <div class="info-box"><div class="info-label">Vehicle</div><div class="info-value">${vehicleNo}</div></div>
      <div class="info-box"><div class="info-label">Weight</div><div class="info-value">${n(sale.weight).toLocaleString()} kg</div></div>
      <div class="info-box"><div class="info-label">Rate</div><div class="info-value">Rs.${fmt(sale.rate)}/kg</div></div>
    </div>
    <table class="table">
      <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        <tr><td>Chicken Sale (${n(sale.weight).toLocaleString()} kg × Rs.${fmt(sale.rate)})</td><td style="text-align:right;font-family:monospace">Rs.${Math.round(sale.totalAmount).toLocaleString()}</td></tr>
        ${(sale.receipts||[]).map(r=>`<tr style="color:#16a34a"><td>✅ Payment received (${r.date})</td><td style="text-align:right;font-family:monospace">- Rs.${Math.round(r.amount).toLocaleString()}</td></tr>`).join("")}
        <tr class="total-row"><td><strong>Balance Due</strong></td><td style="text-align:right;font-family:monospace"><strong>Rs.${Math.round(balance).toLocaleString()}</strong></td></tr>
      </tbody>
    </table>
    <div class="balance ${balance>0?"due":"paid"}">${balance>0?"🔴 Amount Due: Rs."+Math.round(balance).toLocaleString():"🟢 FULLY PAID — Account Clear"}</div>
    ${sale.notes?`<div style="margin-top:12px;font-size:12px;color:#666;background:#f9f9f9;padding:8px 12px;border-radius:8px;">Note: ${sale.notes}</div>`:""}
    <div class="footer">Powered by ChickenFlow · Generated ${dateStr}</div>
    </div></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(()=>w.print(),500);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:600,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:C.card,borderRadius:16,width:"100%",maxWidth:520,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Header */}
        <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{fontWeight:800,fontSize:15}}>📄 Invoice Preview</div>
          <button onClick={onClose} style={{background:"transparent",color:C.muted,fontSize:20,border:"none",cursor:"pointer"}}>✕</button>
        </div>
        {/* Invoice preview */}
        <div style={{overflowY:"auto",flex:1,padding:18}}>
          <div ref={invoiceRef} style={{background:"#ffffff",borderRadius:12,padding:24,color:"#111",fontFamily:"Arial,sans-serif"}}>
            {/* Invoice Header */}
            <div style={{textAlign:"center",marginBottom:20,borderBottom:"3px solid #f59e0b",paddingBottom:16}}>
              <div style={{fontSize:22,fontWeight:900,color:"#f59e0b",letterSpacing:"-0.02em"}}>🐔 ChickenFlow</div>
              <div style={{fontSize:13,color:"#555",marginTop:4}}>Invoice #{sale.receiptNo}</div>
              <div style={{fontSize:12,color:"#999",marginTop:2}}>Date: {sale.date} · Vehicle: {vehicleNo}</div>
            </div>
            {/* Customer */}
            <div style={{background:"#fff8e6",borderRadius:10,padding:"12px 14px",marginBottom:16,border:"1px solid #f59e0b44"}}>
              <div style={{fontSize:10,color:"#999",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Bill To</div>
              <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{sale.customerName}</div>
              {sale.driver&&<div style={{fontSize:12,color:"#666",marginTop:2}}>Driver: {sale.driver}</div>}
            </div>
            {/* Details grid */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
              {[["Weight",`${n(sale.weight).toLocaleString()} kg`],["Rate",`Rs.${fmt(sale.rate)}/kg`],["Total",`Rs.${Math.round(sale.totalAmount).toLocaleString()}`]].map(([l,v])=>(
                <div key={l} style={{background:"#f9f9f9",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#999",textTransform:"uppercase",marginBottom:4}}>{l}</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#111"}}>{v}</div>
                </div>
              ))}
            </div>
            {/* Payments table */}
            {(sale.receipts||[]).length>0&&(
              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,color:"#999",fontWeight:700,textTransform:"uppercase",marginBottom:6}}>Payment History</div>
                {sale.receipts.map(r=>(
                  <div key={r.id} style={{display:"flex",justifyContent:"space-between",padding:"7px 10px",background:"#f0fdf4",borderRadius:6,marginBottom:4,border:"1px solid #bbf7d0"}}>
                    <div style={{fontSize:12,color:"#16a34a"}}>✅ {r.date} {r.method?`(${r.method})`:""}</div>
                    <div style={{fontSize:12,fontWeight:700,color:"#16a34a",fontFamily:"monospace"}}>Rs.{Math.round(r.amount).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
            {/* Balance */}
            <div style={{background:balance>0?"#fee2e2":"#dcfce7",borderRadius:10,padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",border:`1px solid ${balance>0?"#fca5a5":"#86efac"}`}}>
              <div style={{fontSize:13,fontWeight:700,color:balance>0?"#dc2626":"#16a34a"}}>{balance>0?"Balance Due":"Fully Paid ✓"}</div>
              <div style={{fontSize:18,fontWeight:900,color:balance>0?"#dc2626":"#16a34a",fontFamily:"monospace"}}>Rs.{Math.round(Math.abs(balance)).toLocaleString()}</div>
            </div>
            {sale.notes&&<div style={{marginTop:12,fontSize:12,color:"#666",background:"#f9f9f9",padding:"8px 12px",borderRadius:8}}>Note: {sale.notes}</div>}
            <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#bbb",borderTop:"1px solid #eee",paddingTop:12}}>Powered by ChickenFlow · {dateStr}</div>
          </div>
        </div>
        {/* Action buttons */}
        <div style={{padding:"12px 18px",borderTop:`1px solid ${C.border}`,display:"flex",gap:8,flexShrink:0,flexWrap:"wrap"}}>
          <button onClick={printInvoice} style={{flex:1,background:C.card2,color:C.text,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",fontSize:13,fontWeight:700,cursor:"pointer"}}>🖨 Print</button>
          <button onClick={downloadPDF} style={{flex:1,background:C.blueSoft,color:C.blue,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"10px 12px",fontSize:13,fontWeight:700,cursor:"pointer"}}>📥 Download PDF</button>
        </div>
      </div>
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
  const [invoiceSale,setInvoiceSale]=useState(null);

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
    const saleAmt=wt*rate;
    // ── Credit limit check ──
    if(cu&&cu.creditLimit>0){
      const existingDue=vehicles.reduce((s,v)=>s+v.sales.filter(sl=>sl.customerId===cu.id).reduce((ss,sl)=>{const col=(sl.receipts||[]).reduce((a,r)=>a+n(r.amount),0);return ss+Math.max(0,sl.totalAmount-col);},0),0)+(n(cu.openingBalance)||0);
      const newTotal=existingDue+saleAmt;
      if(newTotal>cu.creditLimit){
        const over=fmtRs(newTotal-cu.creditLimit);
        const proceed=window.confirm(`⚠️ CREDIT LIMIT WARNING

Customer: ${cu.name}
Credit Limit: ${fmtRs(cu.creditLimit)}
Current Due: ${fmtRs(existingDue)}
This Sale: ${fmtRs(saleAmt)}
New Total: ${fmtRs(newTotal)}

This sale will exceed the limit by ${over}.

Press OK to proceed anyway, or Cancel to stop.`);
        if(!proceed) return;
      } else if(newTotal>cu.creditLimit*0.8){
        alert(`⚠️ CREDIT WARNING

Customer: ${cu.name} is at ${Math.round(newTotal/cu.creditLimit*100)}% of their credit limit (${fmtRs(cu.creditLimit)}).

Current balance after this sale: ${fmtRs(newTotal)}`);
      }
    }
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
    if(n(form.weight)>c.remaining+0.01) return alert(`Only ${fmtKg(c.remaining)} available`);
    const transferId=genId();
    const toVehicleId=form.toVehicleId||null;
    const toVehicle=vehicles.find(v=>v.id===toVehicleId);
    const type=toVehicleId?"vehicle":"farm";
    // Add transfer-out to current vehicle
    mut(v=>({...v,transfers:[...v.transfers,{
      id:transferId,weight:n(form.weight),date:form.date||today(),
      note:form.note||"",type,
      toVehicleId:toVehicleId||null,
      toVehicleNo:toVehicle?.vehicleNo||null,
      status:"sent",direction:"out"
    }]}));
    // If transferring to another vehicle, add transfer-in entry there too
    if(toVehicleId){
      setVehicles(p=>p.map(v=>v.id===toVehicleId?{...v,
        transfers:[...v.transfers,{
          id:genId(),linkedTransferId:transferId,weight:n(form.weight),
          date:form.date||today(),note:form.note||"",type:"vehicle",
          fromVehicleId:vehicle.id,fromVehicleNo:vehicle.vehicleNo,
          status:"received",direction:"in"
        }]
      }:v));
    }
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
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
        <StatBox label="Purchased" value={fmtKg(c.purchased)} color={C.blue}/>
        <StatBox label="Transit Loss" value={fmtKg(c.transitLoss)} color={C.red}/>
        <StatBox label="Received" value={fmtKg(c.received)} color={C.amber}/>
        <StatBox label="Sold" value={fmtKg(c.soldWt)} color={C.green}/>
        <StatBox label="Transferred" value={fmtKg(c.transferWt)} color={C.purple}/>
        <StatBox label="Remaining" value={fmtKg(c.remaining)} color={c.remaining>0?C.green:C.muted}/>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",padding:"2px 0"}}>
        {TABS.map(t=>(<button key={t} onClick={()=>setTab(t)} style={{padding:"8px 14px",borderRadius:20,flexShrink:0,background:tab===t?C.amber:C.card,color:tab===t?"#000":C.muted,border:`1px solid ${tab===t?C.amber:C.border}`,fontWeight:tab===t?700:500,textTransform:"uppercase",fontSize:11,whiteSpace:"nowrap",minHeight:36}}>{t}</button>))}
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
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15,marginBottom:3}}>📦 {p.supplierName}</div>
                    <div style={{fontSize:12,color:C.muted}}>{p.date} {p.time?`at ${p.time}`:""} · {fmtKg(p.weight)} @ Rs.{fmt(p.rate)}/kg{p.transitLoss>0&&<span style={{color:C.red}}> · Loss: {fmtKg(p.transitLoss)}</span>}</div></div>
                  <div style={{textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                    <div className="mono" style={{fontSize:16,fontWeight:800,color:C.amber}}>{fmtRs(n(p.weight)*n(p.rate))}</div>
                    <Tag color={bal>0?C.red:C.green}>{bal>0?`Due: ${fmtRs(bal)}`:"Fully Paid"}</Tag>
                    {vehicle.status==="active"&&<button onClick={()=>{if(window.confirm(`Delete purchase from ${p.supplierName} (${fmtKg(p.weight)})? This cannot be undone.`))mut(v=>({...v,purchases:v.purchases.filter(x=>x.id!==p.id)}));}} style={{background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,borderRadius:6,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer",marginTop:2}}>🗑 Delete</button>}
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
                  <StatBox label="Total Cost" value={fmtRs(n(p.weight)*n(p.rate))} color={C.amber}/>
                  <StatBox label="Paid" value={fmtRs(paid)} color={C.green}/>
                  <StatBox label="Balance" value={fmtRs(bal)} color={bal>0?C.red:C.green}/>
                </div>
                {p.payments?.length>0&&(<table style={{width:"100%",borderCollapse:"collapse",marginBottom:10}}><thead><tr>{["Date","Amount","Method","Note",""].map(h=><TH key={h} ch={h}/>)}</tr></thead><tbody>{p.payments.map(r=><tr key={r.id}><TD color={C.muted}>{r.date}</TD><TD color={C.green} mono bold>{fmtRs(r.amount)}</TD><TD><Tag color={C.amber}>{r.method}</Tag></TD><TD color={C.muted}>{r.note||"—"}</TD><TD><button onClick={()=>{if(window.confirm(`Delete payment of ${fmtRs(r.amount)}?`))mut(v=>({...v,purchases:v.purchases.map(x=>x.id===p.id?{...x,payments:(x.payments||[]).filter(pay=>pay.id!==r.id)}:x)}));}} style={{background:"transparent",color:C.red,border:"none",fontSize:13,cursor:"pointer",padding:"2px 6px"}}>🗑</button></TD></tr>)}</tbody></table>)}
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
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,width:"100%"}}>
              <Btn color="blue" small onClick={()=>{setImportReceiptsPreview([]);setImportReceiptsError("");setImportReceiptsAccountId("");setModal("importReceipts");}}>📥 Receipts</Btn>
              <Btn color="purple" small onClick={()=>{setImportSalesPreview([]);setImportSalesError("");setModal("importSales");}}>📥 Import</Btn>
              <Btn color="green" onClick={openBatchSale}>⚡ Batch</Btn>
              <Btn color="amber" onClick={()=>openModal("sale")}>+ Single</Btn>
            </div>
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
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15,marginBottom:3}}>🧾 <span style={{color:C.amber}}>{sale.receiptNo}</span> — {sale.customerName}{sale.notes?.includes("Batch")&&<span style={{marginLeft:8,background:C.purpleSoft,color:C.purple,padding:"1px 8px",borderRadius:10,fontSize:10,fontWeight:700}}>BATCH</span>}</div>
                    <div style={{fontSize:12,color:C.muted}}>{sale.date} · {fmtKg(sale.weight)} @ Rs.{fmt(sale.rate)}/kg{sale.driver?<span> · Driver: {sale.driver}</span>:""}</div></div>
                  <div style={{textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                    <div className="mono" style={{fontSize:16,fontWeight:800,color:C.green}}>{fmtRs(sale.totalAmount)}</div>
                    <Tag color={saleBalance>0?C.red:C.green}>{saleBalance>0?`Pending: ${fmtRs(saleBalance)}`:"Fully Collected"}</Tag>
                    {vehicle.status==="active"&&<button onClick={()=>{if(window.confirm(`Delete sale ${sale.receiptNo}? This cannot be undone.`))mut(v=>({...v,sales:v.sales.filter(s=>s.id!==sale.id)}));}} style={{background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,borderRadius:6,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer",marginTop:2}}>🗑 Delete</button>}
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
                  <StatBox label="Sale Amount" value={fmtRs(sale.totalAmount)} color={C.amber}/>
                  <StatBox label="Collected" value={fmtRs(collected)} color={C.green}/>
                  <StatBox label="Balance" value={fmtRs(saleBalance)} color={saleBalance>0?C.red:C.green}/>
                </div>
                {(sale.receipts||[]).length>0&&(<table style={{width:"100%",borderCollapse:"collapse",marginBottom:10}}><thead><tr>{["Date","Amount","Method","Acct","Note",""].map(h=><TH key={h} ch={h}/>)}</tr></thead><tbody>{sale.receipts.map(r=><tr key={r.id}><TD color={C.muted}>{r.date}</TD><TD color={C.green} mono bold>{fmtRs(r.amount)}</TD><TD><Tag color={C.blue}>{r.method||"Cash"}</Tag></TD><TD color={C.muted}>{r.accountName||"—"}</TD><TD color={C.muted}>{r.note||"—"}</TD><TD><button onClick={()=>{if(window.confirm("Delete this receipt?"))mut(v=>({...v,sales:v.sales.map(s=>s.id===sale.id?{...s,receipts:(s.receipts||[]).filter(x=>x.id!==r.id)}:s)}));}} style={{background:"transparent",color:C.red,border:"none",fontSize:13,cursor:"pointer",padding:"2px 6px"}}>🗑</button></TD></tr>)}</tbody></table>)}
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
                  {saleBalance>0&&<Btn color="green" small onClick={()=>{setSelId(sale.id);openModal("receipt");}}>+ Add Receipt</Btn>}
                  <button onClick={()=>setInvoiceSale(sale)} style={{background:C.blueSoft,color:C.blue,border:`1px solid ${C.blue}33`,borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer"}}>📄 Invoice</button>
                  <button onClick={()=>{
                    const collected2=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
                    const bal2=sale.totalAmount-collected2;
                    const lines=[];
                    lines.push("🐔 *ChickenFlow Invoice*");
                    lines.push("━━━━━━━━━━━━━━━━━━━━━");
                    lines.push("🧾 *Invoice:* "+sale.receiptNo);
                    lines.push("👤 *Customer:* "+sale.customerName);
                    lines.push("📅 *Date:* "+sale.date);
                    lines.push("━━━━━━━━━━━━━━━━━━━━━");
                    lines.push("⚖️ *Weight:* "+sale.weight+" kg");
                    lines.push("💵 *Rate:* Rs."+fmt(sale.rate)+"/kg");
                    lines.push("💰 *Total Amount:* Rs."+Math.round(sale.totalAmount).toLocaleString());
                    lines.push("✅ *Received:* Rs."+Math.round(collected2).toLocaleString());
                    if(bal2>0) lines.push("🔴 *Balance Due:* Rs."+Math.round(bal2).toLocaleString());
                    else lines.push("🟢 *Fully Paid ✓*");
                    lines.push("");
                    lines.push("_Sent via ChickenFlow_ 🐔");
                    window.open("https://wa.me/?text="+encodeURIComponent(lines.join("\n")),"_blank");
                  }} style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer"}}>📲 Share</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab==="transfers"&&(()=>{
        const outTransfers=vehicle.transfers.filter(t=>t.direction!=="in");
        const inTransfers=vehicle.transfers.filter(t=>t.direction==="in");
        const totalOut=outTransfers.reduce((s,t)=>s+n(t.weight),0);
        const totalIn=inTransfers.reduce((s,t)=>s+n(t.weight),0);
        return(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <h2 style={{fontSize:16,fontWeight:700}}>🚛 Stock Transfers</h2>
              {vehicle.status==="active"&&<Btn onClick={()=>{setForm({date:today()});openModal("transfer");}}>+ New Transfer</Btn>}
            </div>

            {/* Summary cards */}
            {(totalOut>0||totalIn>0)&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
                {[
                  ["📤 Sent Out",fmtKg(totalOut),C.orange,outTransfers.length+" transfers"],
                  ["📥 Received In",fmtKg(totalIn),C.blue,inTransfers.length+" transfers"],
                  ["📦 Net Transfer",totalIn>totalOut?`+${fmtKg(totalIn-totalOut)}`:`-${fmtKg(totalOut-totalIn)}`,totalIn>=totalOut?C.green:C.red,"net stock movement"],
                ].map(([l,v,col,sub])=>(
                  <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                    <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
                    <div className="mono" style={{fontSize:15,fontWeight:800,color:col}}>{v}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:3}}>{sub}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Transfers sent OUT */}
            {outTransfers.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,color:C.orange,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>📤 Transfers Out ({outTransfers.length})</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr><TH ch="Date"/><TH ch="Weight"/><TH ch="To"/><TH ch="Type"/><TH ch="Note"/><TH ch=""/></tr></thead>
                    <tbody>
                      {outTransfers.map(t=>(
                        <tr key={t.id}>
                          <TD color={C.muted}>{t.date}</TD>
                          <TD mono bold color={C.orange}>{fmtKg(t.weight)}</TD>
                          <TD>{t.toVehicleNo?<Tag color={C.blue}>🚛 {t.toVehicleNo}</Tag>:<Tag color={C.muted}>🌾 Farm</Tag>}</TD>
                          <TD><Tag color={t.type==="vehicle"?C.blue:C.purple}>{t.type==="vehicle"?"Vehicle→Vehicle":"To Farm"}</Tag></TD>
                          <TD color={C.muted}>{t.note||"—"}</TD>
                          <TD><button onClick={()=>{
                            if(!window.confirm(`Delete this transfer of ${fmtKg(t.weight)}? This cannot be undone.`))return;
                            // Remove from current vehicle
                            mut(v=>({...v,transfers:v.transfers.filter(x=>x.id!==t.id)}));
                            // If linked to another vehicle, remove the in-entry there too
                            if(t.toVehicleId){
                              setVehicles(p=>p.map(v=>v.id===t.toVehicleId?{...v,transfers:v.transfers.filter(x=>x.linkedTransferId!==t.id)}:v));
                            }
                          }} style={{background:"transparent",color:C.red,border:"none",fontSize:13,cursor:"pointer",padding:"2px 6px"}}>🗑</button></TD>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={5} style={{padding:"8px 12px",background:C.card2,fontSize:11,fontWeight:700,color:C.muted}}>TOTAL SENT</td>
                        <td style={{padding:"8px 12px",background:C.card2}}><span className="mono" style={{fontWeight:700,color:C.orange}}>{fmtKg(totalOut)}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Transfers received IN */}
            {inTransfers.length>0&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,color:C.blue,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>📥 Received From Other Vehicles ({inTransfers.length})</div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr><TH ch="Date"/><TH ch="Weight"/><TH ch="From Vehicle"/><TH ch="Note"/></tr></thead>
                    <tbody>
                      {inTransfers.map(t=>(
                        <tr key={t.id}>
                          <TD color={C.muted}>{t.date}</TD>
                          <TD mono bold color={C.blue}>{fmtKg(t.weight)}</TD>
                          <TD><Tag color={C.teal}>🚛 {t.fromVehicleNo||"Unknown"}</Tag></TD>
                          <TD color={C.muted}>{t.note||"—"}</TD>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={3} style={{padding:"8px 12px",background:C.card2,fontSize:11,fontWeight:700,color:C.muted}}>TOTAL RECEIVED</td>
                        <td style={{padding:"8px 12px",background:C.card2}}><span className="mono" style={{fontWeight:700,color:C.blue}}>{fmtKg(totalIn)}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {vehicle.transfers.length===0&&<Empty icon="🚛" text="No transfers yet. Use '+ New Transfer' to send stock to a farm or another vehicle."/>}
          </div>
        );
      })()}

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
                    {vehicle.expenses.map(e=><tr key={e.id}><TD color={C.muted}>{e.date}</TD><TD bold>{e.description}</TD><TD><Tag color={C.purple}>{e.type}</Tag></TD><TD color={C.red} mono bold>{fmtRs(e.amount)}</TD><TD><button onClick={()=>{if(window.confirm(`Delete expense "${e.description}" Rs.${fmt(e.amount)}?`))mut(v=>({...v,expenses:v.expenses.filter(x=>x.id!==e.id)}));}} style={{background:"transparent",color:C.red,border:"none",fontSize:13,cursor:"pointer",padding:"2px 6px"}}>🗑</button></TD></tr>)}
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

      {tab==="p&l"&&(()=>{
        // ── Derived values ──
        const margin=c.totalSaleValue>0?((c.pnl/c.totalSaleValue)*100):0;
        const revPerKg=c.soldWt>0?c.totalSaleValue/c.soldWt:0;
        const costPerKg=c.soldWt>0?c.totalCost/c.soldWt:0;
        const purchCost=c.purchaseCost;
        const vehExp=vehicle.expenses.reduce((s,x)=>s+n(x.amount),0);
        const lnkExp=c.linkedExpenses;
        const totalCostParts=[purchCost,vehExp,lnkExp].reduce((s,x)=>s+x,0)||1;

        // Expense by type breakdown
        const expByType={};
        vehicle.expenses.forEach(e=>{expByType[e.type||"Other"]=(expByType[e.type||"Other"]||0)+n(e.amount);});
        linkedTxns.forEach(t=>{expByType["Linked/Salary"]=(expByType["Linked/Salary"]||0)+n(t.amount);});

        // Customer contribution
        const custContrib={};
        vehicle.sales.forEach(s=>{
          if(!custContrib[s.customerName]) custContrib[s.customerName]={name:s.customerName,wt:0,amt:0};
          custContrib[s.customerName].wt+=n(s.weight);
          custContrib[s.customerName].amt+=n(s.totalAmount);
        });
        const topCusts=Object.values(custContrib).sort((a,b)=>b.amt-a.amt).slice(0,5);

        // Daily sales sparkline data
        const dayMap={};
        vehicle.sales.forEach(s=>{dayMap[s.date]=(dayMap[s.date]||0)+n(s.totalAmount);});
        const dayKeys=Object.keys(dayMap).sort();
        const dayVals=dayKeys.map(k=>dayMap[k]);
        const maxVal=Math.max(...dayVals,1);
        const sparkW=280,sparkH=60;
        const sparkPts=dayVals.map((v,i)=>{
          const x=dayVals.length<2?sparkW/2:i*(sparkW/(dayVals.length-1));
          const y=sparkH-Math.round((v/maxVal)*(sparkH-8))-4;
          return `${x},${y}`;
        }).join(" ");

        // Bar chart: Revenue vs Cost vs Profit
        const barMax=Math.max(c.totalSaleValue,c.totalCost,1);
        const bars=[
          {label:"Revenue",val:c.totalSaleValue,color:C.green},
          {label:"Cost",val:c.totalCost,color:C.red},
          {label:c.pnl>=0?"Profit":"Loss",val:Math.abs(c.pnl),color:c.pnl>=0?C.teal:C.orange},
        ];

        // Cost donut segments (CSS conic-gradient)
        const purchPct=Math.round((purchCost/totalCostParts)*100);
        const vehPct=Math.round((vehExp/totalCostParts)*100);
        const lnkPct=100-purchPct-vehPct;
        const donutGradient=`conic-gradient(${C.amber} 0% ${purchPct}%, ${C.red} ${purchPct}% ${purchPct+vehPct}%, ${C.orange} ${purchPct+vehPct}% 100%)`;

        return(
          <div>
            {/* ── TOP KPI CARDS ── */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
              <div style={{background:C.card,border:`1px solid ${c.pnl>=0?C.green:C.red}44`,borderRadius:12,padding:"14px 16px",gridColumn:"1/-1"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>{c.pnl>=0?"📈 Net Profit":"📉 Net Loss"}</div>
                <div className="mono" style={{fontSize:28,fontWeight:800,color:c.pnl>=0?C.green:C.red}}>{c.pnl>=0?"+ ":"− "}{fmtRs(Math.abs(c.pnl))}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:4}}>Margin: <span style={{color:c.pnl>=0?C.green:C.red,fontWeight:700}}>{margin.toFixed(1)}%</span></div>
              </div>
              {[["💰 Revenue",fmtRs(c.totalSaleValue),C.green],["💸 Total Cost",fmtRs(c.totalCost),C.red],["📦 Rev/kg",`Rs.${fmt(revPerKg)}`,C.amber],["🏷 Cost/kg",`Rs.${fmt(costPerKg)}`,C.orange]].map(([l,v,col])=>(
                <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
                  <div className="mono" style={{fontSize:15,fontWeight:800,color:col}}>{v}</div>
                </div>
              ))}
            </div>

            {/* ── BAR CHART: Revenue vs Cost vs P&L ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14}}>📊 Revenue vs Cost vs {c.pnl>=0?"Profit":"Loss"}</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {bars.map(b=>{
                  const pct=Math.round((b.val/barMax)*100);
                  return(
                    <div key={b.label}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:12,color:C.muted,fontWeight:600}}>{b.label}</span>
                        <span className="mono" style={{fontSize:12,fontWeight:700,color:b.color}}>{fmtRs(b.val)}</span>
                      </div>
                      <div style={{background:C.card2,borderRadius:20,height:14,overflow:"hidden"}}>
                        <div style={{width:pct+"%",height:"100%",background:b.color,borderRadius:20,transition:"width 0.5s ease",minWidth:pct>0?"4px":"0"}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── COST BREAKDOWN DONUT + LEGEND ── */}
            {c.totalCost>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14}}>🥧 Cost Breakdown</div>
                <div style={{display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
                  {/* Donut */}
                  <div style={{width:100,height:100,borderRadius:"50%",background:donutGradient,flexShrink:0,position:"relative",boxShadow:"0 0 0 16px "+C.card+" inset"}}>
                    <div style={{position:"absolute",inset:"16px",borderRadius:"50%",background:C.card,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column"}}>
                      <div style={{fontSize:9,color:C.muted,fontWeight:700}}>TOTAL</div>
                      <div style={{fontSize:11,fontWeight:800,color:C.text}}>{fmtRs(c.totalCost)}</div>
                    </div>
                  </div>
                  {/* Legend */}
                  <div style={{flex:1,minWidth:150}}>
                    {[["Purchase Cost",purchCost,C.amber,purchPct],["Vehicle Expenses",vehExp,C.red,vehPct],["Linked/Salaries",lnkExp,C.orange,lnkPct]].filter(([,v])=>v>0).map(([l,v,col,pct])=>(
                      <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{width:10,height:10,borderRadius:"50%",background:col,flexShrink:0}}/>
                          <span style={{fontSize:12,color:C.muted}}>{l}</span>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <span className="mono" style={{fontSize:12,fontWeight:700,color:col}}>{fmtRs(v)}</span>
                          <span style={{fontSize:10,color:C.muted,marginLeft:5}}>{pct}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── DAILY SALES SPARKLINE ── */}
            {dayKeys.length>1&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>📈 Daily Sales Trend</div>
                <div style={{overflowX:"auto"}}>
                  <svg width={Math.max(sparkW,dayKeys.length*32)} height={sparkH+20} style={{display:"block"}}>
                    <polyline points={sparkPts} fill="none" stroke={C.green} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
                    {dayVals.map((v,i)=>{
                      const x=i*(sparkW/(dayVals.length-1));
                      const y=sparkH-Math.round((v/maxVal)*(sparkH-8))-4;
                      return <circle key={i} cx={x} cy={y} r="4" fill={C.green} stroke={C.card} strokeWidth="2"/>;
                    })}
                    {dayKeys.map((d,i)=>{
                      const x=i*(sparkW/(dayVals.length-1));
                      return <text key={i} x={x} y={sparkH+16} textAnchor="middle" fontSize="8" fill={C.muted}>{d.slice(5)}</text>;
                    })}
                  </svg>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted,marginTop:4}}>
                  <span>{dayKeys.length} sale days</span>
                  <span>Peak: <span style={{color:C.green,fontWeight:700}}>{fmtRs(maxVal)}</span></span>
                </div>
              </div>
            )}

            {/* ── TOP CUSTOMERS ── */}
            {topCusts.length>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>👤 Customer Contribution</div>
                {topCusts.map((cu,i)=>{
                  const pct=c.totalSaleValue>0?Math.round((cu.amt/c.totalSaleValue)*100):0;
                  return(
                    <div key={i} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontSize:12,fontWeight:600}}>{cu.name}</span>
                        <div style={{display:"flex",gap:8}}>
                          <span style={{fontSize:11,color:C.muted}}>{cu.wt.toLocaleString()} kg</span>
                          <span className="mono" style={{fontSize:12,fontWeight:700,color:C.green}}>{fmtRs(cu.amt)}</span>
                          <span style={{fontSize:11,color:C.muted}}>{pct}%</span>
                        </div>
                      </div>
                      <div style={{background:C.card2,borderRadius:20,height:6,overflow:"hidden"}}>
                        <div style={{width:pct+"%",height:"100%",background:C.blue,borderRadius:20}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── EXPENSE BREAKDOWN BY TYPE ── */}
            {Object.keys(expByType).length>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>💸 Expense Breakdown</div>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr><TH ch="Type"/><TH ch="Amount" right/><TH ch="% of Cost" right/></tr></thead>
                  <tbody>
                    {Object.entries(expByType).sort((a,b)=>b[1]-a[1]).map(([type,amt])=>(
                      <tr key={type}>
                        <TD><Tag color={C.orange}>{type}</Tag></TD>
                        <TD right mono color={C.red} bold>{fmtRs(amt)}</TD>
                        <TD right><span style={{fontSize:11,color:C.muted}}>{c.totalCost>0?Math.round((amt/c.totalCost)*100):0}%</span></TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── FULL P&L STATEMENT ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px"}}>
              <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:14}}>📋 Full P&L Statement</div>
              <Label>REVENUE</Label>
              <Row2 label="Total Sale Value" value={fmtRs(c.totalSaleValue)} color={C.green}/>
              <div style={{height:1,background:C.border,margin:"12px 0"}}/>
              <Label>COSTS</Label>
              {vehicle.purchases.map(p=><Row2 key={p.id} label={`${p.supplierName} (${fmtKg(p.weight)} × Rs.${fmt(p.rate)})`} value={fmtRs(n(p.weight)*n(p.rate))} color={C.red}/>)}
              {vehicle.expenses.map(e=><Row2 key={e.id} label={`${e.description} [${e.type||""}]`} value={fmtRs(e.amount)} color={C.red}/>)}
              {linkedTxns.map(t=><Row2 key={t.id} label={t.description} value={fmtRs(t.amount)} color={C.orange}/>)}
              <div style={{height:1,background:C.border,margin:"12px 0"}}/>
              <Row2 label="Total Revenue" value={fmtRs(c.totalSaleValue)} color={C.green} bold/>
              <Row2 label="Total Cost" value={fmtRs(c.totalCost)} color={C.red} bold/>
              <div style={{height:1,background:C.border,margin:"12px 0"}}/>
              <div style={{padding:16,borderRadius:10,background:c.pnl>=0?C.greenSoft:C.redSoft,border:`1px solid ${c.pnl>=0?C.green:C.red}33`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:14,fontWeight:800}}>{c.pnl>=0?"✅ Net Profit":"❌ Net Loss"}</span>
                <span className="mono" style={{fontSize:20,fontWeight:800,color:c.pnl>=0?C.green:C.red}}>{fmtRs(Math.abs(c.pnl))}</span>
              </div>
            </div>
          </div>
        );
      })()}

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
        <Modal title="🚛 Record Transfer" onSave={addTransfer} saveLabel="Record" onClose={closeModal} width={480}>
          <div style={{background:C.amberSoft,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"9px 14px",marginBottom:14,fontSize:13,color:C.amber}}>
            ⚖️ Available stock: <strong className="mono">{fmtKg(c.remaining)}</strong>
          </div>
          <Fld label="Transfer To">
            <select value={form.toVehicleId||""} onChange={fv("toVehicleId")}>
              <option value="">🌾 Farm / External (no vehicle)</option>
              {vehicles.filter(v=>v.id!==vehicle.id&&v.status==="active").map(v=>(
                <option key={v.id} value={v.id}>🚛 {v.vehicleNo}{v.driverName?` — ${v.driverName}`:""}</option>
              ))}
            </select>
          </Fld>
          {form.toVehicleId&&(
            <div style={{background:C.blueSoft,border:`1px solid ${C.blue}33`,borderRadius:8,padding:"9px 14px",fontSize:12,color:C.blue,marginBottom:8}}>
              ✅ Stock will be automatically added to <strong>{vehicles.find(v=>v.id===form.toVehicleId)?.vehicleNo}</strong>
            </div>
          )}
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <Fld label="Weight (kg)"><input type="number" value={form.weight||""} onChange={fv("weight")} placeholder="e.g. 2000"/></Fld>
          <Fld label="Note"><input value={form.note||""} onChange={fv("note")} placeholder="e.g. Short on stock, sending extra"/></Fld>
          {form.weight&&n(form.weight)>c.remaining&&(
            <div style={{background:C.redSoft,border:`1px solid ${C.red}33`,borderRadius:8,padding:"9px 14px",fontSize:13,color:C.red}}>
              ⚠️ Cannot transfer {fmtKg(n(form.weight))} — only {fmtKg(c.remaining)} available
            </div>
          )}
        </Modal>
      )}
      {modal==="expense"&&(
        <Modal title="Add Expense" onSave={addExpense} saveLabel="Add" onClose={closeModal}>
          <AcctSelect accounts={accounts} value={form.accountId} onChange={e=>{const a=accounts.find(x=>x.id===e.target.value);setForm(p=>({...p,accountId:e.target.value,accountName:a?.name||""}));}} label="Pay From Account"/>
          <Fld label="Date"><input type="date" value={form.date||""} onChange={fv("date")}/></Fld>
          <Fld label="Description"><input value={form.description||""} onChange={fv("description")} placeholder="e.g. Toll tax, Petrol"/></Fld>
          <div style={{display:"flex",gap:12}}><Fld label="Type" half><select value={form.type||"Transit"} onChange={fv("type")}>{expenseCategories.map((ec,i)=>{const nc=normCat(ec);return <option key={i} value={nc.name}>{nc.name}</option>;})}</select></Fld><Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={fv("amount")} placeholder="e.g. 5000"/></Fld></div>
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
    onCreate({id:genId(),status:"active",vehicleNo:form.vehicleNo,driverName:form.driverName||"",driverId:form.driverId||null,date:form.date,time:form.time,origin:form.origin||"Punjab",
      supplierName:suppliers.find(s=>s.id===form.supplierId)?.name||"",purchases:[],sales:[],transfers:[],expenses:[]});
    onClose();
  };
  return(
    <Modal title="🚛 New Vehicle Project" onSave={save} saveLabel="Create Project" onClose={onClose}>
      <div style={{display:"flex",gap:12}}>
        <Fld label="Vehicle Number" half><input value={form.vehicleNo||""} onChange={f("vehicleNo")} placeholder="e.g. LEA-1234"/></Fld>
        <Fld label="Assign Driver" half>
          <select value={form.driverId||""} onChange={e=>{const dr=(typeof drivers!=="undefined"?drivers:[]).find(d=>d.id===e.target.value);f("driverId")({target:{value:e.target.value}});if(dr)f("driverName")({target:{value:dr.name}});}}>
            <option value="">— Type name or select —</option>
            {(typeof drivers!=="undefined"?drivers:[]).map(d=><option key={d.id} value={d.id}>{d.name}{d.phone?" · "+d.phone:""}</option>)}
          </select>
        </Fld>
        <Fld label="Driver Name (manual)" half><input value={form.driverName||""} onChange={f("driverName")} placeholder="Or type name directly"/></Fld>
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

// ─── PARTNERS & PROFIT DISTRIBUTION PAGE ────────────────────────────────────
function PartnersPage({partners,setPartners,distributions,setDistributions,vehicles,transactions}){
  const [modal,setModal]=useState(null); // "addPartner"|"editPartner"|"distribute"|"viewPartner"
  const [form,setForm]=useState({});
  const [selPartnerId,setSelPartnerId]=useState(null);
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const close=()=>{setModal(null);setForm({});};

  // ── Calculate total net profit from all vehicles ──
  const totalNetProfit=useMemo(()=>{
    return vehicles.reduce((s,v)=>{
      const cv=calcVehicle(v,transactions);
      return s+(cv.pnl||0);
    },0);
  },[vehicles,transactions]);

  // Total shares must add to 100
  const totalShares=(partners||[]).reduce((s,p)=>s+n(p.share),0);

  // Per-partner stats
  const partnerStats=useMemo(()=>{
    return (partners||[]).map(p=>{
      const myDists=(distributions||[]).filter(d=>d.partnerId===p.id);
      const totalDist=myDists.reduce((s,d)=>s+n(d.amount),0);
      const earnedShare=totalNetProfit>0?(n(p.share)/100)*totalNetProfit:0;
      const pending=Math.max(0,earnedShare-totalDist);
      return{...p,totalDist,earnedShare,pending,myDists};
    });
  },[partners,distributions,totalNetProfit]);

  const totalDistributed=(distributions||[]).reduce((s,d)=>s+n(d.amount),0);
  const totalEarned=totalNetProfit>0?totalNetProfit:0;
  const totalPending=Math.max(0,totalEarned-totalDistributed);

  // Save partner
  const savePartner=()=>{
    if(!form.name?.trim()) return alert("Enter partner name");
    const sh=n(form.share);
    if(sh<=0||sh>100) return alert("Share must be between 1 and 100");
    const othersTotal=(partners||[]).filter(p=>p.id!==(selPartnerId||"")).reduce((s,p)=>s+n(p.share),0);
    if(othersTotal+sh>100) return alert(`Total shares exceed 100%. Remaining: ${(100-othersTotal).toFixed(1)}%`);
    if(modal==="editPartner"&&selPartnerId){
      setPartners(p=>p.map(x=>x.id===selPartnerId?{...x,...form,share:sh}:x));
    } else {
      setPartners(p=>[...p,{id:genId(),name:form.name,share:sh,phone:form.phone||"",notes:form.notes||"",joinedAt:today()}]);
    }
    close();
  };

  // Save distribution
  const saveDist=()=>{
    if(!form.partnerId) return alert("Select a partner");
    if(!n(form.amount)) return alert("Enter amount");
    const partner=partners.find(p=>p.id===form.partnerId);
    setDistributions(p=>[...p,{
      id:genId(),
      partnerId:form.partnerId,
      partnerName:partner?.name||"",
      amount:n(form.amount),
      date:form.date||today(),
      period:form.period||"",
      method:form.method||"Cash",
      notes:form.notes||"",
      createdAt:today(),
    }]);
    close();
  };

  const deletePartner=(id)=>{
    if(!window.confirm("Delete this partner? Their distribution history will remain.")) return;
    setPartners(p=>p.filter(x=>x.id!==id));
  };

  const viewPartner=selPartnerId?partnerStats.find(p=>p.id===selPartnerId):null;

  // ── PARTNER DETAIL VIEW ──
  if(viewPartner&&modal!=="editPartner"){
    const myDists=[...viewPartner.myDists].sort((a,b)=>b.date.localeCompare(a.date));
    const pct=viewPartner.earnedShare>0?Math.min(100,Math.round(viewPartner.totalDist/viewPartner.earnedShare*100)):0;
    return(
      <div>
        <button onClick={()=>{setSelPartnerId(null);}} style={{background:"transparent",color:C.amber,fontSize:14,fontWeight:700,marginBottom:16,padding:"4px 0",border:"none",cursor:"pointer"}}>‹ Back to Partners</button>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>💼 {viewPartner.name}</h1>
            <div style={{fontSize:13,color:C.muted}}>{viewPartner.phone||"No phone"} · {viewPartner.share}% share · Joined {viewPartner.joinedAt||"—"}</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn color="amber" onClick={()=>{setForm({...viewPartner,share:String(viewPartner.share)});setModal("editPartner");}}>✏️ Edit</Btn>
            <Btn color="teal" onClick={()=>{setForm({partnerId:viewPartner.id,date:today(),method:"Cash"});setModal("distribute");}}>💸 Distribute</Btn>
            <Btn color="red" onClick={()=>deletePartner(viewPartner.id)}>🗑</Btn>
          </div>
        </div>

        {/* KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
          {[
            ["📊 Share",`${viewPartner.share}%`,C.blue,"of total profit"],
            ["💰 Earned (Est.)",fmtRs(viewPartner.earnedShare),C.teal,"from net P&L"],
            ["✅ Distributed",fmtRs(viewPartner.totalDist),C.green,`${myDists.length} payments`],
            ["⏳ Pending",fmtRs(viewPartner.pending),viewPartner.pending>0?C.amber:C.green,viewPartner.pending>0?"Not yet paid":"Fully settled"],
          ].map(([l,v,col,sub])=>(
            <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
              <div className="mono" style={{fontSize:15,fontWeight:800,color:col}}>{v}</div>
              <div style={{fontSize:11,color:C.muted,marginTop:3}}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Distribution progress bar */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px",marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontSize:12,fontWeight:700,color:C.muted}}>Distribution Progress</span>
            <span style={{fontSize:12,fontWeight:700,color:pct>=100?C.green:C.amber}}>{pct}% distributed</span>
          </div>
          <div style={{background:C.card2,borderRadius:20,height:12,overflow:"hidden"}}>
            <div style={{width:pct+"%",height:"100%",background:pct>=100?C.green:C.amber,borderRadius:20,transition:"width 0.5s ease"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:11,color:C.muted}}>
            <span>Paid: {fmtRs(viewPartner.totalDist)}</span>
            <span>Earned: {fmtRs(viewPartner.earnedShare)}</span>
          </div>
        </div>

        {/* Distribution history */}
        <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Distribution History ({myDists.length})</div>
        {myDists.length===0
          ?<Empty icon="💸" text="No distributions recorded yet"/>
          :(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr><TH ch="Date"/><TH ch="Period"/><TH ch="Method"/><TH ch="Notes"/><TH ch="Amount" right/></tr></thead>
                <tbody>
                  {myDists.map(d=>(
                    <tr key={d.id}>
                      <TD color={C.muted}>{d.date}</TD>
                      <TD color={C.muted}>{d.period||"—"}</TD>
                      <TD><Tag color={C.teal}>{d.method||"Cash"}</Tag></TD>
                      <TD color={C.muted} small>{d.notes||"—"}</TD>
                      <TD right mono bold color={C.green}>{fmtRs(d.amount)}</TD>
                    </tr>
                  ))}
                  <tr style={{background:C.card2}}>
                    <td colSpan={4} style={{padding:"9px 12px",fontSize:11,fontWeight:700,color:C.muted}}>TOTAL DISTRIBUTED</td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:800,color:C.green}}>{fmtRs(viewPartner.totalDist)}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        }

        {/* Distribute modal (shown while on detail) */}
        {modal==="distribute"&&(
          <Modal title="💸 Record Distribution" onSave={saveDist} saveLabel="Record" onClose={close} width={440}>
            <Fld label="Partner"><input value={viewPartner.name} disabled style={{opacity:0.6}}/></Fld>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Date" half><input type="date" value={form.date||today()} onChange={f("date")}/></Fld>
              <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="e.g. 50000"/></Fld>
            </div>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Period / Month" half><input value={form.period||""} onChange={f("period")} placeholder="e.g. April 2026"/></Fld>
              <Fld label="Method" half><select value={form.method||"Cash"} onChange={f("method")}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>JazzCash</option><option>EasyPaisa</option></select></Fld>
            </div>
            <Fld label="Notes (optional)"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes"/></Fld>
            {viewPartner.pending>0&&(
              <div style={{background:C.amberSoft,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"8px 12px",fontSize:12,color:C.amber,marginTop:4}}>
                💡 Estimated pending share: <strong>{fmtRs(viewPartner.pending)}</strong>
              </div>
            )}
          </Modal>
        )}

        {/* Edit modal (shown while on detail) */}
        {modal==="editPartner"&&(
          <Modal title="✏️ Edit Partner" onSave={savePartner} saveLabel="Save" onClose={close} width={440}>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Full Name" half><input value={form.name||""} onChange={f("name")} placeholder="Partner name"/></Fld>
              <Fld label="Share %" half><input type="number" value={form.share||""} onChange={f("share")} placeholder="e.g. 40" min="1" max="100"/></Fld>
            </div>
            <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="03XX-XXXXXXX"/></Fld>
            <Fld label="Notes"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes"/></Fld>
          </Modal>
        )}
      </div>
    );
  }

  // ── PARTNERS LIST ──
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>💼 Partners</h1>
          <p style={{color:C.muted,fontSize:13}}>{(partners||[]).length} partner{(partners||[]).length!==1?"s":""} · Shares: <span style={{color:totalShares===100?C.green:totalShares>100?C.red:C.amber,fontWeight:700}}>{totalShares.toFixed(1)}%</span> / 100%</p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn color="teal" onClick={()=>{setForm({partnerId:(partners||[])[0]?.id||"",date:today(),method:"Cash"});setModal("distribute");}}>💸 Distribute</Btn>
          <Btn color="amber" onClick={()=>{setForm({});setModal("addPartner");}}>+ Add Partner</Btn>
        </div>
      </div>

      {/* Business P&L overview */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:18,marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>📊 Business Overview</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[
            ["Net Profit (All Time)",fmtRs(Math.max(0,totalNetProfit)),totalNetProfit>=0?C.green:C.red],
            ["Total Distributed",fmtRs(totalDistributed),C.teal],
            ["Pending Distribution",fmtRs(totalPending),totalPending>0?C.amber:C.green],
          ].map(([l,v,col])=>(
            <div key={l} style={{background:C.card2,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
              <div className="mono" style={{fontSize:14,fontWeight:800,color:col}}>{v}</div>
            </div>
          ))}
        </div>

        {/* Share allocation pie (bar style) */}
        {(partners||[]).length>0&&(
          <div style={{marginTop:16}}>
            <div style={{fontSize:11,color:C.muted,fontWeight:700,marginBottom:8}}>Share Allocation</div>
            <div style={{display:"flex",height:16,borderRadius:20,overflow:"hidden",gap:2}}>
              {partnerStats.map((p,i)=>{
                const cols=[C.amber,C.teal,C.blue,C.purple,C.orange,C.green];
                const col=cols[i%cols.length];
                return <div key={p.id} style={{flex:p.share,background:col,minWidth:2}} title={`${p.name}: ${p.share}%`}/>;
              })}
              {totalShares<100&&<div style={{flex:100-totalShares,background:C.card2,minWidth:2}} title={`Unallocated: ${(100-totalShares).toFixed(1)}%`}/>}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"4px 12px",marginTop:8}}>
              {partnerStats.map((p,i)=>{
                const cols=[C.amber,C.teal,C.blue,C.purple,C.orange,C.green];
                return <span key={p.id} style={{fontSize:10,color:C.muted}}>
                  <span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:cols[i%cols.length],marginRight:4,verticalAlign:"middle"}}/>
                  {p.name} {p.share}%
                </span>;
              })}
              {totalShares<100&&<span style={{fontSize:10,color:C.muted}}>⬜ Unallocated {(100-totalShares).toFixed(1)}%</span>}
            </div>
          </div>
        )}
      </div>

      {/* Partner cards */}
      {partnerStats.length===0
        ?<Empty icon="💼" text="No partners yet. Add a partner to start tracking profit distribution."/>
        :(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {partnerStats.map((p,i)=>{
              const cols=[C.amber,C.teal,C.blue,C.purple,C.orange,C.green];
              const col=cols[i%cols.length];
              const pct=p.earnedShare>0?Math.min(100,Math.round(p.totalDist/p.earnedShare*100)):0;
              return(
                <div key={p.id} onClick={()=>setSelPartnerId(p.id)}
                  style={{background:C.card,border:`1px solid ${col}44`,borderRadius:14,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=col}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=col+"44"}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                        <span style={{fontSize:15,fontWeight:800}}>💼 {p.name}</span>
                        <Tag color={col}>{p.share}% share</Tag>
                        {p.pending===0&&p.earnedShare>0&&<Tag color={C.green}>✅ Settled</Tag>}
                      </div>
                      <div style={{fontSize:12,color:C.muted}}>{p.phone||"No phone"}{p.joinedAt?" · Joined "+p.joinedAt:""}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:14,fontWeight:800,color:col}}>{fmtRs(p.earnedShare)}</div>
                      <div style={{fontSize:10,color:C.muted}}>estimated share</div>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
                    {[["Distributed",fmtRs(p.totalDist),C.green],["Pending",fmtRs(p.pending),p.pending>0?C.amber:C.green],["Payments",p.myDists.length,C.muted]].map(([l,v,c])=>(
                      <div key={l} style={{background:C.card2,borderRadius:8,padding:"7px 8px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</div>
                        <div className="mono" style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {/* Progress bar */}
                  <div style={{background:C.card2,borderRadius:20,height:6,overflow:"hidden"}}>
                    <div style={{width:pct+"%",height:"100%",background:pct>=100?C.green:col,borderRadius:20,transition:"width 0.4s"}}/>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:10,color:C.muted}}>
                    <span>{pct}% distributed</span>
                    {p.myDists.length>0&&<span>Last: {p.myDists.sort((a,b)=>b.date.localeCompare(a.date))[0].date}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )
      }

      {/* Recent distributions */}
      {(distributions||[]).length>0&&(
        <div style={{marginTop:18}}>
          <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Recent Distributions</div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Date"/><TH ch="Partner"/><TH ch="Period"/><TH ch="Method"/><TH ch="Amount" right/></tr></thead>
              <tbody>
                {[...(distributions||[])].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10).map(d=>(
                  <tr key={d.id}>
                    <TD color={C.muted}>{d.date}</TD>
                    <TD bold>{d.partnerName}</TD>
                    <TD color={C.muted}>{d.period||"—"}</TD>
                    <TD><Tag color={C.teal}>{d.method||"Cash"}</Tag></TD>
                    <TD right mono bold color={C.green}>{fmtRs(d.amount)}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Partner modal */}
      {modal==="addPartner"&&(
        <Modal title="+ Add Partner" onSave={savePartner} saveLabel="Add Partner" onClose={close} width={440}>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Full Name" half><input value={form.name||""} onChange={f("name")} placeholder="Partner name"/></Fld>
            <Fld label="Share %" half><input type="number" value={form.share||""} onChange={f("share")} placeholder="e.g. 40" min="1" max="100"/></Fld>
          </div>
          <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="03XX-XXXXXXX"/></Fld>
          <Fld label="Notes"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes"/></Fld>
          <div style={{background:C.card2,borderRadius:8,padding:"8px 12px",fontSize:12,color:C.muted,marginTop:4}}>
            📊 Remaining unallocated: <strong style={{color:C.amber}}>{(100-totalShares).toFixed(1)}%</strong>
          </div>
        </Modal>
      )}

      {/* Distribute modal (from list) */}
      {modal==="distribute"&&(
        <Modal title="💸 Record Distribution" onSave={saveDist} saveLabel="Record" onClose={close} width={440}>
          <Fld label="Partner">
            <select value={form.partnerId||""} onChange={f("partnerId")}>
              <option value="">— Select Partner —</option>
              {(partners||[]).map(p=><option key={p.id} value={p.id}>{p.name} ({p.share}%)</option>)}
            </select>
          </Fld>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Date" half><input type="date" value={form.date||today()} onChange={f("date")}/></Fld>
            <Fld label="Amount (Rs)" half><input type="number" value={form.amount||""} onChange={f("amount")} placeholder="e.g. 50000"/></Fld>
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Period / Month" half><input value={form.period||""} onChange={f("period")} placeholder="e.g. April 2026"/></Fld>
            <Fld label="Method" half><select value={form.method||"Cash"} onChange={f("method")}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>JazzCash</option><option>EasyPaisa</option></select></Fld>
          </div>
          <Fld label="Notes (optional)"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes"/></Fld>
          {form.partnerId&&(()=>{
            const ps=partnerStats.find(p=>p.id===form.partnerId);
            return ps?.pending>0?<div style={{background:C.amberSoft,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"8px 12px",fontSize:12,color:C.amber,marginTop:4}}>
              💡 {ps.name}&apos;s estimated pending share: <strong>{fmtRs(ps.pending)}</strong>
            </div>:null;
          })()}
        </Modal>
      )}
    </div>
  );
}

// ─── AGING REPORT PAGE ───────────────────────────────────────────────────────
function AgingPage({vehicles,customers,setPage,setOpenId}){
  const [sortBy,setSortBy]=useState("amount"); // "amount"|"days"|"name"
  const [filterBucket,setFilterBucket]=useState("all");
  const [search,setSearch]=useState("");

  const BUCKETS=[
    {key:"0-15",  label:"0–15 days",  color:C.green,  bg:C.greenSoft,  min:0,  max:15},
    {key:"16-30", label:"16–30 days", color:C.amber,  bg:C.amberSoft,  min:16, max:30},
    {key:"31-60", label:"31–60 days", color:C.orange, bg:"#fff3e0",    min:31, max:60},
    {key:"60+",   label:"60+ days",   color:C.red,    bg:C.redSoft,    min:61, max:9999},
  ];

  // Build per-customer aging data
  const agingData=useMemo(()=>{
    const now=new Date();
    const custMap={};

    (customers||[]).forEach(c=>{custMap[c.id]={customerId:c.id,name:c.name,phone:c.phone||"",creditLimit:c.creditLimit||0,invoices:[],totalDue:0,maxDays:0,lastPayDate:null,lastSaleDate:null};});

    vehicles.forEach(v=>{
      v.sales.filter(s=>!s.deletedAt).forEach(sale=>{
        const collected=(sale.receipts||[]).reduce((s,r)=>s+n(r.amount),0);
        const bal=sale.totalAmount-collected;
        if(bal<0.01) return;
        const days=Math.max(0,Math.round((now-new Date(sale.date))/864e5));
        const bucket=BUCKETS.find(b=>days>=b.min&&days<=b.max)||BUCKETS[3];
        const lastPay=(sale.receipts||[]).length?[...(sale.receipts||[])].sort((a,b)=>b.date.localeCompare(a.date))[0].date:null;

        const cid=sale.customerId;
        if(!custMap[cid]) custMap[cid]={customerId:cid,name:sale.customerName,phone:"",creditLimit:0,invoices:[],totalDue:0,maxDays:0,lastPayDate:null,lastSaleDate:null};

        custMap[cid].invoices.push({...sale,bal,days,bucket:bucket.key,vehicleNo:v.vehicleNo,vehicleId:v.id,lastPay});
        custMap[cid].totalDue+=bal;
        if(days>custMap[cid].maxDays) custMap[cid].maxDays=days;
        if(!custMap[cid].lastSaleDate||sale.date>custMap[cid].lastSaleDate) custMap[cid].lastSaleDate=sale.date;
        if(lastPay&&(!custMap[cid].lastPayDate||lastPay>custMap[cid].lastPayDate)) custMap[cid].lastPayDate=lastPay;
      });
    });

    return Object.values(custMap).filter(c=>c.totalDue>0);
  },[vehicles,customers]);

  // Bucket totals
  const bucketTotals=useMemo(()=>{
    const totals={};
    BUCKETS.forEach(b=>{totals[b.key]={amount:0,count:0,invoices:0};});
    agingData.forEach(c=>c.invoices.forEach(inv=>{
      if(totals[inv.bucket]){totals[inv.bucket].amount+=inv.bal;totals[inv.bucket].invoices++;}
    }));
    BUCKETS.forEach(b=>{totals[b.key].count=agingData.filter(c=>c.invoices.some(i=>i.bucket===b.key)).length;});
    return totals;
  },[agingData]);

  const totalReceivables=agingData.reduce((s,c)=>s+c.totalDue,0);

  // Risk score
  const getRisk=(c)=>{
    const criticalAmt=c.invoices.filter(i=>i.bucket==="60+").reduce((s,i)=>s+i.bal,0);
    const highAmt=c.invoices.filter(i=>i.bucket==="31-60").reduce((s,i)=>s+i.bal,0);
    if(criticalAmt>0||c.maxDays>60) return{label:"Critical",color:C.red,bg:C.redSoft};
    if(highAmt>0||c.maxDays>30) return{label:"High",color:C.orange,bg:"#fff3e0"};
    if(c.maxDays>15) return{label:"Medium",color:C.amber,bg:C.amberSoft};
    return{label:"Low",color:C.green,bg:C.greenSoft};
  };

  // WhatsApp message
  const waMsg=(c)=>{
    const oldest=c.invoices.reduce((a,b)=>a.days>b.days?a:b);
    return encodeURIComponent(
`Assalam o Alaikum ${c.name} bhai,

Yeh ChickenFlow ki taraf se reminder hai:

💰 Total Pending: Rs.${Math.round(c.totalDue).toLocaleString()}
📋 Invoices: ${c.invoices.length}
📅 Oldest Invoice: ${oldest.days} days old (${oldest.date})

Meherbani karke jald settlement karein.
Shukriya 🙏`
    );
  };

  // Sort & filter
  const filtered=useMemo(()=>{
    let list=[...agingData];
    if(search) list=list.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())||c.phone.includes(search));
    if(filterBucket!=="all") list=list.filter(c=>c.invoices.some(i=>i.bucket===filterBucket));
    if(sortBy==="amount") list.sort((a,b)=>b.totalDue-a.totalDue);
    else if(sortBy==="days") list.sort((a,b)=>b.maxDays-a.maxDays);
    else list.sort((a,b)=>a.name.localeCompare(b.name));
    return list;
  },[agingData,search,filterBucket,sortBy]);

  return(
    <div>
      {/* Header */}
      <div style={{marginBottom:16}}>
        <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>⏳ Aging Report</h1>
        <p style={{color:C.muted,fontSize:13}}>{agingData.length} customers with outstanding balance · Total: <span className="mono" style={{color:C.amber,fontWeight:700}}>{fmtRs(totalReceivables)}</span></p>
      </div>

      {/* Bucket summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:18}}>
        {BUCKETS.map(b=>{
          const tot=bucketTotals[b.key];
          const pct=totalReceivables>0?Math.round(tot.amount/totalReceivables*100):0;
          const active=filterBucket===b.key;
          return(
            <div key={b.key} onClick={()=>setFilterBucket(active?"all":b.key)}
              style={{background:active?b.bg:C.card,border:`2px solid ${active?b.color:C.border}`,borderRadius:12,padding:"12px 14px",cursor:"pointer",transition:"all 0.15s"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                <span style={{fontSize:11,fontWeight:700,color:b.color,textTransform:"uppercase",letterSpacing:"0.05em"}}>{b.label}</span>
                {pct>0&&<span style={{fontSize:10,background:b.color+"22",color:b.color,borderRadius:10,padding:"1px 6px",fontWeight:700}}>{pct}%</span>}
              </div>
              <div className="mono" style={{fontSize:16,fontWeight:800,color:b.color,marginBottom:4}}>{fmtRs(tot.amount)}</div>
              <div style={{fontSize:11,color:C.muted}}>{tot.count} customers · {tot.invoices} invoices</div>
              {/* Mini bar */}
              <div style={{marginTop:8,background:C.card2,borderRadius:20,height:4,overflow:"hidden"}}>
                <div style={{width:pct+"%",height:"100%",background:b.color,borderRadius:20}}/>
              </div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search customer…"
          style={{flex:1,minWidth:160,padding:"8px 12px",borderRadius:10,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13,outline:"none"}}/>
        <div style={{display:"flex",gap:6}}>
          {[["amount","💰 Amount"],["days","📅 Days"],["name","🔤 Name"]].map(([k,l])=>(
            <button key={k} onClick={()=>setSortBy(k)}
              style={{padding:"7px 12px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",border:`1px solid ${sortBy===k?C.amber:C.border}`,background:sortBy===k?C.amberSoft:"transparent",color:sortBy===k?C.amber:C.muted}}>
              {l}
            </button>
          ))}
        </div>
        {filterBucket!=="all"&&(
          <button onClick={()=>setFilterBucket("all")}
            style={{padding:"7px 10px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",border:`1px solid ${C.red}`,background:C.redSoft,color:C.red}}>
            ✕ Clear filter
          </button>
        )}
      </div>

      {/* Customer cards */}
      {filtered.length===0
        ?<Empty icon="⏳" text={agingData.length===0?"No outstanding receivables — all paid up! ✅":"No customers match your filter."}/>
        :(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {filtered.map(c=>{
              const risk=getRisk(c);
              const oldest=c.invoices.reduce((a,b)=>a.days>b.days?a:b);
              const daysSincePay=c.lastPayDate?Math.round((new Date()-new Date(c.lastPayDate))/864e5):null;
              return(
                <div key={c.customerId} style={{background:C.card,border:`1px solid ${risk.color}44`,borderRadius:14,padding:16}}>
                  {/* Customer header row */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:15,fontWeight:800}}>👤 {c.name}</span>
                        <Tag color={risk.color}>{risk.label} Risk</Tag>
                        {c.creditLimit>0&&(()=>{
                          const pct=Math.min(100,Math.round(c.totalDue/c.creditLimit*100));
                          const col=pct>=100?C.red:pct>=80?C.orange:C.blue;
                          return <Tag color={col}>🔒 {pct}% limit</Tag>;
                        })()}
                      </div>
                      <div style={{fontSize:12,color:C.muted}}>
                        {c.invoices.length} invoice{c.invoices.length!==1?"s":" "} · Oldest: <span style={{color:risk.color,fontWeight:700}}>{oldest.days} days</span>
                        {c.lastPayDate?` · Last paid: ${daysSincePay}d ago`:" · No payments yet"}
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:16,fontWeight:800,color:risk.color}}>{fmtRs(c.totalDue)}</div>
                      <div style={{fontSize:11,color:C.muted}}>outstanding</div>
                    </div>
                  </div>

                  {/* Per-bucket breakdown */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:12}}>
                    {BUCKETS.map(b=>{
                      const amt=c.invoices.filter(i=>i.bucket===b.key).reduce((s,i)=>s+i.bal,0);
                      return(
                        <div key={b.key} style={{background:amt>0?b.bg:C.card2,borderRadius:8,padding:"6px 8px",textAlign:"center",border:amt>0?`1px solid ${b.color}33`:"none"}}>
                          <div style={{fontSize:9,color:amt>0?b.color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{b.label}</div>
                          <div className="mono" style={{fontSize:11,fontWeight:700,color:amt>0?b.color:C.muted}}>{amt>0?fmtRs(amt):"—"}</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Invoice list (collapsed preview) */}
                  <div style={{background:C.card2,borderRadius:8,overflow:"hidden",marginBottom:10}}>
                    {c.invoices.sort((a,b)=>b.days-a.days).slice(0,3).map(inv=>{
                      const b=BUCKETS.find(x=>x.key===inv.bucket)||BUCKETS[3];
                      return(
                        <div key={inv.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",borderBottom:`1px solid ${C.border}22`,fontSize:12}}>
                          <div>
                            <span style={{color:C.muted,marginRight:8}}>{inv.date}</span>
                            <span style={{color:C.muted,marginRight:8}}>🚛 {inv.vehicleNo}</span>
                            <span style={{color:C.muted}}>{inv.receiptNo}</span>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <Tag color={b.color}>{inv.days}d</Tag>
                            <span className="mono" style={{fontWeight:700,color:b.color}}>{fmtRs(inv.bal)}</span>
                          </div>
                        </div>
                      );
                    })}
                    {c.invoices.length>3&&<div style={{padding:"5px 10px",fontSize:11,color:C.muted,fontStyle:"italic"}}>+{c.invoices.length-3} more invoices…</div>}
                  </div>

                  {/* Action buttons */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {c.phone&&(
                      <a href={`https://wa.me/92${c.phone.replace(/^0/,"").replace(/\D/g,"")}?text=${waMsg(c)}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:20,background:"#25d36622",color:"#25d366",border:"1px solid #25d36644",fontSize:12,fontWeight:700,textDecoration:"none",cursor:"pointer"}}>
                        📲 WhatsApp Reminder
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      }

      {/* Grand total bar */}
      {agingData.length>0&&(
        <div style={{marginTop:16,background:C.card,border:`1px solid ${C.amber}44`,borderRadius:12,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:3}}>Total Outstanding Receivables</div>
            <div style={{fontSize:11,color:C.muted}}>{agingData.length} customers · {agingData.reduce((s,c)=>s+c.invoices.length,0)} invoices</div>
          </div>
          <div className="mono" style={{fontSize:22,fontWeight:800,color:C.amber}}>{fmtRs(totalReceivables)}</div>
        </div>
      )}
    </div>
  );
}

// ─── CASH FLOW & EOD RECONCILIATION ─────────────────────────────────────────
function CashFlowPage({accounts,transactions,vehicles}){
  const [selDate,setSelDate]=useState(today);
  const [cfMonth,setCfMonth]=useState(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;});
  const [viewMode,setViewMode]=useState("eod"); // "eod" | "monthly"

  // ── Classify each txn as IN or OUT per account ──
  const classifyTxn=(t)=>{
    const inTypes=["receipt","transfer_in","general_income"];
    const outTypes=["supplier_pay","vehicle_exp","general_exp","salary","advance","transfer_out"];
    if(inTypes.includes(t.type)) return "in";
    if(outTypes.includes(t.type)) return "out";
    return null;
  };

  // ── EOD: single day reconciliation ──
  const dayTxns=useMemo(()=>transactions.filter(t=>!t.voided&&t.date===selDate),[transactions,selDate]);
  const dayIn=dayTxns.filter(t=>classifyTxn(t)==="in").reduce((s,t)=>s+n(t.amount),0);
  const dayOut=dayTxns.filter(t=>classifyTxn(t)==="out").reduce((s,t)=>s+n(t.amount),0);
  const dayNet=dayIn-dayOut;

  // Vehicle expenses on this date (not in transactions table)
  const dayVehExp=useMemo(()=>{
    let total=0;
    vehicles.forEach(v=>v.expenses.filter(e=>e.date===selDate).forEach(e=>total+=n(e.amount)));
    return total;
  },[vehicles,selDate]);

  // Vehicle purchase payments on this date
  const daySupPaid=useMemo(()=>{
    let total=0;
    vehicles.forEach(v=>v.purchases.forEach(p=>(p.payments||[]).filter(r=>r.date===selDate).forEach(r=>total+=n(r.amount))));
    return total;
  },[vehicles,selDate]);

  // Customer receipts on this date (from sales)
  const dayCustReceipts=useMemo(()=>{
    let total=0;
    vehicles.forEach(v=>v.sales.forEach(s=>(s.receipts||[]).filter(r=>r.date===selDate).forEach(r=>total+=n(r.amount))));
    return total;
  },[vehicles,selDate]);

  const totalDayIn=dayIn+dayCustReceipts;
  const totalDayOut=dayOut+dayVehExp+daySupPaid;
  const totalDayNet=totalDayIn-totalDayOut;

  // Opening balance = balance just before selDate
  const openingBal=useMemo(()=>accounts.reduce((s,a)=>{
    const bal=transactions.filter(t=>!t.voided&&t.date<selDate).reduce((b,t)=>{
      if(t.debitAccountId===a.id) return b+n(t.amount);
      if(t.creditAccountId===a.id) return b-n(t.amount);
      return b;
    },0);
    return s+bal;
  },0),[accounts,transactions,selDate]);
  const closingBal=openingBal+totalDayNet;

  // ── MONTHLY: cash flow per day ──
  const [y,m]=cfMonth.split("-").map(Number);
  const daysInMonth=new Date(y,m,0).getDate();
  const monthDays=Array.from({length:daysInMonth},(_,i)=>{
    const d=String(i+1).padStart(2,"0");
    return `${cfMonth}-${d}`;
  });

  const monthlyData=useMemo(()=>monthDays.map(date=>{
    const txns=transactions.filter(t=>!t.voided&&t.date===date);
    const inAmt=txns.filter(t=>classifyTxn(t)==="in").reduce((s,t)=>s+n(t.amount),0);
    const outAmt=txns.filter(t=>classifyTxn(t)==="out").reduce((s,t)=>s+n(t.amount),0);
    let vExp=0; vehicles.forEach(v=>v.expenses.filter(e=>e.date===date).forEach(e=>vExp+=n(e.amount)));
    let supP=0; vehicles.forEach(v=>v.purchases.forEach(p=>(p.payments||[]).filter(r=>r.date===date).forEach(r=>supP+=n(r.amount))));
    let custR=0; vehicles.forEach(v=>v.sales.forEach(s=>(s.receipts||[]).filter(r=>r.date===date).forEach(r=>custR+=n(r.amount))));
    const totalIn=inAmt+custR;
    const totalOut=outAmt+vExp+supP;
    return{date,totalIn,totalOut,net:totalIn-totalOut,hasData:totalIn>0||totalOut>0};
  }),[transactions,vehicles,cfMonth]);

  const monthIn=monthlyData.reduce((s,d)=>s+d.totalIn,0);
  const monthOut=monthlyData.reduce((s,d)=>s+d.totalOut,0);
  const monthNet=monthIn-monthOut;
  const activeDays=monthlyData.filter(d=>d.hasData);

  // Bar chart
  const barMax=Math.max(...monthlyData.map(d=>Math.max(d.totalIn,d.totalOut)),1);
  const chartW=Math.max(320,daysInMonth*18);
  const chartH=80;

  // Per-account balance table for EOD
  const accBalances=accounts.map(a=>{
    const open=transactions.filter(t=>!t.voided&&t.date<selDate).reduce((b,t)=>{
      if(t.debitAccountId===a.id) return b+n(t.amount);
      if(t.creditAccountId===a.id) return b-n(t.amount);
      return b;
    },0);
    const dayMvmt=dayTxns.filter(t=>t.debitAccountId===a.id||t.creditAccountId===a.id).reduce((b,t)=>{
      if(t.debitAccountId===a.id) return b+n(t.amount);
      if(t.creditAccountId===a.id) return b-n(t.amount);
      return b;
    },0);
    return{...a,open,movement:dayMvmt,close:open+dayMvmt};
  });

  // Detail breakdown for EOD
  const inRows=[
    ...dayTxns.filter(t=>["receipt","general_income","transfer_in"].includes(t.type)).map(t=>({label:t.description,amount:n(t.amount),type:TXN_TYPES[t.type]?.label||t.type})),
    ...vehicles.flatMap(v=>v.sales.flatMap(s=>(s.receipts||[]).filter(r=>r.date===selDate).map(r=>({label:`${s.customerName} – ${s.receiptNo} (${v.vehicleNo})`,amount:n(r.amount),type:"Customer Receipt"})))),
  ];
  const outRows=[
    ...dayTxns.filter(t=>["general_exp","vehicle_exp","salary","advance","supplier_pay","transfer_out"].includes(t.type)).map(t=>({label:t.description,amount:n(t.amount),type:TXN_TYPES[t.type]?.label||t.type})),
    ...vehicles.flatMap(v=>v.expenses.filter(e=>e.date===selDate).map(e=>({label:`${e.description} [${v.vehicleNo}]`,amount:n(e.amount),type:"Vehicle Expense"}))),
    ...vehicles.flatMap(v=>v.purchases.flatMap(p=>(p.payments||[]).filter(r=>r.date===selDate).map(r=>({label:`Supplier Payment – ${p.supplierName} (${v.vehicleNo})`,amount:n(r.amount),type:"Supplier Payment"})))),
  ];

  return(
    <div>
      {/* Header + mode toggle */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>💵 Cash Flow</h1>
          <p style={{color:C.muted,fontSize:13}}>Reconciliation & daily cash movement</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          {["eod","monthly"].map(mode=>(
            <button key={mode} onClick={()=>setViewMode(mode)}
              style={{padding:"7px 16px",borderRadius:20,fontSize:12,fontWeight:700,cursor:"pointer",border:`1px solid ${viewMode===mode?C.amber:C.border}`,background:viewMode===mode?C.amberSoft:"transparent",color:viewMode===mode?C.amber:C.muted}}>
              {mode==="eod"?"📅 Daily EOD":"📆 Monthly"}
            </button>
          ))}
        </div>
      </div>

      {/* ══ EOD VIEW ══ */}
      {viewMode==="eod"&&(
        <div>
          {/* Date picker */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,flexWrap:"wrap"}}>
            <button onClick={()=>{const d=new Date(selDate);d.setDate(d.getDate()-1);setSelDate(d.toISOString().slice(0,10));}}
              style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",cursor:"pointer",color:C.text,fontSize:14}}>‹</button>
            <input type="date" value={selDate} onChange={e=>setSelDate(e.target.value)}
              style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.text,fontSize:13,fontWeight:700,outline:"none"}}/>
            <button onClick={()=>{const d=new Date(selDate);d.setDate(d.getDate()+1);setSelDate(d.toISOString().slice(0,10));}}
              style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",cursor:"pointer",color:C.text,fontSize:14}}>›</button>
            <button onClick={()=>setSelDate(today())}
              style={{background:C.amberSoft,color:C.amber,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Today</button>
          </div>

          {/* 4 summary cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
            {[
              ["💚 Money In",fmtRs(totalDayIn),C.green,`${inRows.length} transactions`],
              ["🔴 Money Out",fmtRs(totalDayOut),C.red,`${outRows.length} transactions`],
              ["📊 Net Position",fmtRs(Math.abs(totalDayNet)),totalDayNet>=0?C.teal:C.red,totalDayNet>=0?"Surplus":"Deficit"],
              ["🏦 Closing Balance",fmtRs(closingBal),closingBal>=0?C.blue:C.red,`Opening: ${fmtRs(openingBal)}`],
            ].map(([l,v,col,sub])=>(
              <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:5}}>{l}</div>
                <div className="mono" style={{fontSize:16,fontWeight:800,color:col}}>{v}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:3}}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Per-account balances */}
          {accounts.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
              <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>🏦 Account Balances</div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr><TH ch="Account"/><TH ch="Type"/><TH ch="Opening" right/><TH ch="Movement" right/><TH ch="Closing" right/></tr></thead>
                <tbody>
                  {accBalances.map(a=>(
                    <tr key={a.id}>
                      <TD bold>{a.name}</TD>
                      <TD><Tag color={a.type==="cash"?C.amber:C.blue}>{a.type==="cash"?"💵 Cash":"🏦 Bank"}</Tag></TD>
                      <TD right mono color={C.muted}>{fmtRs(a.open)}</TD>
                      <TD right mono color={a.movement>=0?C.green:C.red} bold>{a.movement>=0?"+":""}{fmtRs(a.movement)}</TD>
                      <TD right mono color={a.close>=0?C.text:C.red} bold>{fmtRs(a.close)}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Money In breakdown */}
          {inRows.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.green}33`,borderRadius:12,overflow:"hidden",marginBottom:12}}>
              <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,fontSize:12,fontWeight:700,color:C.green,textTransform:"uppercase",letterSpacing:"0.05em",display:"flex",justifyContent:"space-between"}}>
                <span>💚 Money In</span><span className="mono">{fmtRs(totalDayIn)}</span>
              </div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr><TH ch="Description"/><TH ch="Type"/><TH ch="Amount" right/></tr></thead>
                <tbody>
                  {inRows.map((r,i)=>(
                    <tr key={i}>
                      <TD>{r.label}</TD>
                      <TD><Tag color={C.green}>{r.type}</Tag></TD>
                      <TD right mono color={C.green} bold>{fmtRs(r.amount)}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Money Out breakdown */}
          {outRows.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.red}33`,borderRadius:12,overflow:"hidden",marginBottom:12}}>
              <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,fontSize:12,fontWeight:700,color:C.red,textTransform:"uppercase",letterSpacing:"0.05em",display:"flex",justifyContent:"space-between"}}>
                <span>🔴 Money Out</span><span className="mono">{fmtRs(totalDayOut)}</span>
              </div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr><TH ch="Description"/><TH ch="Type"/><TH ch="Amount" right/></tr></thead>
                <tbody>
                  {outRows.map((r,i)=>(
                    <tr key={i}>
                      <TD>{r.label}</TD>
                      <TD><Tag color={C.red}>{r.type}</Tag></TD>
                      <TD right mono color={C.red} bold>{fmtRs(r.amount)}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {inRows.length===0&&outRows.length===0&&<Empty icon="💵" text={`No transactions recorded on ${selDate}`}/>}

          {/* Net summary bar */}
          {(inRows.length>0||outRows.length>0)&&(
            <div style={{background:totalDayNet>=0?C.greenSoft:C.redSoft,border:`1px solid ${totalDayNet>=0?C.green:C.red}44`,borderRadius:12,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:14,fontWeight:800,color:totalDayNet>=0?C.green:C.red}}>{totalDayNet>=0?"✅ Day Surplus":"❌ Day Deficit"}</span>
              <span className="mono" style={{fontSize:20,fontWeight:800,color:totalDayNet>=0?C.green:C.red}}>{totalDayNet>=0?"+":"-"}{fmtRs(Math.abs(totalDayNet))}</span>
            </div>
          )}
        </div>
      )}

      {/* ══ MONTHLY VIEW ══ */}
      {viewMode==="monthly"&&(
        <div>
          {/* Month picker */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:18,flexWrap:"wrap"}}>
            <input type="month" value={cfMonth} onChange={e=>setCfMonth(e.target.value)}
              style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.text,fontSize:13,fontWeight:700,outline:"none"}}/>
            <button onClick={()=>{const d=new Date();setCfMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`)}}
              style={{background:C.amberSoft,color:C.amber,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>This Month</button>
          </div>

          {/* Monthly totals */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:18}}>
            {[["💚 Total In",fmtRs(monthIn),C.green,`${activeDays.length} active days`],["🔴 Total Out",fmtRs(monthOut),C.red,""],["📊 Net",fmtRs(Math.abs(monthNet)),monthNet>=0?C.teal:C.red,monthNet>=0?"Surplus":"Deficit"]].map(([l,v,col,sub])=>(
              <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
                <div className="mono" style={{fontSize:14,fontWeight:800,color:col}}>{v}</div>
                {sub&&<div style={{fontSize:10,color:C.muted,marginTop:3}}>{sub}</div>}
              </div>
            ))}
          </div>

          {/* Daily bar chart */}
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>📊 Daily Cash Flow — {cfMonth}</div>
            <div style={{overflowX:"auto"}}>
              <svg width={chartW} height={chartH+28} style={{display:"block"}}>
                {monthlyData.map((d,i)=>{
                  const x=i*(chartW/daysInMonth);
                  const bw=Math.max(4,chartW/daysInMonth-3);
                  const inH=Math.round((d.totalIn/barMax)*chartH);
                  const outH=Math.round((d.totalOut/barMax)*chartH);
                  const dayNum=parseInt(d.date.slice(-2));
                  return(
                    <g key={d.date}>
                      {inH>0&&<rect x={x} y={chartH-inH} width={bw*0.45} height={inH} fill={C.green} rx="2" opacity="0.85"/>}
                      {outH>0&&<rect x={x+bw*0.48} y={chartH-outH} width={bw*0.45} height={outH} fill={C.red} rx="2" opacity="0.75"/>}
                      {(dayNum===1||dayNum%5===0)&&<text x={x+bw/2} y={chartH+16} textAnchor="middle" fontSize="8" fill={C.muted}>{dayNum}</text>}
                    </g>
                  );
                })}
                <line x1="0" y1={chartH} x2={chartW} y2={chartH} stroke={C.border} strokeWidth="1"/>
              </svg>
            </div>
            <div style={{display:"flex",gap:16,marginTop:8}}>
              <span style={{fontSize:11,color:C.green,fontWeight:600}}>█ Money In</span>
              <span style={{fontSize:11,color:C.red,fontWeight:600}}>█ Money Out</span>
            </div>
          </div>

          {/* Daily breakdown table */}
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Date"/><TH ch="In" right/><TH ch="Out" right/><TH ch="Net" right/></tr></thead>
              <tbody>
                {monthlyData.filter(d=>d.hasData).map(d=>(
                  <tr key={d.date} style={{cursor:"pointer"}} onClick={()=>{setSelDate(d.date);setViewMode("eod");}}>
                    <TD color={C.muted}>{d.date}</TD>
                    <TD right mono color={C.green}>{fmtRs(d.totalIn)}</TD>
                    <TD right mono color={C.red}>{fmtRs(d.totalOut)}</TD>
                    <TD right mono bold color={d.net>=0?C.teal:C.red}>{d.net>=0?"+":"-"}{fmtRs(Math.abs(d.net))}</TD>
                  </tr>
                ))}
                {activeDays.length===0&&<tr><td colSpan={4} style={{padding:"24px",textAlign:"center",color:C.muted,fontSize:13}}>No transactions in {cfMonth}</td></tr>}
                <tr style={{background:C.card2}}>
                  <td style={{padding:"10px 12px",fontWeight:700,fontSize:12,color:C.muted}}>MONTH TOTAL</td>
                  <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:C.green}}>{fmtRs(monthIn)}</span></td>
                  <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:C.red}}>{fmtRs(monthOut)}</span></td>
                  <td style={{padding:"10px 12px",textAlign:"right"}}><span className="mono" style={{fontWeight:700,color:monthNet>=0?C.teal:C.red}}>{monthNet>=0?"+":"-"}{fmtRs(Math.abs(monthNet))}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:8,textAlign:"center"}}>💡 Tap any day row to view detailed EOD breakdown</div>
        </div>
      )}
    </div>
  );
}

// ─── ROLE / AUTH SYSTEM ──────────────────────────────────────────────────────
const ROLES={
  owner:  {label:"👑 Owner",   color:"#F59E0B", pin:"1234", canDelete:true,  canVoid:true,  seeAll:true},
  manager:{label:"📋 Manager", color:"#60A5FA", pin:"5678", canDelete:false, canVoid:false, seeAll:true},
  driver: {label:"🚗 Driver",  color:"#2DD4BF", pin:"0000", canDelete:false, canVoid:false, seeAll:false},
};

function RoleLoginScreen({onLogin,theme}){
  const [selRole,setSelRole]=React.useState("owner");
  const [pin,setPin]=React.useState("");
  const [err,setErr]=React.useState("");
  const [showPin,setShowPin]=React.useState(false);

  const tryLogin=()=>{
    const role=ROLES[selRole];
    if(pin===role.pin){ haptic("success"); onLogin(selRole); }
    else{ setErr("Wrong PIN — try again"); setPin(""); haptic("error"); setTimeout(()=>setErr(""),2000); }
  };

  const bg=theme==="light"?"#F0F2F8":"#080B12";
  const card=theme==="light"?"#FFFFFF":"#101420";
  const text=theme==="light"?"#1A2035":"#D9E4F5";
  const muted=theme==="light"?"#64748B":"#4E5E7A";
  const border=theme==="light"?"#C8D0E8":"#232D42";

  return(
    <div style={{minHeight:"100dvh",background:bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{fontSize:48,marginBottom:8}}>🐔</div>
      <div style={{fontSize:24,fontWeight:900,color:"#F59E0B",marginBottom:4}}>ChickenFlow</div>
      <div style={{fontSize:13,color:muted,marginBottom:32}}>Select your role to continue</div>

      {/* Role selector */}
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",maxWidth:320,marginBottom:24}}>
        {Object.entries(ROLES).map(([k,r])=>(
          <button key={k} onClick={()=>{setSelRole(k);setPin("");setErr("");haptic("light");}}
            style={{padding:"14px 20px",borderRadius:14,border:`2px solid ${selRole===k?r.color:border}`,
              background:selRole===k?r.color+"15":card,color:selRole===k?r.color:text,
              fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:12,transition:"all 0.15s"}}>
            <span style={{fontSize:22}}>{r.label.split(" ")[0]}</span>
            <span>{r.label.split(" ").slice(1).join(" ")}</span>
            {selRole===k&&<span style={{marginLeft:"auto",fontSize:11,opacity:0.7}}>Selected</span>}
          </button>
        ))}
      </div>

      {/* PIN entry */}
      <div style={{width:"100%",maxWidth:320}}>
        <div style={{fontSize:12,color:muted,fontWeight:700,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Enter PIN</div>
        <div style={{position:"relative",marginBottom:8}}>
          <input
            type={showPin?"text":"password"} value={pin}
            onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&tryLogin()}
            placeholder="••••" maxLength={8}
            style={{width:"100%",padding:"13px 44px 13px 16px",borderRadius:12,
              border:`1.5px solid ${err?C.red:border}`,background:card,color:text,
              fontSize:20,fontFamily:"monospace",textAlign:"center",outline:"none",letterSpacing:6}}/>
          <button onClick={()=>setShowPin(v=>!v)}
            style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:18,color:muted}}>
            {showPin?"🙈":"👁"}
          </button>
        </div>
        {err&&<div style={{color:"#EF4444",fontSize:13,textAlign:"center",marginBottom:8}}>{err}</div>}

        {/* Numpad */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k,i)=>(
            <button key={i} onClick={()=>{
              if(!k) return;
              haptic("light");
              if(k==="⌫") setPin(p=>p.slice(0,-1));
              else if(pin.length<8) setPin(p=>p+k);
            }}
              style={{padding:"16px",borderRadius:12,border:`1px solid ${border}`,background:k?card:"transparent",
                color:k==="⌫"?"#EF4444":text,fontSize:18,fontWeight:700,cursor:k?"pointer":"default",
                opacity:k?1:0}}>
              {k}
            </button>
          ))}
        </div>

        <button onClick={tryLogin}
          style={{width:"100%",padding:"15px",borderRadius:14,background:"#F59E0B",color:"#fff",
            fontSize:16,fontWeight:800,border:"none",cursor:"pointer",letterSpacing:"0.05em"}}>
          LOGIN →
        </button>
        <div style={{textAlign:"center",fontSize:11,color:muted,marginTop:12}}>
          Default PINs: Owner=1234 · Manager=5678 · Driver=0000
        </div>
      </div>
    </div>
  );
}

// ─── FAB (Floating Action Button) ────────────────────────────────────────────
function FAB({onClick,label="Add",icon="➕",color}){
  const col=color||C.amber;
  return(
    <button onClick={()=>{haptic("medium");onClick();}}
      style={{position:"fixed",bottom:"calc(74px + env(safe-area-inset-bottom))",right:20,
        width:56,height:56,borderRadius:28,background:col,border:"none",
        boxShadow:`0 4px 20px ${col}66`,cursor:"pointer",
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:24,zIndex:150,transition:"transform 0.15s,box-shadow 0.15s"}}
      onMouseDown={e=>e.currentTarget.style.transform="scale(0.92)"}
      onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
      onTouchStart={e=>e.currentTarget.style.transform="scale(0.92)"}
      onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}
      title={label}
      aria-label={label}>
      {icon}
    </button>
  );
}

// ─── BOTTOM SHEET MODAL ───────────────────────────────────────────────────────
function BottomSheet({title,children,onClose,width,onSave,saveLabel="Save",saving=false}){
  const [visible,setVisible]=React.useState(false);
  React.useEffect(()=>{ requestAnimationFrame(()=>setVisible(true)); },[]);
  const close=()=>{ setVisible(false); setTimeout(onClose,200); };
  const handleSave=()=>{ haptic("success"); onSave?.(); };

  return(
    <div style={{position:"fixed",inset:0,zIndex:300,display:"flex",flexDirection:"column",justifyContent:"flex-end"}}
      onClick={close}>
      {/* Backdrop */}
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.7)",
        opacity:visible?1:0,transition:"opacity 0.2s"}}/>
      {/* Sheet */}
      <div onClick={e=>e.stopPropagation()}
        style={{position:"relative",background:C.card,
          borderRadius:"20px 20px 0 0",
          maxHeight:"92dvh",display:"flex",flexDirection:"column",
          transform:visible?"translateY(0)":"translateY(100%)",
          transition:"transform 0.25s cubic-bezier(0.32,0.72,0,1)",
          paddingBottom:"env(safe-area-inset-bottom)"}}>
        {/* Drag handle */}
        <div style={{display:"flex",justifyContent:"center",padding:"12px 0 4px"}}>
          <div style={{width:40,height:4,borderRadius:2,background:C.border}}/>
        </div>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"8px 20px 12px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          <div style={{fontWeight:800,fontSize:16,color:C.text}}>{title}</div>
          <button onClick={close} style={{background:"transparent",border:`1px solid ${C.border}`,
            color:C.muted,borderRadius:8,padding:"4px 10px",fontSize:13,cursor:"pointer"}}>✕</button>
        </div>
        {/* Content */}
        <div style={{overflowY:"auto",padding:"16px 20px",flex:1}}>
          {children}
        </div>
        {/* Footer */}
        {onSave&&(
          <div style={{padding:"12px 20px",borderTop:`1px solid ${C.border}`,flexShrink:0,display:"flex",gap:10}}>
            <button onClick={close}
              style={{flex:1,padding:"13px",borderRadius:12,border:`1px solid ${C.border}`,
                background:"transparent",color:C.muted,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              style={{flex:2,padding:"13px",borderRadius:12,border:"none",
                background:C.amber,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",opacity:saving?0.7:1}}>
              {saving?"Saving…":saveLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PULL TO REFRESH WRAPPER ──────────────────────────────────────────────────
function PullToRefresh({onRefresh,children}){
  const [pullY,setPullY]=React.useState(0);
  const [refreshing,setRefreshing]=React.useState(false);
  const startY=React.useRef(null);
  const containerRef=React.useRef(null);
  const MAX=64;

  const ts=e=>{
    const el=containerRef.current;
    if(el&&el.scrollTop===0) startY.current=e.touches[0].clientY;
  };
  const tm=e=>{
    if(startY.current===null) return;
    const dy=e.touches[0].clientY-startY.current;
    if(dy>0) setPullY(Math.min(dy*0.5,MAX));
  };
  const te=async()=>{
    if(pullY>=MAX*0.75&&!refreshing){
      haptic("medium");
      setRefreshing(true);
      await onRefresh?.();
      setRefreshing(false);
    }
    setPullY(0); startY.current=null;
  };

  const pct=Math.min(pullY/MAX,1);

  return(
    <div ref={containerRef} onTouchStart={ts} onTouchMove={tm} onTouchEnd={te}
      style={{flex:1,overflowY:"auto",position:"relative"}}>
      {/* Pull indicator */}
      {(pullY>4||refreshing)&&(
        <div style={{display:"flex",justifyContent:"center",alignItems:"center",
          height:pullY||40,overflow:"hidden",transition:refreshing?"none":"height 0.2s"}}>
          <div style={{
            width:32,height:32,borderRadius:16,
            border:`3px solid ${C.amber}33`,
            borderTopColor:C.amber,
            animation:refreshing?"spin 0.8s linear infinite":"none",
            transform:refreshing?"none":`rotate(${pct*270}deg)`,
            transition:"transform 0.1s"}}>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

// ─── DRIVERS PAGE ────────────────────────────────────────────────────────────
function DriversPage({drivers,setDrivers,vehicles,setVehicles,transactions}){
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [viewId,setViewId]=useState(null);
  const [search,setSearch]=useState("");
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const close=()=>{setModal(null);setForm({});};

  const getTrips=(dId)=>vehicles.filter(v=>v.driverId===dId);
  const getEarnings=(dId)=>{
    const trips=getTrips(dId);
    return transactions.filter(t=>!t.voided&&t.type==="salary"&&trips.some(v=>v.id===t.linkedVehicleId)).reduce((s,t)=>s+n(t.amount),0);
  };

  const saveDriver=()=>{
    if(!form.name?.trim()) return alert("Enter driver name");
    if(viewId){
      setDrivers(p=>p.map(d=>d.id===viewId?{...d,...form}:d));
      setVehicles(p=>p.map(v=>v.driverId===viewId?{...v,driverName:form.name}:v));
      setViewId(null);
    } else {
      setDrivers(p=>[...p,{id:genId(),...form,status:form.status||"Active",createdAt:today()}]);
    }
    close();
  };
  const deleteDriver=(id)=>{
    if(!window.confirm("Delete this driver? They will be unassigned from all vehicles.")) return;
    setDrivers(p=>p.filter(d=>d.id!==id));
    setVehicles(p=>p.map(v=>v.driverId===id?{...v,driverId:null,driverName:""}:v));
    setViewId(null);
  };

  const filtered=(drivers||[]).filter(d=>!search||(d.name||"").toLowerCase().includes(search.toLowerCase())||(d.phone||"").includes(search));
  const viewDriver=(drivers||[]).find(d=>d.id===viewId);

  // ── DRIVER DETAIL VIEW ──
  if(viewDriver){
    const trips=getTrips(viewDriver.id).sort((a,b)=>b.date.localeCompare(a.date));
    const activeTrips=trips.filter(v=>v.status==="active");
    const earnings=getEarnings(viewDriver.id);
    const statusColor=viewDriver.status==="Active"||!viewDriver.status?C.green:viewDriver.status==="On Leave"?C.orange:C.muted;
    return(
      <div>
        <button onClick={()=>setViewId(null)}
          style={{background:"transparent",color:C.amber,fontSize:14,fontWeight:700,marginBottom:16,padding:"4px 0",border:"none",cursor:"pointer"}}>
          ‹ Back to Drivers
        </button>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>🚗 {viewDriver.name}</h1>
            <div style={{fontSize:13,color:C.muted}}>{viewDriver.phone||"No phone"}{viewDriver.city?" · "+viewDriver.city:""}</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn color="amber" onClick={()=>{setForm({...viewDriver});setModal("edit");}}>✏️ Edit</Btn>
            <Btn color="red" onClick={()=>deleteDriver(viewDriver.id)}>🗑 Delete</Btn>
          </div>
        </div>

        {/* Info card */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:20,marginBottom:14}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
            {[["📱 Phone",viewDriver.phone||"—"],["🪪 CNIC",viewDriver.cnic||"—"],["🚗 License",viewDriver.license||"—"],["🏙 Home City",viewDriver.city||"—"],["📅 Joined",viewDriver.createdAt||"—"],["📋 Status",<Tag color={statusColor}>{viewDriver.status||"Active"}</Tag>]].map(([l,v])=>(
              <div key={l}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:3}}>{l}</div>
                <div style={{fontSize:13,fontWeight:600,color:C.text}}>{v}</div>
              </div>
            ))}
            {viewDriver.notes&&<div style={{gridColumn:"1/-1"}}><div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:3}}>📝 Notes</div><div style={{fontSize:13,color:C.muted}}>{viewDriver.notes}</div></div>}
          </div>
        </div>

        {/* KPI cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:18}}>
          {[["🚛 Total Trips",trips.length,C.amber],["✅ Completed",trips.filter(v=>v.status==="closed").length,C.green],["💰 Salary Paid",fmtRs(earnings),C.teal]].map(([l,v,col])=>(
            <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
              <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
              <div className="mono" style={{fontSize:15,fontWeight:800,color:col}}>{v}</div>
            </div>
          ))}
        </div>
        {activeTrips.length>0&&(
          <div style={{background:C.greenSoft,border:`1px solid ${C.green}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.green,fontWeight:600}}>
            🟢 Currently on {activeTrips.length} active trip{activeTrips.length>1?"s":""}: {activeTrips.map(v=>v.vehicleNo).join(", ")}
          </div>
        )}

        {/* Trip history table */}
        <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Trip History ({trips.length})</div>
        {trips.length===0?<Empty icon="🚛" text="No trips assigned yet"/>:(
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr><TH ch="Vehicle"/><TH ch="Date"/><TH ch="Route"/><TH ch="Status"/><TH ch="P&L" right/></tr></thead>
              <tbody>
                {trips.map(v=>{
                  const cv=calcVehicle(v,transactions);
                  return(
                    <tr key={v.id}>
                      <TD bold>{v.vehicleNo}</TD>
                      <TD color={C.muted}>{v.date}</TD>
                      <TD color={C.muted} small>{v.origin||"—"}{v.destination?" → "+v.destination:""}</TD>
                      <TD><Tag color={v.status==="active"?C.green:C.muted}>{v.status}</Tag></TD>
                      <TD right mono bold color={cv.pnl>=0?C.green:C.red}>{cv.pnl>=0?"+":"-"}{fmtRs(Math.abs(cv.pnl))}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {modal==="edit"&&(
          <Modal title="✏️ Edit Driver" onSave={saveDriver} saveLabel="Save Changes" onClose={close} width={480}>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Full Name" half><input value={form.name||""} onChange={f("name")} placeholder="Driver name"/></Fld>
              <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="03XX-XXXXXXX"/></Fld>
            </div>
            <div style={{display:"flex",gap:12}}>
              <Fld label="CNIC" half><input value={form.cnic||""} onChange={f("cnic")} placeholder="XXXXX-XXXXXXX-X"/></Fld>
              <Fld label="License No." half><input value={form.license||""} onChange={f("license")} placeholder="License number"/></Fld>
            </div>
            <div style={{display:"flex",gap:12}}>
              <Fld label="Home City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Lahore"/></Fld>
              <Fld label="Status" half><select value={form.status||"Active"} onChange={f("status")}><option>Active</option><option>Inactive</option><option>On Leave</option></select></Fld>
            </div>
            <Fld label="Notes"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes"/></Fld>
          </Modal>
        )}
      </div>
    );
  }

  // ── DRIVERS LIST ──
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:800,marginBottom:4}}>🚗 Drivers</h1>
          <p style={{color:C.muted,fontSize:13}}>{(drivers||[]).length} driver{(drivers||[]).length!==1?"s":""} registered</p>
        </div>
        <Btn color="amber" onClick={()=>{setForm({status:"Active"});setModal("add");}}>+ Add Driver</Btn>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="🔍 Search by name or phone…"
        style={{width:"100%",maxWidth:320,padding:"8px 14px",borderRadius:10,border:`1px solid ${C.border}`,background:C.card2,color:C.text,fontSize:13,marginBottom:16,outline:"none"}}/>

      {/* Summary row */}
      {(drivers||[]).length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
          {[
            ["🚗 Total Drivers",(drivers||[]).length,C.amber],
            ["✅ Active",(drivers||[]).filter(d=>(d.status||"Active")==="Active").length,C.green],
            ["🚛 With Trips",(drivers||[]).filter(d=>getTrips(d.id).length>0).length,C.blue],
          ].map(([l,v,col])=>(
            <div key={l} style={{background:C.card,border:`1px solid ${col}33`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
              <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:5}}>{l}</div>
              <div className="mono" style={{fontSize:18,fontWeight:800,color:col}}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {filtered.length===0
        ?<Empty icon="🚗" text={(drivers||[]).length===0?"No drivers yet. Tap '+ Add Driver' to register your first driver.":"No drivers match your search."}/>
        :(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {filtered.map(d=>{
              const trips=getTrips(d.id);
              const activeT=trips.filter(v=>v.status==="active");
              const earnings=getEarnings(d.id);
              const sCol=(d.status||"Active")==="Active"?C.green:d.status==="On Leave"?C.orange:C.muted;
              return(
                <div key={d.id} onClick={()=>setViewId(d.id)}
                  style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=C.amber}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{fontSize:15,fontWeight:800,marginBottom:3}}>🚗 {d.name}</div>
                      <div style={{fontSize:12,color:C.muted}}>{d.phone||"No phone"}{d.city?" · "+d.city:""}</div>
                      {d.license&&<div style={{fontSize:11,color:C.muted,marginTop:2}}>License: {d.license}</div>}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
                      <Tag color={sCol}>{d.status||"Active"}</Tag>
                      {activeT.length>0&&<Tag color={C.green}>🚛 {activeT.length} active</Tag>}
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    {[["Total Trips",trips.length,C.amber],["Completed",trips.filter(v=>v.status==="closed").length,C.green],["Salary Paid",fmtRs(earnings),C.teal]].map(([l,v,col])=>(
                      <div key={l} style={{background:C.card2,borderRadius:8,padding:"7px 10px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</div>
                        <div className="mono" style={{fontSize:12,fontWeight:700,color:col}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      }

      {modal==="add"&&(
        <Modal title="+ Add New Driver" onSave={saveDriver} saveLabel="Add Driver" onClose={close} width={480}>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Full Name" half><input value={form.name||""} onChange={f("name")} placeholder="Driver full name"/></Fld>
            <Fld label="Phone" half><input value={form.phone||""} onChange={f("phone")} placeholder="03XX-XXXXXXX"/></Fld>
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="CNIC" half><input value={form.cnic||""} onChange={f("cnic")} placeholder="XXXXX-XXXXXXX-X"/></Fld>
            <Fld label="License No." half><input value={form.license||""} onChange={f("license")} placeholder="License number"/></Fld>
          </div>
          <div style={{display:"flex",gap:12}}>
            <Fld label="Home City" half><input value={form.city||""} onChange={f("city")} placeholder="e.g. Lahore"/></Fld>
            <Fld label="Status" half><select value={form.status||"Active"} onChange={f("status")}><option>Active</option><option>Inactive</option><option>On Leave</option></select></Fld>
          </div>
          <Fld label="Notes (optional)"><input value={form.notes||""} onChange={f("notes")} placeholder="Any notes about this driver"/></Fld>
        </Modal>
      )}
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────

// ─── FIREBASE PERSISTED STATE ────────────────────────────────────────────────
function useFirestoreState(uid, key, defaultValue) {
  // Load immediately from localStorage so app shows instantly
  const lsKey = `cf_${uid}_${key}`;
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem(lsKey);
      return saved ? JSON.parse(saved) : defaultValue;
    } catch { return defaultValue; }
  });
  const [loaded, setLoaded] = useState(true); // Always loaded (from localStorage)

  useEffect(() => {
    if (!uid) return;
    // Sync from Firebase in background after app shows
    const timer = setTimeout(async () => {
      try {
        const ok = await loadFirebase();
        if (!ok) return;
        const unsub = await fbOnSnapshot(uid, key, (snap) => {
          if (snap && snap.exists && snap.exists()) {
            const val = snap.data().value;
            if (val !== undefined) {
              setState(val);
              try { localStorage.setItem(lsKey, JSON.stringify(val)); } catch {}
            }
          }
        });
        return unsub;
      } catch(e) { console.error("Firebase sync error:", e); }
    }, 1000);
    return () => clearTimeout(timer);
  }, [uid, key]);

  const setPersisted = useCallback((value) => {
    setState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      // Save to localStorage immediately
      try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch {}
      // Save to Firebase in background
      if (uid) {
        loadFirebase().then(ok => {
          if (ok) fbSetDoc(uid, key, next).catch(e => console.error("Save err:", e));
        });
      }
      return next;
    });
  }, [uid, key, lsKey]);

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
      await loadFirebase();
      if (isRegister) {
        await fbRegister(email, password);
      } else {
        await fbSignIn(email, password);
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
    loadFirebase().then(ok => {
      if (!ok) { setInitError("Firebase failed to load. Check internet connection."); setUser(null); return; }
      try {
        import("firebase/auth").then(({ onAuthStateChanged }) => {
          const unsub = onAuthStateChanged(auth, u => setUser(u), err => {
            setInitError(err.message); setUser(null);
          });
          // store unsub for cleanup - just ignore for now
        });
      } catch(e) { setInitError(e.message); setUser(null); }
    });
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
  const [drivers,setDrivers,drivers_loaded] = useFirestoreState(uid, "cf_drivers", []);
  const [partners,setPartners,partners_loaded] = useFirestoreState(uid, "cf_partners", []);
  const [distributions,setDistributions,dist_loaded] = useFirestoreState(uid, "cf_distributions", []);

  const allLoaded = v_loaded && c_loaded && s_loaded && a_loaded && t_loaded && l_loaded && ec_loaded && partners_loaded && dist_loaded;

  const [page,    setPage]    = useState("projects");
  const [openId,  setOpenId]  = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [autoBackupMinutes, setAutoBackupMinutes] = useState(0);
  const [globalSearch, setGlobalSearch] = useState("");
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  // ── Theme (dark/light) ──
  const [theme,setTheme] = useState(()=>{
    try{ return localStorage.getItem("cf_theme")||"dark"; }catch(e){ return "dark"; }
  });
  const toggleTheme=()=>{
    setTheme(t=>{ const next=t==="dark"?"light":"dark"; try{localStorage.setItem("cf_theme",next);}catch(e){} haptic("light"); return next; });
  };
  // Apply theme palette globally (mutable C reference)
  React.useMemo(()=>{ Object.assign(C,THEMES[theme]); },[theme]);
  // Apply body background
  React.useEffect(()=>{ document.body.style.background=C.bg; document.body.style.color=C.text; },[theme]);

  // ── Role / Auth ──
  const [role,setRole] = useState(null); // null=not logged in
  const roleObj = role?ROLES[role]:null;
  const canDelete = roleObj?.canDelete ?? true;
  const canVoid   = roleObj?.canVoid   ?? true;

  const addTxn = txn => { haptic("success"); setTransactions(p => [...p, {id:genId(), ...txn}]); };

  // ── Global search ──
  const [searchFilter,setSearchFilter]=useState("all");
  const [recentSearches,setRecentSearches]=useState([]);
  const [searchCursor,setSearchCursor]=useState(-1);

  const closeSearch=()=>{setShowGlobalSearch(false);setGlobalSearch("");setSearchFilter("all");setSearchCursor(-1);};

  const globalResults = useMemo(()=>{
    const q = globalSearch.trim().toLowerCase();
    if(!q || q.length < 2) return [];
    const results = [];
    const go=(action)=>()=>{action();closeSearch();};

    // Vehicles
    vehicles.forEach(v=>{
      if((v.vehicleNo||"").toLowerCase().includes(q)||(v.driverName||"").toLowerCase().includes(q)||(v.truckType||"").toLowerCase().includes(q)){
        results.push({type:"vehicle",icon:"🚛",title:v.vehicleNo,sub:`${v.driverName||"No driver"} · ${v.date}`,badge:v.status,badgeColor:v.status==="open"?C.teal:C.muted,amount:null,action:go(()=>{setOpenId(v.id);setPage("projects");})});
      }
      v.sales.filter(s=>!s.deletedAt).forEach(s=>{
        if((s.receiptNo||"").toLowerCase().includes(q)||(s.customerName||"").toLowerCase().includes(q)){
          const paid=(s.receipts||[]).reduce((t,r)=>t+n(r.amount),0);
          const bal=s.totalAmount-paid;
          results.push({type:"sale",icon:"🧾",title:`${s.receiptNo} — ${s.customerName}`,sub:`${v.vehicleNo} · ${s.date}`,badge:bal>0?"Due":"Paid",badgeColor:bal>0?C.amber:C.green,amount:s.totalAmount,action:go(()=>{setOpenId(v.id);setPage("projects");})});
        }
        (s.receipts||[]).forEach(r=>{
          if((r.collector||"").toLowerCase().includes(q)||(String(Math.round(r.amount))).includes(q)){
            results.push({type:"receipt",icon:"💵",title:`Receipt — ${s.customerName}`,sub:`${v.vehicleNo} · ${r.date} · ${s.receiptNo}`,badge:"Receipt",badgeColor:C.green,amount:r.amount,action:go(()=>{setOpenId(v.id);setPage("projects");})});
          }
        });
      });
      v.purchases.forEach(p=>{
        if((p.supplierName||"").toLowerCase().includes(q)){
          results.push({type:"purchase",icon:"🐔",title:`Purchase — ${p.supplierName}`,sub:`${v.vehicleNo} · ${p.date} · ${p.weight}kg`,badge:"Purchase",badgeColor:C.purple,amount:p.totalAmount,action:go(()=>{setOpenId(v.id);setPage("projects");})});
        }
      });
      v.expenses.filter(e=>(e.description||"").toLowerCase().includes(q)).forEach(e=>{
        results.push({type:"expense",icon:"💸",title:`Expense — ${e.description}`,sub:`${v.vehicleNo} · ${e.date} · ${e.type||""}`,badge:"Expense",badgeColor:C.red,amount:e.amount,action:go(()=>{setOpenId(v.id);setPage("projects");})});
      });
    });

    // Customers
    customers.forEach(c=>{
      if(c.name.toLowerCase().includes(q)||(c.city||"").toLowerCase().includes(q)||(c.phone||"").toLowerCase().includes(q)){
        results.push({type:"customer",icon:"👤",title:c.name,sub:`${[c.city,c.phone].filter(Boolean).join(" · ")||"No details"}`,badge:"Customer",badgeColor:C.blue,amount:null,action:go(()=>setPage("customers"))});
      }
    });

    // Suppliers
    suppliers.forEach(s=>{
      if(s.name.toLowerCase().includes(q)||(s.city||"").toLowerCase().includes(q)||(s.phone||"").toLowerCase().includes(q)){
        results.push({type:"supplier",icon:"🏭",title:s.name,sub:`${[s.city,s.region].filter(Boolean).join(" · ")||"No details"}`,badge:"Supplier",badgeColor:C.purple,amount:null,action:go(()=>setPage("suppliers"))});
      }
    });

    // Transactions
    transactions.filter(t=>!t.voided).forEach(t=>{
      if((t.description||"").toLowerCase().includes(q)||(t.note||"").toLowerCase().includes(q)){
        const cfg=TXN_TYPES[t.type]||{label:t.type,color:C.muted};
        results.push({type:"txn",icon:"💰",title:t.description||t.type,sub:`${t.date} · ${cfg.label}`,badge:cfg.label,badgeColor:cfg.color,amount:t.amount,action:go(()=>setPage("accounts"))});
      }
    });

    // Labourers
    labourers.forEach(l=>{
      if((l.name||"").toLowerCase().includes(q)||(l.role||"").toLowerCase().includes(q)||(l.phone||"").toLowerCase().includes(q)){
        results.push({type:"labourer",icon:"👷",title:l.name,sub:`${l.role||"Labourer"}${l.phone?" · "+l.phone:""}`,badge:"Labourer",badgeColor:C.orange,amount:null,action:go(()=>setPage("labourers"))});
      }
    });

    // Drivers
    (drivers||[]).forEach(d=>{
      if((d.name||"").toLowerCase().includes(q)||(d.licenseNo||"").toLowerCase().includes(q)||(d.phone||"").toLowerCase().includes(q)){
        results.push({type:"driver",icon:"🚗",title:d.name,sub:`${d.phone||""}${d.licenseNo?" · "+d.licenseNo:""}`,badge:"Driver",badgeColor:C.teal,amount:null,action:go(()=>setPage("drivers"))});
      }
    });

    // Partners
    (partners||[]).forEach(p=>{
      if((p.name||"").toLowerCase().includes(q)||(p.phone||"").toLowerCase().includes(q)){
        results.push({type:"partner",icon:"💼",title:p.name,sub:`${p.share}% share${p.phone?" · "+p.phone:""}`,badge:"Partner",badgeColor:C.amber,amount:null,action:go(()=>setPage("partners"))});
      }
    });

    return results;
  },[globalSearch,vehicles,customers,suppliers,transactions,labourers,drivers,partners]);

  // Filtered by tab
  const filteredResults=useMemo(()=>{
    if(searchFilter==="all") return globalResults.slice(0,30);
    return globalResults.filter(r=>r.type===searchFilter||
      (searchFilter==="sale"&&(r.type==="sale"||r.type==="receipt"))||
      (searchFilter==="expense"&&(r.type==="expense"||r.type==="txn"))).slice(0,30);
  },[globalResults,searchFilter]);

  // Group by type for "all" view
  const groupedResults=useMemo(()=>{
    if(searchFilter!=="all") return null;
    const groups={};
    filteredResults.forEach(r=>{
      const g=r.type==="receipt"?"sale":r.type==="purchase"?"vehicle":r.type;
      if(!groups[g]) groups[g]=[];
      groups[g].push(r);
    });
    return groups;
  },[filteredResults,searchFilter]);

  // Count per type
  const typeCounts=useMemo(()=>{
    const c={};
    globalResults.forEach(r=>{c[r.type]=(c[r.type]||0)+1;});
    return c;
  },[globalResults]);

  // Highlight match
  const Hl=({text,q})=>{
    if(!q||q.length<2) return <span>{text}</span>;
    const idx=(text||"").toLowerCase().indexOf(q.toLowerCase());
    if(idx<0) return <span>{text}</span>;
    return <span>{text.slice(0,idx)}<mark style={{background:C.amberSoft,color:C.amber,borderRadius:3,padding:"0 2px",fontWeight:700}}>{text.slice(idx,idx+q.length)}</mark>{text.slice(idx+q.length)}</span>;
  };
  const openVehicle = vehicles.find(v => v.id === openId);
  const totalBal = accounts.reduce((s,a) => s + getBalance(a.id, transactions), 0);
  const totalPending = vehicles.reduce((s,v) => s + calcVehicle(v,transactions).totalSaleBalance, 0);

  // ── Smart Notifications ──
  const notifications = useMemo(()=>{
    const alerts=[];
    const todayMs=new Date(today()).getTime();

    // 1. Customers over credit limit
    customers.forEach(cu=>{
      if(!cu.creditLimit||cu.creditLimit<=0) return;
      const due=vehicles.reduce((s,v)=>s+v.sales.filter(sl=>sl.customerId===cu.id).reduce((ss,sl)=>{
        const col=(sl.receipts||[]).reduce((a,r)=>a+n(r.amount),0);
        return ss+Math.max(0,sl.totalAmount-col);
      },0),0)+(n(cu.openingBalance)||0);
      if(due>cu.creditLimit){
        alerts.push({id:"cl_"+cu.id,type:"error",icon:"🔴",title:"Credit Limit Exceeded",body:`${cu.name} owes ${fmtRs(due)} — limit is ${fmtRs(cu.creditLimit)}`,action:()=>{}});
      } else if(due>cu.creditLimit*0.8){
        alerts.push({id:"cl80_"+cu.id,type:"warning",icon:"🟠",title:"Credit Limit Warning",body:`${cu.name} is at ${Math.round(due/cu.creditLimit*100)}% of limit (${fmtRs(due)} of ${fmtRs(cu.creditLimit)})`,action:()=>{}});
      }
    });

    // 2. Active vehicles with remaining stock > 3 days old
    vehicles.filter(v=>v.status==="active").forEach(v=>{
      const c=calcVehicle(v,transactions);
      if(c.remaining>0){
        const vehicleDateMs=new Date(v.date).getTime();
        const daysOld=Math.floor((todayMs-vehicleDateMs)/(1000*60*60*24));
        if(daysOld>=3){
          alerts.push({id:"stock_"+v.id,type:"warning",icon:"📦",title:"Unsold Stock Remaining",body:`Vehicle ${v.vehicleNo} has ${fmtKg(c.remaining)} unsold for ${daysOld} days`,action:()=>{}});
        }
      }
    });

    // 3. Large unpaid customer balances > Rs.100,000
    const custDues={};
    vehicles.forEach(v=>v.sales.forEach(sl=>{
      const col=(sl.receipts||[]).reduce((a,r)=>a+n(r.amount),0);
      const bal=sl.totalAmount-col;
      if(bal>0.01){
        if(!custDues[sl.customerId]) custDues[sl.customerId]={name:sl.customerName,due:0};
        custDues[sl.customerId].due+=bal;
      }
    }));
    Object.values(custDues).sort((a,b)=>b.due-a.due).slice(0,5).forEach(cd=>{
      if(cd.due>=100000){
        alerts.push({id:"due_"+cd.name,type:"info",icon:"💰",title:"Large Receivable",body:`${cd.name} owes ${fmtRs(cd.due)}`,action:()=>{}});
      }
    });

    // 4. Supplier payments overdue > 7 days
    vehicles.forEach(v=>{
      v.purchases.forEach(p=>{
        const paid=(p.payments||[]).reduce((s,r)=>s+n(r.amount),0);
        const bal=n(p.weight)*n(p.rate)-paid;
        if(bal>0.01){
          const purchDateMs=new Date(p.date).getTime();
          const daysOld=Math.floor((todayMs-purchDateMs)/(1000*60*60*24));
          if(daysOld>=7){
            alerts.push({id:"sup_"+p.id,type:"warning",icon:"🏭",title:"Supplier Payment Overdue",body:`${p.supplierName} — ${fmtRs(bal)} due for ${daysOld} days (${v.vehicleNo})`,action:()=>{}});
          }
        }
      });
    });

    // 5. Low stock alert < 5% remaining
    vehicles.filter(v=>v.status==="active").forEach(v=>{
      const c=calcVehicle(v,transactions);
      if(c.received>0&&c.remaining>0&&c.remaining/c.received<0.05){
        alerts.push({id:"low_"+v.id,type:"info",icon:"⚠️",title:"Low Stock",body:`Vehicle ${v.vehicleNo} — only ${fmtKg(c.remaining)} left (${Math.round(c.remaining/c.received*100)}%)`,action:()=>{}});
      }
    });

    return alerts;
  },[vehicles,customers,transactions,today()]);

  const exportData = () => exportAllData({ vehicles, customers, suppliers, accounts, transactions, labourers, categories: expenseCategories });
  const importCallbacks = { setVehicles, setCustomers, setSuppliers, setAccounts, setTransactions, setLabourers, setExpenseCategories };

  const navItems=[
    {id:"projects",       label:"🚛 Projects"},
    {id:"customers",      label:"👤 Customers"},
    {id:"suppliers",      label:"🏭 Suppliers"},
    {id:"accounts",       label:"💰 Accounts"},
    {id:"salaries",       label:"👷 Salaries"},
    {id:"drivers",        label:"🚗 Drivers"},
    {id:"cashflow",       label:"💵 Cash Flow"},
    {id:"aging",          label:"⏳ Aging"},
    {id:"partners",       label:"💼 Partners"},
    {id:"batch_receipt",  label:"📥 Batch Receipt"},
    {id:"reports",        label:"📋 Reports"},
  ];

  // Show app after 10s even if some data didn't load (prevents black screen)
  const [forceShow, setForceShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setForceShow(true), 10000);
    return () => clearTimeout(t);
  }, []);

  // Show role login if not authenticated
  if(!role) return <RoleLoginScreen onLogin={r=>{setRole(r);haptic("success");}} theme={theme}/>;

  if (!allLoaded && !forceShow) return <LoadingScreen />;

  const pageTitles = {
    projects: "🚛 Projects", customers: "👤 Customers", suppliers: "🏭 Suppliers",
    accounts: "💰 Accounts", salaries: "👷 Salaries", batch_receipt: "📥 Batch Receipt",
    reports: "📋 Reports", drivers: "🚗 Drivers", cashflow: "💵 Cash Flow", aging: "⏳ Aging Report", partners: "💼 Partners & Profit", more: "⚙️ More"
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
        {!openVehicle&&<div style={{fontSize:12,color:totalBal>=0?C.green:C.red,fontWeight:700,marginRight:4}} className="mono">
          {fmtRs(totalBal)}
        </div>}
        {/* Global search button */}
        {/* Theme toggle */}
        {!openVehicle&&<button onClick={toggleTheme}
          style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:10,
            padding:"7px 10px",fontSize:16,cursor:"pointer",color:C.muted,lineHeight:1}}
          title={`Switch to ${theme==="dark"?"light":"dark"} mode`}>
          {theme==="dark"?"☀️":"🌙"}
        </button>}
        {/* Role badge + logout */}
        {!openVehicle&&<button onClick={()=>{if(window.confirm("Log out?")){ setRole(null); haptic("light"); }}}
          style={{background:roleObj?.color+"22",border:`1px solid ${roleObj?.color}44`,
            borderRadius:10,padding:"5px 10px",fontSize:11,fontWeight:700,
            cursor:"pointer",color:roleObj?.color,whiteSpace:"nowrap"}}>
          {roleObj?.label||""}
        </button>}
        {!openVehicle&&<button onClick={()=>setShowGlobalSearch(true)}
          style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:16,cursor:"pointer",color:C.muted,minHeight:36,display:"flex",alignItems:"center"}}>
          🔍
        </button>}
        {/* Notification bell */}
        {!openVehicle&&<button onClick={()=>setShowNotifications(p=>!p)}
          style={{background:notifications.length>0?C.amberSoft:C.card2,border:`1px solid ${notifications.length>0?C.amber+"44":C.border}`,borderRadius:8,padding:"5px 10px",fontSize:16,cursor:"pointer",minHeight:36,display:"flex",alignItems:"center",gap:4,position:"relative"}}>
          🔔
          {notifications.length>0&&<span style={{background:C.red,color:"#fff",fontSize:10,fontWeight:800,borderRadius:20,padding:"1px 5px",minWidth:16,textAlign:"center",lineHeight:"16px"}}>{notifications.length}</span>}
        </button>}
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
          <button onClick={()=>fbSignOut()}
            style={{background:C.redSoft,color:C.red,border:`1px solid ${C.red}33`,
              padding:"5px 10px",borderRadius:8,fontSize:11,fontWeight:600,minHeight:36}}>
            Sign Out
          </button>
        </div>
      </div>

      {/* ── NOTIFICATION PANEL ── */}
      {showNotifications&&(
        <div style={{position:"fixed",inset:0,zIndex:490}} onClick={()=>setShowNotifications(false)}>
          <div style={{position:"absolute",top:"calc(56px + env(safe-area-inset-top))",right:0,width:"min(380px,100vw)",
            background:C.card,borderLeft:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,
            boxShadow:"-8px 8px 32px rgba(0,0,0,0.4)",maxHeight:"70vh",display:"flex",flexDirection:"column",
            borderRadius:"0 0 0 16px"}}
            onClick={e=>e.stopPropagation()}>
            {/* Header */}
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
              <div style={{fontWeight:800,fontSize:15}}>🔔 Alerts {notifications.length>0&&<span style={{background:C.red,color:"#fff",fontSize:11,borderRadius:20,padding:"1px 7px",marginLeft:6}}>{notifications.length}</span>}</div>
              <button onClick={()=>setShowNotifications(false)} style={{background:"transparent",border:"none",color:C.muted,fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Alerts list */}
            <div style={{overflowY:"auto",flex:1}}>
              {notifications.length===0?(
                <div style={{textAlign:"center",padding:"40px 20px",color:C.muted}}>
                  <div style={{fontSize:36,marginBottom:10}}>✅</div>
                  <div style={{fontSize:14,fontWeight:600}}>All clear!</div>
                  <div style={{fontSize:12,marginTop:4}}>No alerts at this time</div>
                </div>
              ):notifications.map((note,i)=>{
                const bgMap={error:C.redSoft,warning:C.orangeSoft,info:C.blueSoft};
                const borderMap={error:C.red+"44",warning:C.orange+"44",info:C.blue+"44"};
                const colorMap={error:C.red,warning:C.orange,info:C.blue};
                return(
                  <div key={note.id} style={{padding:"12px 18px",borderBottom:`1px solid ${C.border}33`,
                    background:i%2===0?"transparent":C.card2+"66"}}>
                    <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <div style={{fontSize:20,flexShrink:0,marginTop:1}}>{note.icon}</div>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                          <span style={{fontSize:12,fontWeight:700,color:colorMap[note.type]}}>{note.title}</span>
                          <span style={{fontSize:10,background:bgMap[note.type],color:colorMap[note.type],
                            border:`1px solid ${borderMap[note.type]}`,borderRadius:20,padding:"1px 6px",fontWeight:700,textTransform:"uppercase"}}>{note.type}</span>
                        </div>
                        <div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>{note.body}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {notifications.length>0&&(
              <div style={{padding:"10px 18px",borderTop:`1px solid ${C.border}`,flexShrink:0,fontSize:11,color:C.muted,textAlign:"center"}}>
                {notifications.length} active alert{notifications.length!==1?"s":""} · Updates automatically
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── GLOBAL SEARCH OVERLAY ── */}
      {showGlobalSearch&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(8,11,18,0.97)",display:"flex",flexDirection:"column"}}
          onClick={closeSearch}>
          <div style={{padding:"16px 16px 0",paddingTop:"calc(16px + env(safe-area-inset-top))",display:"flex",flexDirection:"column",height:"100%"}} onClick={e=>e.stopPropagation()}>

            <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:12}}>
              <div style={{flex:1,position:"relative"}}>
                <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:16,color:C.muted,pointerEvents:"none"}}>🔍</span>
                <input autoFocus value={globalSearch}
                  onChange={e=>{setGlobalSearch(e.target.value);setSearchCursor(-1);}}
                  onKeyDown={e=>{
                    if(e.key==="Escape"){closeSearch();return;}
                    if(e.key==="ArrowDown"){e.preventDefault();setSearchCursor(c=>Math.min(c+1,filteredResults.length-1));}
                    if(e.key==="ArrowUp"){e.preventDefault();setSearchCursor(c=>Math.max(c-1,-1));}
                    if(e.key==="Enter"&&searchCursor>=0&&filteredResults[searchCursor]){
                      const q=globalSearch.trim();
                      if(q.length>=2) setRecentSearches(p=>[q,...p.filter(x=>x!==q)].slice(0,5));
                      filteredResults[searchCursor].action();
                    }
                  }}
                  placeholder="Search vehicles, sales, customers, labourers…"
                  style={{width:"100%",padding:"13px 16px 13px 42px",borderRadius:14,border:`1.5px solid ${C.amber}55`,
                    background:C.card,color:C.text,fontSize:15,outline:"none",fontWeight:500}}/>
              </div>
              <button onClick={closeSearch}
                style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,fontSize:13,fontWeight:700,cursor:"pointer",padding:"6px 12px",borderRadius:10}}>Esc</button>
            </div>

            {globalSearch.length>=2&&globalResults.length>0&&(()=>{
              const tabs=[
                {k:"all",label:"All ("+globalResults.length+")"},
                ...((typeCounts.vehicle||typeCounts.purchase)?[{k:"vehicle",label:"🚛 Vehicles ("+((typeCounts.vehicle||0)+(typeCounts.purchase||0))+")"}]:[]),
                ...((typeCounts.sale||typeCounts.receipt)?[{k:"sale",label:"🧾 Sales ("+((typeCounts.sale||0)+(typeCounts.receipt||0))+")"}]:[]),
                ...(typeCounts.customer?[{k:"customer",label:"👤 Customers ("+typeCounts.customer+")"}]:[]),
                ...(typeCounts.supplier?[{k:"supplier",label:"🏭 Suppliers ("+typeCounts.supplier+")"}]:[]),
                ...((typeCounts.txn||typeCounts.expense)?[{k:"expense",label:"💰 Txns ("+((typeCounts.txn||0)+(typeCounts.expense||0))+")"}]:[]),
                ...(typeCounts.labourer?[{k:"labourer",label:"👷 Labourers ("+typeCounts.labourer+")"}]:[]),
                ...(typeCounts.driver?[{k:"driver",label:"🚗 Drivers ("+typeCounts.driver+")"}]:[]),
                ...(typeCounts.partner?[{k:"partner",label:"💼 Partners ("+typeCounts.partner+")"}]:[]),
              ];
              return(
                <div style={{display:"flex",gap:6,overflowX:"auto",marginBottom:12,paddingBottom:2}}>
                  {tabs.map(t=>(
                    <button key={t.k} onClick={()=>{setSearchFilter(t.k);setSearchCursor(-1);}}
                      style={{whiteSpace:"nowrap",padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0,
                        border:`1px solid ${searchFilter===t.k?C.amber:C.border}`,
                        background:searchFilter===t.k?C.amberSoft:"transparent",
                        color:searchFilter===t.k?C.amber:C.muted}}>
                      {t.label}
                    </button>
                  ))}
                </div>
              );
            })()}

            <div style={{flex:1,overflowY:"auto"}}>
              {globalSearch.length<2&&(
                <div>
                  {recentSearches.length>0&&(
                    <div style={{marginBottom:20}}>
                      <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Recent Searches</div>
                      {recentSearches.map((s,i)=>(
                        <div key={i} onClick={()=>setGlobalSearch(s)}
                          style={{display:"flex",alignItems:"center",gap:12,padding:"10px 4px",borderBottom:`1px solid ${C.border}22`,cursor:"pointer"}}>
                          <span style={{color:C.muted,fontSize:16}}>🕐</span>
                          <span style={{fontSize:14,color:C.text}}>{s}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Quick Jump</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[["🚛","Vehicles","projects"],["👤","Customers","customers"],["🏭","Suppliers","suppliers"],["💰","Accounts","accounts"],["👷","Labourers","labourers"],["⏳","Aging","aging"],["💵","Cash Flow","cashflow"],["💼","Partners","partners"]].map(([icon,label,pg])=>(
                      <div key={pg} onClick={()=>{setPage(pg);closeSearch();}}
                        style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background:C.card,borderRadius:12,cursor:"pointer",border:`1px solid ${C.border}22`}}>
                        <span style={{fontSize:20}}>{icon}</span>
                        <span style={{fontSize:13,fontWeight:600,color:C.text}}>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {globalSearch.length>=2&&filteredResults.length===0&&(
                <div style={{textAlign:"center",color:C.muted,padding:"48px 20px"}}>
                  <div style={{fontSize:40,marginBottom:12}}>🔍</div>
                  <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:6}}>No results for "{globalSearch}"</div>
                  <div style={{fontSize:13}}>Try a different keyword or check spelling</div>
                </div>
              )}

              {globalSearch.length>=2&&filteredResults.map((r,i)=>(
                <div key={i} onClick={()=>{
                    const q=globalSearch.trim();
                    if(q.length>=2) setRecentSearches(p=>[q,...p.filter(x=>x!==q)].slice(0,5));
                    r.action();
                  }}
                  style={{display:"flex",alignItems:"center",gap:12,padding:"13px 8px",
                    borderBottom:`1px solid ${C.border}22`,cursor:"pointer",borderRadius:10,
                    background:searchCursor===i?C.card:"transparent",transition:"background 0.1s"}}>
                  <div style={{fontSize:22,width:32,textAlign:"center",flexShrink:0}}>{r.icon}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                      <Hl text={r.title} q={globalSearch.trim()}/>
                    </div>
                    <div style={{fontSize:12,color:C.muted,marginTop:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                      <Hl text={r.sub} q={globalSearch.trim()}/>
                    </div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",flexShrink:0,gap:3}}>
                    {r.amount!=null&&<span className="mono" style={{fontSize:12,fontWeight:700,color:C.text}}>{fmtRs(r.amount)}</span>}
                    <span style={{fontSize:10,color:r.badgeColor||C.muted,background:(r.badgeColor||C.muted)+"22",padding:"2px 7px",borderRadius:20,fontWeight:700,whiteSpace:"nowrap"}}>{r.badge}</span>
                  </div>
                </div>
              ))}

              {globalSearch.length>=2&&filteredResults.length>0&&(
                <div style={{textAlign:"center",padding:"16px",fontSize:11,color:C.muted}}>
                  ↑↓ navigate · Enter to open · Esc to close
                </div>
              )}
            </div>
          </div>
        </div>
      )}

            
      {/* ── FAB (Floating Action Button) ── */}
      {!showGlobalSearch&&!openVehicle&&(()=>{
        const fabMap={
          projects:   {icon:"🚛",label:"Add Vehicle",   action:()=>setModal("addVehicle")},
          customers:  {icon:"👤",label:"Add Customer",  action:()=>document.getElementById("add-customer-btn")?.click()},
          suppliers:  {icon:"🏭",label:"Add Supplier",  action:()=>document.getElementById("add-supplier-btn")?.click()},
          accounts:   {icon:"💰",label:"New Transaction",action:()=>document.getElementById("add-txn-btn")?.click()},
          labourers:  {icon:"👷",label:"Add Labourer",  action:()=>document.getElementById("add-labourer-btn")?.click()},
          partners:   {icon:"💼",label:"Add Partner",   action:()=>document.getElementById("add-partner-btn")?.click()},
          drivers:    {icon:"🚗",label:"Add Driver",    action:()=>document.getElementById("add-driver-btn")?.click()},
          aging:      {icon:"📲",label:"WhatsApp All",  action:()=>{}},
          cashflow:   {icon:"💸",label:"Record Payment",action:()=>{}},
        };
        const fab=fabMap[page];
        if(!fab) return null;
        return <FAB icon={fab.icon} label={fab.label} onClick={fab.action}/>;
      })()}

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
                <button onClick={()=>fbSignOut()}
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
        {page==="projects"&&!openVehicle&&<Dashboard vehicles={vehicles} transactions={transactions} accounts={accounts} customers={customers} onOpen={id=>setOpenId(id)} onNew={()=>setShowNew(true)}/>}
        {page==="projects"&&openVehicle&&(
          <VehicleDetail vehicle={openVehicle} setVehicles={setVehicles}
            suppliers={suppliers} customers={customers} accounts={accounts}
            labourers={labourers} addTxn={addTxn} expenseCategories={expenseCategories}
            transactions={transactions} onBack={()=>setOpenId(null)}/>
        )}
        {page==="customers"&&<CustomersPage customers={customers} setCustomers={setCustomers}/>}
        {page==="suppliers"&&<SuppliersPage suppliers={suppliers} setSuppliers={setSuppliers} vehicles={vehicles}/>}
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
        {page==="drivers"&&<DriversPage drivers={drivers} setDrivers={setDrivers} vehicles={vehicles} setVehicles={setVehicles} transactions={transactions}/>}
        {page==="cashflow"&&<CashFlowPage accounts={accounts} transactions={transactions} vehicles={vehicles}/>}
        {page==="aging"&&<AgingPage vehicles={vehicles} customers={customers} setPage={setPage} setOpenId={setOpenId}/>}
        {page==="partners"&&<PartnersPage partners={partners} setPartners={setPartners} distributions={distributions} setDistributions={setDistributions} vehicles={vehicles} transactions={transactions}/>}
        {page==="more"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {[
              {id:"suppliers",icon:"🏭",label:"Suppliers",desc:"Manage your suppliers"},
              {id:"drivers",icon:"🚗",label:"Drivers",desc:"Manage drivers & trip history"},
              {id:"cashflow",icon:"💵",label:"Cash Flow",desc:"Daily EOD & monthly cash report"},
              {id:"aging",icon:"⏳",label:"Aging Report",desc:"Overdue receivables & customer risk"},
              {id:"partners",icon:"💼",label:"Partners",desc:"Profit distribution & partner shares"},
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
