import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDSPGu4UKggMnazc-ojzndqO9Hz3-b9LN8",
  authDomain: "joan-todos.firebaseapp.com",
  projectId: "joan-todos",
  storageBucket: "joan-todos.firebasestorage.app",
  messagingSenderId: "257919326231",
  appId: "1:257919326231:web:ac2df8e30e4991b03e6452"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const SHEET_ID  = "1gSxJqCPLmoI4laOjC2ug0bqcLnOZFSTqUL7T67ykt1Y";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY = "https://sheets.googleapis.com/$discovery/rest?version=v4";
const GOOGLE_CLIENT_ID = "531798086854-cebigms1uaqegtjsqq1ft7djrn6c3n4m.apps.googleusercontent.com";

const STATUSES = [
  { id: "all",               label: "All",               color: "#6b7280" },
  { id: "waiting_on_me",    label: "Waiting on Me",      color: "#dc2626" },
  { id: "waiting_on_others", label: "Waiting on Others", color: "#d97706" },
  { id: "on_hold",          label: "On Hold",            color: "#7c3aed" },
  { id: "done",             label: "Done",               color: "#16a34a" },
];
const PRIORITIES = [
  { id: "high",   label: "High",   color: "#dc2626" },
  { id: "medium", label: "Medium", color: "#d97706" },
  { id: "low",    label: "Low",    color: "#16a34a" },
];
const STATUS_META = {
  waiting_on_me:      { label: "Waiting on Me",     bg: "#fef2f2", text: "#dc2626", border: "#fecaca" },
  waiting_on_others:  { label: "Waiting on Others", bg: "#fffbeb", text: "#d97706", border: "#fde68a" },
  on_hold:            { label: "On Hold",           bg: "#f5f3ff", text: "#7c3aed", border: "#ddd6fe" },
  done:               { label: "Done",              bg: "#f0fdf4", text: "#16a34a", border: "#bbf7d0" },
};
const WORK_SECTIONS = [
  { id: "deals",    label: "Deals",                  icon: "🤝", syncable: true },
  { id: "projects", label: "Projects & Initiatives", icon: "🚀" },
  { id: "admin",    label: "Admin",                  icon: "📋" },
];
const PERSONAL_SECTIONS = [
  { id: "kids",    label: "Kids",    icon: "👧" },
  { id: "house",   label: "House",   icon: "🏡" },
  { id: "travel",  label: "Travel",  icon: "✈️" },
  { id: "general", label: "General", icon: "📝" },
];
const ALL_SECTIONS = [...WORK_SECTIONS, ...PERSONAL_SECTIONS];
const FONTS       = ["Default","Georgia","Courier New","Arial","Trebuchet MS","Impact"];
const FONT_SIZES  = ["12px","13px","14px","16px","18px","20px"];
const TEXT_COLORS = ["#111827","#dc2626","#d97706","#16a34a","#2563eb","#7c3aed","#db2777","#6b7280"];

function genId() { return Math.random().toString(36).slice(2, 10); }

function parseSheetTasks(cell) {
  if (!cell?.trim()) return [];
  return cell.split("||").map(raw => {
    const parts = raw.trim().split("::");
    const text  = parts[0]?.trim() || raw.trim();
    const smap  = { open:"waiting_on_me", done:"done", hold:"on_hold", waiting:"waiting_on_others" };
    const status   = smap[(parts[1]||"open").trim().toLowerCase()] || "waiting_on_me";
    const priority = (parts[2]||"medium").trim().toLowerCase();
    return { id:genId(), text, status, priority, subtasks:[], notes:"", dueDate:"", synced:true };
  });
}
function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
}

function serializeSheetTasks(tasks) {
  const smap = { waiting_on_me:"open", waiting_on_others:"waiting", on_hold:"hold", done:"done" };
  return tasks.map(t=>`${stripHtml(t.text)}::${smap[t.status]||"open"}::${t.priority}`).join("||");
}

async function parseVoiceWithClaude(transcript, currentTab, currentDate) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:300,
      system:`You are a task parser for a personal to-do app. Given a voice transcript extract structured task data and return ONLY valid JSON with no explanation or markdown.
Today is ${currentDate}. Current tab: ${currentTab}.
Sections — WORK: deals (sales deals), projects (projects & initiatives), admin (admin tasks). PERSONAL: kids (kids-related), house (home tasks), travel (travel plans), general (everything else).
Return exactly: {"text":"clean task title","section":"deals|projects|admin|kids|house|travel|general","tab":"work|personal","status":"waiting_on_me|waiting_on_others|on_hold|done","priority":"high|medium|low","dueDate":"YYYY-MM-DD or empty","notes":"extra context or empty"}
Rules: status defaults to waiting_on_me. urgent/asap→high, whenever/someday→low, else medium. Resolve relative dates from today. Pick section by context, preferring current tab. Strip filler words.`,
      messages:[{role:"user",content:transcript}],
    }),
  });
  const data  = await resp.json();
  const raw   = data.content?.[0]?.text||"";
  const clean = raw.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}

function useVoice() {
  const [listening,  setListening]  = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error,      setError]      = useState(null);
  const recogRef = useRef(null);
  const supported = typeof window!=="undefined" && ("SpeechRecognition" in window||"webkitSpeechRecognition" in window);
  const start = useCallback(()=>{
    if(!supported){setError("Speech recognition requires Chrome or Edge.");return;}
    setError(null); setTranscript("");
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const recog=new SR();
    recog.continuous=false; recog.interimResults=true; recog.lang="en-US";
    recog.onresult=e=>setTranscript(Array.from(e.results).map(r=>r[0].transcript).join(""));
    recog.onerror=e=>{setError("Mic error: "+e.error);setListening(false);};
    recog.onend=()=>setListening(false);
    recogRef.current=recog; recog.start(); setListening(true);
  },[supported]);
  const stop=useCallback(()=>{recogRef.current?.stop();setListening(false);},[]);
  return {listening,transcript,error,supported,start,stop,setTranscript};
}

function StatusBadge({status,small,onClick}) {
  const m=STATUS_META[status]||STATUS_META.waiting_on_me;
  return <span onClick={onClick} style={{fontSize:small?10:11,fontWeight:700,letterSpacing:"0.04em",padding:small?"2px 7px":"3px 10px",borderRadius:99,background:m.bg,color:m.text,border:`1px solid ${m.border}`,whiteSpace:"nowrap",userSelect:"none",cursor:onClick?"pointer":"default",WebkitTapHighlightColor:"transparent"}}>{m.label}</span>;
}
function PriorityDot({priority,onClick}) {
  const p=PRIORITIES.find(x=>x.id===priority)||PRIORITIES[1];
  return <span onClick={onClick} style={{display:"inline-block",width:9,height:9,borderRadius:"50%",background:p.color,flexShrink:0,cursor:onClick?"pointer":"default"}} title={p.label}/>;
}
function Pill({label,active,color,onClick}) {
  return <button onClick={onClick} style={{fontSize:12,padding:"6px 13px",borderRadius:99,border:`1.5px solid ${active?color:"#e5e7eb"}`,background:active?color:"white",color:active?"white":"#374151",cursor:"pointer",fontWeight:600,fontFamily:"inherit",transition:"all 0.15s",whiteSpace:"nowrap",WebkitTapHighlightColor:"transparent"}}>{label}</button>;
}
function cycleStatus(s){const o=["waiting_on_me","waiting_on_others","on_hold","done"];return o[(o.indexOf(s)+1)%o.length];}
function cyclePriority(p){const o=["high","medium","low"];return o[(o.indexOf(p)+1)%o.length];}

function RichToolbar({editorRef,accent}) {
  const [showLink,setShowLink]=useState(false);
  const [linkUrl,setLinkUrl]=useState("");
  const [savedRange,setSavedRange]=useState(null);
  function exec(cmd,val){editorRef.current?.focus();document.execCommand(cmd,false,val||null);}
  function isActive(cmd){try{return document.queryCommandState(cmd);}catch{return false;}}
  function saveRange(){const sel=window.getSelection();if(sel?.rangeCount>0)setSavedRange(sel.getRangeAt(0).cloneRange());}
  function restoreRange(){if(!savedRange)return;const sel=window.getSelection();sel.removeAllRanges();sel.addRange(savedRange);}
  function insertLink(){if(!linkUrl.trim())return;restoreRange();exec("createLink",linkUrl.startsWith("http")?linkUrl:"https://"+linkUrl);setShowLink(false);setLinkUrl("");}
  const btn=(active)=>({padding:"4px 8px",borderRadius:5,border:`1px solid ${active?accent:"#e5e7eb"}`,background:active?accent:"white",color:active?"white":"#374151",cursor:"pointer",fontSize:12,fontFamily:"inherit",lineHeight:1.4,fontWeight:active?700:400,minHeight:28,WebkitTapHighlightColor:"transparent"});
  const sep={width:1,height:18,background:"#e5e7eb",margin:"0 2px",flexShrink:0};
  return (
    <div style={{position:"relative"}}>
      <div style={{display:"flex",flexWrap:"wrap",gap:3,alignItems:"center",padding:"6px 8px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>
        <select onChange={e=>exec("fontName",e.target.value)} defaultValue="" style={{fontSize:11,padding:"3px 5px",borderRadius:5,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white",height:28}}>
          <option value="" disabled>Font</option>
          {FONTS.map(f=><option key={f} value={f==="Default"?"inherit":f}>{f}</option>)}
        </select>
        <select onChange={e=>{exec("fontSize","7");const el=editorRef.current?.querySelector('font[size="7"]');if(el){el.removeAttribute("size");el.style.fontSize=e.target.value;}}} defaultValue="" style={{fontSize:11,padding:"3px 5px",borderRadius:5,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white",height:28,width:60}}>
          <option value="" disabled>Size</option>
          {FONT_SIZES.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <div style={sep}/>
        <button onMouseDown={e=>{e.preventDefault();exec("bold");}} style={{...btn(isActive("bold")),fontWeight:700}}>B</button>
        <button onMouseDown={e=>{e.preventDefault();exec("italic");}} style={{...btn(isActive("italic")),fontStyle:"italic"}}>I</button>
        <button onMouseDown={e=>{e.preventDefault();exec("underline");}} style={{...btn(isActive("underline")),textDecoration:"underline"}}>U</button>
        <button onMouseDown={e=>{e.preventDefault();exec("strikeThrough");}} style={{...btn(isActive("strikeThrough")),textDecoration:"line-through"}}>S</button>
        <div style={sep}/>
        <div style={{display:"flex",gap:2}}>
          {TEXT_COLORS.map(c=><button key={c} onMouseDown={e=>{e.preventDefault();exec("foreColor",c);}} style={{width:18,height:18,borderRadius:3,background:c,border:"1.5px solid rgba(0,0,0,0.12)",cursor:"pointer",padding:0,flexShrink:0}}/>)}
        </div>
        <div style={sep}/>
        <button onMouseDown={e=>{e.preventDefault();exec("insertUnorderedList");}} style={btn(isActive("insertUnorderedList"))}>≡</button>
        <button onMouseDown={e=>{e.preventDefault();exec("insertOrderedList");}} style={btn(isActive("insertOrderedList"))}>1.</button>
        <div style={sep}/>
        <button onMouseDown={e=>{e.preventDefault();saveRange();setShowLink(s=>!s);}} style={{...btn(showLink),fontSize:14}}>🔗</button>
        <button onMouseDown={e=>{e.preventDefault();exec("removeFormat");}} style={{...btn(false),color:"#9ca3af",fontSize:11}}>✕fmt</button>
      </div>
      {showLink&&(
        <div style={{position:"absolute",top:"100%",left:0,zIndex:50,background:"white",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 4px 16px rgba(0,0,0,0.1)",display:"flex",gap:6,alignItems:"center",minWidth:260,width:"100%"}}>
          <input autoFocus value={linkUrl} onChange={e=>setLinkUrl(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")insertLink();if(e.key==="Escape")setShowLink(false);}} placeholder="https://…" style={{flex:1,fontSize:12,padding:"5px 8px",borderRadius:6,border:"1px solid #e5e7eb",outline:"none",fontFamily:"inherit",color:"#111"}}/>
          <button onClick={insertLink} style={{fontSize:11,padding:"5px 10px",borderRadius:6,border:"none",background:accent,color:"white",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Insert</button>
          <button onClick={()=>setShowLink(false)} style={{fontSize:11,padding:"5px 8px",borderRadius:6,border:"1px solid #e5e7eb",background:"white",cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
      )}
    </div>
  );
}

function RichEditor({editorRef,accent,placeholder}) {
  const [empty,setEmpty]=useState(true);
  function handleInput(){const el=editorRef.current;if(el)setEmpty(el.innerHTML===""||el.innerHTML==="<br>");}
  return (
    <div style={{position:"relative"}}>
      {empty&&<div style={{position:"absolute",top:9,left:12,pointerEvents:"none",fontSize:13,color:"#9ca3af",userSelect:"none"}}>{placeholder}</div>}
      <div ref={editorRef} contentEditable suppressContentEditableWarning onInput={handleInput} onFocus={handleInput}
        style={{minHeight:52,maxHeight:200,overflowY:"auto",padding:"8px 12px",fontSize:13,lineHeight:1.6,outline:"none",color:"#111",fontFamily:"inherit"}}/>
    </div>
  );
}

function AddForm({onAdd,accent,isSubtask}) {
  const [open,setOpen]=useState(false);
  const [status,setStatus]=useState("waiting_on_me");
  const [priority,setPriority]=useState("medium");
  const [dueDate,setDueDate]=useState("");
  const editorRef=useRef(null);
  function getText(){return editorRef.current?.innerText?.trim()||"";}
  function submit(){
    const html=editorRef.current?.innerHTML?.trim()||"";
    if(!getText())return;
    onAdd({text:html,status,priority,dueDate,subtasks:[],notes:"",isRich:true});
    if(editorRef.current)editorRef.current.innerHTML="";
    setStatus("waiting_on_me");setPriority("medium");setDueDate("");setOpen(false);
  }
  if(!open)return(
    <button onClick={()=>setOpen(true)} style={{width:"100%",padding:isSubtask?"6px 10px":"9px 12px",borderRadius:8,border:`1.5px dashed ${accent}55`,background:`${accent}08`,color:accent,fontSize:isSubtask?12:13,fontWeight:600,cursor:"pointer",textAlign:"left",fontFamily:"inherit",WebkitTapHighlightColor:"transparent"}}>
      + {isSubtask?"Add subtask":"Add task"}
    </button>
  );
  return (
    <div style={{background:"white",borderRadius:10,border:`1.5px solid ${accent}44`,overflow:"hidden",boxShadow:`0 4px 20px ${accent}14`}}>
      <RichToolbar editorRef={editorRef} accent={accent}/>
      <div onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();submit();}if(e.key==="Escape")setOpen(false);}}>
        <RichEditor editorRef={editorRef} accent={accent} placeholder={isSubtask?"New subtask…":"New task… (⌘+Enter to save)"}/>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",padding:"8px 10px",borderTop:"1px solid #f3f4f6",background:"#fafafa"}}>
        <select value={status} onChange={e=>setStatus(e.target.value)} style={{fontSize:11,padding:"5px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white"}}>
          {STATUSES.filter(s=>s.id!=="all").map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select value={priority} onChange={e=>setPriority(e.target.value)} style={{fontSize:11,padding:"5px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white"}}>
          {PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} style={{fontSize:11,padding:"5px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151"}}/>
        <div style={{display:"flex",gap:5,marginLeft:"auto"}}>
          <button onClick={()=>setOpen(false)} style={{fontSize:11,padding:"5px 11px",borderRadius:6,border:"1px solid #e5e7eb",background:"white",cursor:"pointer",fontFamily:"inherit",color:"#374151",minHeight:32}}>Cancel</button>
          <button onClick={submit} style={{fontSize:11,padding:"5px 11px",borderRadius:6,border:"none",background:accent,color:"white",cursor:"pointer",fontFamily:"inherit",fontWeight:700,minHeight:32}}>Add</button>
        </div>
      </div>
    </div>
  );
}

function SubtaskRow({sub,onUpdate,onDelete}) {
  const [editing,setEditing]=useState(false);
  const [text,setText]=useState(sub.text);
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,background:"rgba(0,0,0,0.025)",border:"1px solid rgba(0,0,0,0.05)",marginBottom:5}}>
      <span style={{fontSize:11,color:"#c4c9d4",flexShrink:0}}>↳</span>
      <PriorityDot priority={sub.priority} onClick={()=>onUpdate({...sub,priority:cyclePriority(sub.priority)})}/>
      {editing?(
        <input autoFocus value={text} onChange={e=>setText(e.target.value)}
          onBlur={()=>{onUpdate({...sub,text:text.trim()||sub.text});setEditing(false);}}
          onKeyDown={e=>{if(e.key==="Enter"||e.key==="Escape"){onUpdate({...sub,text:text.trim()||sub.text});setEditing(false);}}}
          style={{flex:1,fontSize:13,border:"none",outline:"none",background:"transparent",fontFamily:"inherit",color:"#111"}}/>
      ):(
        <span onDoubleClick={()=>setEditing(true)} dangerouslySetInnerHTML={{__html:sub.text}}
          style={{flex:1,fontSize:13,cursor:"text",color:sub.status==="done"?"#9ca3af":"#374151",textDecoration:sub.status==="done"?"line-through":"none",wordBreak:"break-word"}}/>
      )}
      {sub.dueDate&&<span style={{fontSize:10,color:"#9ca3af",whiteSpace:"nowrap"}}>📅 {sub.dueDate}</span>}
      <StatusBadge status={sub.status} small onClick={()=>onUpdate({...sub,status:cycleStatus(sub.status)})}/>
      <button onClick={()=>onDelete(sub.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#d1d5db",fontSize:16,padding:"0 2px",minWidth:24,minHeight:24,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
    </div>
  );
}

function TaskCard({task,onUpdate,onDelete,accent}) {
  const [expanded,setExpanded]=useState(false);
  const [editing,setEditing]=useState(false);
  const [editNotes,setEditNotes]=useState(task.notes||"");
  const editRef=useRef(null);
  const subs=task.subtasks||[];
  const doneSubs=subs.filter(s=>s.status==="done").length;
  const isDone=task.status==="done";
  const addSub=d=>onUpdate({...task,subtasks:[...subs,{id:genId(),...d}]});
  const updateSub=s=>onUpdate({...task,subtasks:subs.map(x=>x.id===s.id?s:x)});
  const deleteSub=id=>onUpdate({...task,subtasks:subs.filter(x=>x.id!==id)});
  return (
    <div style={{background:"white",borderRadius:12,border:`1px solid ${isDone?"#f3f4f6":"rgba(0,0,0,0.08)"}`,marginBottom:8,overflow:"hidden",opacity:isDone?0.65:1,transition:"opacity 0.2s"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"13px 14px"}}>
        <div style={{paddingTop:4}}><PriorityDot priority={task.priority} onClick={()=>onUpdate({...task,priority:cyclePriority(task.priority)})}/></div>
        <div style={{flex:1,minWidth:0}}>
          {editing?(
            <div style={{border:`1.5px solid ${accent}44`,borderRadius:8,overflow:"hidden",marginBottom:6}}>
              <RichToolbar editorRef={editRef} accent={accent}/>
              <div ref={editRef} contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{__html:task.text}}
                onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){onUpdate({...task,text:editRef.current?.innerHTML||task.text});setEditing(false);}if(e.key==="Escape")setEditing(false);}}
                style={{minHeight:36,padding:"7px 10px",fontSize:14,fontWeight:600,outline:"none",fontFamily:"inherit",color:"#111",lineHeight:1.4}}/>
              <div style={{display:"flex",justifyContent:"flex-end",gap:5,padding:"5px 8px",background:"#fafafa",borderTop:"1px solid #f3f4f6"}}>
                <button onClick={()=>setEditing(false)} style={{fontSize:11,padding:"4px 10px",borderRadius:5,border:"1px solid #e5e7eb",background:"white",cursor:"pointer",fontFamily:"inherit",minHeight:28}}>Cancel</button>
                <button onClick={()=>{onUpdate({...task,text:editRef.current?.innerHTML||task.text});setEditing(false);}} style={{fontSize:11,padding:"4px 10px",borderRadius:5,border:"none",background:accent,color:"white",cursor:"pointer",fontFamily:"inherit",fontWeight:700,minHeight:28}}>Save</button>
              </div>
            </div>
          ):(
            <div onDoubleClick={()=>!task.synced&&setEditing(true)} dangerouslySetInnerHTML={{__html:task.text}}
              style={{fontSize:14,fontWeight:600,color:isDone?"#9ca3af":"#111",textDecoration:isDone?"line-through":"none",marginBottom:6,lineHeight:1.4,wordBreak:"break-word",cursor:task.synced?"default":"text"}}/>
          )}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {task.synced&&<span style={{fontSize:10,color:"#6366f1",fontWeight:700,letterSpacing:"0.05em"}}>↗ SYNCED</span>}
            <StatusBadge status={task.status} small onClick={()=>onUpdate({...task,status:cycleStatus(task.status)})}/>
            <span onClick={()=>onUpdate({...task,priority:cyclePriority(task.priority)})} style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,color:PRIORITIES.find(p=>p.id===task.priority)?.color||"#d97706",background:"rgba(0,0,0,0.04)",cursor:"pointer"}}>{task.priority}</span>
            {task.dueDate&&<span style={{fontSize:11,color:"#9ca3af"}}>📅 {task.dueDate}</span>}
            {subs.length>0&&<span style={{fontSize:11,color:"#9ca3af"}}>{doneSubs}/{subs.length} subtasks</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:3,alignItems:"center",flexShrink:0}}>
          <button onClick={()=>setExpanded(e=>!e)} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:expanded?accent:"#d1d5db",padding:"4px",minWidth:28,minHeight:28,display:"flex",alignItems:"center",justifyContent:"center",transform:expanded?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▼</button>
          <button onClick={()=>onDelete(task.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#e5e7eb",fontSize:16,padding:"4px",minWidth:28,minHeight:28,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
      </div>
      {expanded&&(
        <div style={{borderTop:"1px solid #f3f4f6",padding:"10px 14px 12px"}}>
          {subs.map(s=><SubtaskRow key={s.id} sub={s} onUpdate={updateSub} onDelete={deleteSub}/>)}
          <div style={{marginTop:subs.length>0?6:0}}><AddForm onAdd={addSub} accent={accent} isSubtask/></div>
          {!task.synced&&(
            <textarea value={editNotes} onChange={e=>setEditNotes(e.target.value)} onBlur={()=>onUpdate({...task,notes:editNotes})} placeholder="Notes…"
              style={{width:"100%",marginTop:8,fontSize:12,padding:"7px 10px",borderRadius:7,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",resize:"vertical",minHeight:52,outline:"none"}}/>
          )}
        </div>
      )}
    </div>
  );
}

function TableRow({task,onUpdate,onDelete,accent,depth}) {
  const [showSubs,setShowSubs]=useState(false);
  const subs=task.subtasks||[];
  const addSub=d=>{onUpdate({...task,subtasks:[...subs,{id:genId(),...d}]});setShowSubs(true);};
  const updateSub=s=>onUpdate({...task,subtasks:subs.map(x=>x.id===s.id?s:x)});
  const deleteSub=id=>onUpdate({...task,subtasks:subs.filter(x=>x.id!==id)});
  const d=depth||0;
  return (
    <>
      <tr style={{background:d>0?"#fafafa":"white",borderBottom:"1px solid #f3f4f6"}}>
        <td style={{padding:"9px 8px",width:28,textAlign:"center"}}>
          <button onClick={()=>setShowSubs(s=>!s)} style={{background:"none",border:"none",cursor:subs.length?"pointer":"default",fontSize:10,color:subs.length?"#9ca3af":"transparent",display:"inline-block",transform:showSubs?"rotate(90deg)":"none",transition:"transform 0.15s",minWidth:20,minHeight:20}}>▶</button>
        </td>
        <td style={{padding:"9px 8px",paddingLeft:d>0?28:8}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <PriorityDot priority={task.priority} onClick={()=>onUpdate({...task,priority:cyclePriority(task.priority)})}/>
            <span style={{fontSize:13,fontWeight:d===0?600:400,color:task.status==="done"?"#9ca3af":"#111",textDecoration:task.status==="done"?"line-through":"none"}}>
              {d>0&&<span style={{color:"#d1d5db",marginRight:4}}>↳</span>}
              <span dangerouslySetInnerHTML={{__html:task.text}}/>
              {task.synced&&<span style={{fontSize:10,color:"#6366f1",fontWeight:700,marginLeft:5}}>↗</span>}
            </span>
          </div>
        </td>
        <td style={{padding:"9px 8px"}}><StatusBadge status={task.status} small onClick={()=>onUpdate({...task,status:cycleStatus(task.status)})}/></td>
        <td style={{padding:"9px 8px"}}>
          <button onClick={()=>onUpdate({...task,priority:cyclePriority(task.priority)})} style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"none",border:"none",cursor:"pointer",color:PRIORITIES.find(p=>p.id===task.priority)?.color||"#d97706",minHeight:24}}>{task.priority}</button>
        </td>
        <td style={{padding:"9px 8px",fontSize:12,color:"#9ca3af",whiteSpace:"nowrap"}}>{task.dueDate||"—"}</td>
        <td style={{padding:"9px 8px",textAlign:"center",fontSize:11,color:"#9ca3af"}}>{subs.length>0?`${subs.filter(s=>s.status==="done").length}/${subs.length}`:"—"}</td>
        <td style={{padding:"9px 8px",textAlign:"center"}}>
          <button onClick={()=>onDelete(task.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#e5e7eb",fontSize:16,minWidth:28,minHeight:28,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </td>
      </tr>
      {showSubs&&subs.map(s=><TableRow key={s.id} task={s} onUpdate={updateSub} onDelete={deleteSub} accent={accent} depth={d+1}/>)}
      {showSubs&&(
        <tr style={{background:"#fafafa"}}>
          <td colSpan={7} style={{padding:"6px 8px 8px 32px"}}><AddForm onAdd={addSub} accent={accent} isSubtask/></td>
        </tr>
      )}
    </>
  );
}

function SectionPanel({section,tasks,onTasksChange,accent,viewMode,statusFilter,onSync,syncing}) {
  const [collapsed,setCollapsed]=useState(false);
  const filtered=statusFilter==="all"?tasks:tasks.filter(t=>t.status===statusFilter);
  const doneCount=tasks.filter(t=>t.status==="done").length;
  const addTask=d=>onTasksChange([...tasks,{id:genId(),...d}]);
  const updateTask=u=>onTasksChange(tasks.map(t=>t.id===u.id?u:t));
  const deleteTask=id=>onTasksChange(tasks.filter(t=>t.id!==id));
  return (
    <div style={{background:"rgba(255,255,255,0.75)",borderRadius:14,border:"1px solid rgba(0,0,0,0.07)",marginBottom:12,overflow:"hidden"}}>
      <div onClick={()=>setCollapsed(c=>!c)} style={{display:"flex",alignItems:"center",padding:"13px 16px",cursor:"pointer",borderBottom:collapsed?"none":"1px solid rgba(0,0,0,0.05)",userSelect:"none",gap:10,WebkitTapHighlightColor:"transparent"}}>
        <span style={{fontSize:18}}>{section.icon}</span>
        <span style={{fontWeight:800,fontSize:14,color:"#111",flex:1}}>{section.label}</span>
        <span style={{fontSize:11,color:"#9ca3af"}}>{doneCount}/{tasks.length}</span>
        {section.syncable&&(
          <button onClick={e=>{e.stopPropagation();onSync();}} style={{fontSize:11,padding:"4px 10px",borderRadius:6,border:`1px solid ${accent}55`,background:`${accent}12`,color:accent,cursor:"pointer",fontWeight:700,fontFamily:"inherit",minHeight:28,WebkitTapHighlightColor:"transparent"}}>
            {syncing?"⏳":"🔄"} Sync Sheet
          </button>
        )}
        <span style={{color:"#9ca3af",fontSize:11,display:"inline-block",transform:collapsed?"rotate(-90deg)":"none",transition:"transform 0.2s"}}>▼</span>
      </div>
      {!collapsed&&(
        <div style={{padding:"12px 12px"}}>
          {filtered.length===0&&tasks.length>0&&<p style={{fontSize:12,color:"#9ca3af",fontStyle:"italic",margin:"4px 0 10px",textAlign:"center"}}>No tasks match this filter</p>}
          {tasks.length===0&&<p style={{fontSize:12,color:"#d1d5db",fontStyle:"italic",margin:"4px 0 10px",textAlign:"center"}}>No tasks yet</p>}
          {viewMode==="cards"?(
            filtered.map(t=><TaskCard key={t.id} task={t} onUpdate={updateTask} onDelete={deleteTask} accent={accent}/>)
          ):filtered.length>0?(
            <div style={{overflowX:"auto",borderRadius:8,border:"1px solid #f3f4f6",marginBottom:8,WebkitOverflowScrolling:"touch"}}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:480}}>
                <thead>
                  <tr style={{background:"#f9fafb"}}>
                    <th style={{width:28,padding:"8px"}}></th>
                    {["TASK","STATUS","PRIORITY","DUE","SUBS",""].map((h,i)=>(
                      <th key={i} style={{padding:"8px",textAlign:i===5?"center":"left",fontSize:10,fontWeight:700,color:"#9ca3af",letterSpacing:"0.05em",width:i===5?32:"auto"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t=><TableRow key={t.id} task={t} onUpdate={updateTask} onDelete={deleteTask} accent={accent} depth={0}/>)}
                </tbody>
              </table>
            </div>
          ):null}
          <AddForm onAdd={addTask} accent={accent}/>
        </div>
      )}
    </div>
  );
}

function VoiceButton({onTaskCreated,currentTab}) {
  const {listening,transcript,error,supported,start,stop,setTranscript}=useVoice();
  const [phase,setPhase]=useState("idle");
  const [parsed,setParsed]=useState(null);
  const [liveText,setLiveText]=useState("");
  const [open,setOpen]=useState(false);
  useEffect(()=>{setLiveText(transcript);},[transcript]);
  useEffect(()=>{
    if(!listening&&liveText&&phase==="listening"){
      setPhase("processing");
      const today=new Date().toISOString().split("T")[0];
      parseVoiceWithClaude(liveText,currentTab,today).then(r=>{setParsed(r);setPhase("preview");}).catch(()=>setPhase("error"));
    }
  },[listening]);
  function reset(){setParsed(null);setPhase("idle");setLiveText("");setTranscript("");setOpen(false);}
  function editParsed(k,v){setParsed(p=>({...p,[k]:v}));}
  function confirm(){if(!parsed)return;onTaskCreated(parsed);reset();}
  const ac=currentTab==="work"?"#4f46e5":"#16a34a";
  return (
    <>
      <button onClick={()=>{if(!open){setOpen(true);return;}if(phase==="idle"||phase==="error"){setPhase("listening");start();}else if(phase==="listening"){stop();}}}
        style={{position:"fixed",bottom:24,right:20,zIndex:100,width:56,height:56,borderRadius:"50%",background:phase==="listening"?"#dc2626":ac,border:"none",cursor:"pointer",color:"white",fontSize:22,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 20px rgba(0,0,0,0.25)",transition:"background 0.2s",WebkitTapHighlightColor:"transparent"}}>
        {phase==="processing"?<span style={{fontSize:18,animation:"spin 0.8s linear infinite",display:"inline-block"}}>⟳</span>:phase==="listening"?"⏹":"🎙️"}
      </button>
      {open&&(
        <div style={{position:"fixed",bottom:90,right:12,left:12,maxWidth:360,margin:"0 auto",zIndex:99,background:"white",borderRadius:16,border:"1px solid rgba(0,0,0,0.1)",boxShadow:"0 8px 40px rgba(0,0,0,0.18)",overflow:"hidden"}}>
          <div style={{padding:"12px 14px",background:ac,color:"white",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{fontWeight:700,fontSize:13}}>
              {phase==="idle"&&"🎙️ Voice Task"}{phase==="listening"&&"🔴 Listening…"}{phase==="processing"&&"✨ AI parsing…"}{phase==="preview"&&"✅ Review task"}{phase==="error"&&"❌ Couldn't parse"}
            </span>
            <button onClick={reset} style={{background:"none",border:"none",cursor:"pointer",color:"white",fontSize:20,lineHeight:1,opacity:0.8,minWidth:28,minHeight:28}}>×</button>
          </div>
          <div style={{padding:14}}>
            {phase==="idle"&&(
              <div style={{textAlign:"center",padding:"6px 0 4px"}}>
                <p style={{fontSize:13,color:"#374151",marginBottom:12,lineHeight:1.5}}>Speak naturally — AI will extract the task, section, priority and due date.</p>
                <p style={{fontSize:11,color:"#9ca3af",marginBottom:14,fontStyle:"italic"}}>e.g. "Book Bali flights before end of June, low priority" → Travel section</p>
                <button onClick={()=>{setPhase("listening");start();}} style={{fontSize:13,padding:"10px 24px",borderRadius:8,border:"none",background:ac,color:"white",cursor:"pointer",fontWeight:700,fontFamily:"inherit",minHeight:40}}>🎙️ Start Recording</button>
              </div>
            )}
            {phase==="listening"&&(
              <div>
                <div style={{minHeight:64,padding:"10px 12px",background:"#f9fafb",borderRadius:8,border:"1px solid #e5e7eb",fontSize:13,color:liveText?"#111":"#9ca3af",fontStyle:liveText?"normal":"italic",lineHeight:1.5,marginBottom:10}}>{liveText||"Speak now…"}</div>
                <button onClick={()=>stop()} style={{width:"100%",fontSize:13,padding:"10px",borderRadius:8,border:"none",background:"#dc2626",color:"white",cursor:"pointer",fontWeight:700,fontFamily:"inherit",minHeight:40}}>⏹ Stop & Parse</button>
              </div>
            )}
            {phase==="processing"&&(
              <div style={{textAlign:"center",padding:"18px 0"}}>
                <div style={{fontSize:28,animation:"spin 0.8s linear infinite",display:"inline-block",marginBottom:10}}>⟳</div>
                <p style={{fontSize:12,color:"#6b7280",margin:"0 0 4px"}}>Claude is parsing your task…</p>
                <p style={{fontSize:11,color:"#9ca3af",fontStyle:"italic"}}>"{liveText}"</p>
              </div>
            )}
            {phase==="preview"&&parsed&&(
              <div>
                <div style={{marginBottom:10}}>
                  <label style={{fontSize:11,fontWeight:700,color:"#9ca3af",display:"block",marginBottom:3}}>TASK</label>
                  <input value={parsed.text} onChange={e=>editParsed("text",e.target.value)} style={{width:"100%",fontSize:13,padding:"7px 9px",borderRadius:7,border:"1px solid #e5e7eb",outline:"none",fontFamily:"inherit",color:"#111"}}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:"#9ca3af",display:"block",marginBottom:3}}>SECTION</label>
                    <select value={parsed.section} onChange={e=>editParsed("section",e.target.value)} style={{width:"100%",fontSize:11,padding:"6px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white"}}>
                      {ALL_SECTIONS.map(s=><option key={s.id} value={s.id}>{s.icon} {s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:"#9ca3af",display:"block",marginBottom:3}}>STATUS</label>
                    <select value={parsed.status} onChange={e=>editParsed("status",e.target.value)} style={{width:"100%",fontSize:11,padding:"6px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white"}}>
                      {STATUSES.filter(s=>s.id!=="all").map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:"#9ca3af",display:"block",marginBottom:3}}>PRIORITY</label>
                    <select value={parsed.priority} onChange={e=>editParsed("priority",e.target.value)} style={{width:"100%",fontSize:11,padding:"6px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151",background:"white"}}>
                      {PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:"#9ca3af",display:"block",marginBottom:3}}>DUE DATE</label>
                    <input type="date" value={parsed.dueDate} onChange={e=>editParsed("dueDate",e.target.value)} style={{width:"100%",fontSize:11,padding:"6px 7px",borderRadius:6,border:"1px solid #e5e7eb",fontFamily:"inherit",color:"#374151"}}/>
                  </div>
                </div>
                {parsed.notes&&<div style={{marginBottom:10,padding:"7px 9px",background:"#fffbeb",borderRadius:7,border:"1px solid #fde68a",fontSize:11,color:"#92400e"}}>💡 {parsed.notes}</div>}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{setPhase("idle");setLiveText("");}} style={{flex:1,fontSize:13,padding:"10px",borderRadius:8,border:"1px solid #e5e7eb",background:"white",cursor:"pointer",fontFamily:"inherit",minHeight:40}}>Re-record</button>
                  <button onClick={confirm} style={{flex:2,fontSize:13,padding:"10px",borderRadius:8,border:"none",background:ac,color:"white",cursor:"pointer",fontWeight:700,fontFamily:"inherit",minHeight:40}}>✓ Add Task</button>
                </div>
              </div>
            )}
            {phase==="error"&&(
              <div style={{textAlign:"center",padding:"8px 0"}}>
                <p style={{fontSize:13,color:"#dc2626",marginBottom:8}}>Couldn't parse. Try speaking again.</p>
                <p style={{fontSize:11,color:"#9ca3af",marginBottom:12,fontStyle:"italic"}}>"{liveText}"</p>
                <button onClick={()=>setPhase("idle")} style={{fontSize:12,padding:"8px 20px",borderRadius:8,border:"none",background:ac,color:"white",cursor:"pointer",fontWeight:700,fontFamily:"inherit",minHeight:36}}>Try Again</button>
              </div>
            )}
            {error&&<p style={{fontSize:11,color:"#dc2626",marginTop:8}}>{error}</p>}
          </div>
        </div>
      )}
    </>
  );
}

function SignInBanner({onSignIn,loading}) {
  return (
    <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:700,fontSize:13,color:"#1e40af"}}>🔗 Connect Google Sheets</div>
        <div style={{fontSize:12,color:"#3b82f6",marginTop:2}}>Sign in to sync deal tasks from your SE Deal Intelligence spreadsheet</div>
      </div>
      <button onClick={onSignIn} disabled={loading} style={{fontSize:12,padding:"8px 16px",borderRadius:8,border:"none",background:loading?"#93c5fd":"#2563eb",color:"white",cursor:loading?"default":"pointer",fontWeight:700,fontFamily:"inherit",minHeight:36,whiteSpace:"nowrap"}}>
        {loading?"⏳ Signing in…":"Sign in with Google"}
      </button>
    </div>
  );
}

export default function App() {
  const [tab,setTab]=useState("work");
  const [viewMode,setViewMode]=useState("cards");
  const [statusFilter,setStatusFilter]=useState("all");
  const [tasks,setTasks]=useState({});
  const [syncing,setSyncing]=useState(false);
  const [syncMsg,setSyncMsg]=useState(null);
  const [signedIn,setSignedIn]=useState(false);
  const [gapiLoading,setGapiLoading]=useState(false);
  const [showFilters,setShowFilters]=useState(false);
  const [dbLoading,setDbLoading]=useState(true);
  const saveTimeoutRef=useRef(null);

  const accentWork="#4f46e5";
  const accentPersonal="#16a34a";
  const accent=tab==="work"?accentWork:accentPersonal;

  useEffect(()=>{
    const ref=doc(db,"joan","tasks");
    const unsub=onSnapshot(ref,(snap)=>{
      if(snap.exists()){
        setTasks(snap.data());
      } else {
        const init={};
        [...WORK_SECTIONS,...PERSONAL_SECTIONS].forEach(s=>{init[s.id]=[];});
        setTasks(init);
        setDoc(ref,init);
      }
      setDbLoading(false);
    },(err)=>{
      console.error("Firebase error:",err);
      try{const s=localStorage.getItem("joan_todos_v3");if(s){setTasks(JSON.parse(s));}}catch{}
      setDbLoading(false);
    });
    return ()=>unsub();
  },[]);

  const saveToFirebase=useCallback((newTasks)=>{
    if(saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current=setTimeout(async()=>{
      try{await setDoc(doc(db,"joan","tasks"),newTasks);}
      catch(e){console.error("Save failed:",e);localStorage.setItem("joan_todos_v3",JSON.stringify(newTasks));}
    },800);
  },[]);

  useEffect(()=>{
    const s1=document.createElement("script");
    s1.src="https://apis.google.com/js/api.js";
    s1.onload=()=>window.gapi.load("client",async()=>{
      try{await window.gapi.client.init({discoveryDocs:[DISCOVERY]});}catch{}
    });
    document.head.appendChild(s1);
    const s2=document.createElement("script");
    s2.src="https://accounts.google.com/gsi/client";
    s2.async=true;
    document.head.appendChild(s2);
  },[]);

  const handleSignIn=useCallback(async()=>{
    setGapiLoading(true);setSyncMsg(null);
    try{
      if(!window.gapi?.client){
        await new Promise((res,rej)=>window.gapi.load("client",{callback:res,onerror:rej}));
      }
      await window.gapi.client.init({discoveryDocs:[DISCOVERY]});
      const token=await new Promise((resolve,reject)=>{
        if(!window.google?.accounts?.oauth2){
          reject(new Error("Google Identity Services not loaded yet. Please try again."));return;
        }
        const client=window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback:(response)=>{
            if(response.error)reject(new Error(response.error));
            else resolve(response.access_token);
          },
        });
        client.requestAccessToken();
      });
      window.gapi.client.setToken({access_token:token});
      setSignedIn(true);
      setSyncMsg({type:"ok",msg:"Signed in! Click Sync Sheet on Deals to load your deals."});
    }catch(err){
      console.error("Sign in error:",err);
      setSyncMsg({type:"err",msg:"Sign-in failed: "+(err.message||"Unknown error")});
    }
    setGapiLoading(false);
  },[]);

  const syncDeals=useCallback(async()=>{
    if(!signedIn){handleSignIn();return;}
    setSyncing(true);setSyncMsg(null);
    try{
      const resp=await window.gapi.client.sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:"A:AE"});
      const rows=resp.result.values||[];
      const dealTasks=[];
      for(let i=1;i<rows.length;i++){
        const row=rows[i];const dealName=row[0]?.trim();if(!dealName)continue;
        dealTasks.push({id:genId(),text:dealName,status:"waiting_on_me",priority:"medium",dueDate:"",notes:"",synced:true,rowIndex:i+1,subtasks:parseSheetTasks(row[30]||"")});
      }
      const newTasks={...tasks,deals:[...(tasks.deals||[]).filter(t=>!t.synced),...dealTasks]};
      setTasks(newTasks);saveToFirebase(newTasks);
      setSyncMsg({type:"ok",msg:`Synced ${dealTasks.length} deal${dealTasks.length!==1?"s":""} from Sheet.`});
    }catch(err){setSyncMsg({type:"err",msg:"Sync failed: "+(err.result?.error?.message||err.message||"Unknown error")});}
    setSyncing(false);
  },[signedIn,handleSignIn,tasks,saveToFirebase]);

  const writeBack=useCallback(async(dealTask)=>{
    if(!signedIn||!dealTask.rowIndex)return;
    try{await window.gapi.client.sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`AE${dealTask.rowIndex}`,valueInputOption:"RAW",resource:{values:[[serializeSheetTasks(dealTask.subtasks||[])]]}});}catch{}
  },[signedIn]);

  const updateSectionTasks=(sid,updated)=>{
    const newTasks={...tasks,[sid]:updated};
    setTasks(newTasks);saveToFirebase(newTasks);
    if(sid==="deals")updated.filter(t=>t.synced&&t.rowIndex).forEach(writeBack);
  };

  const handleVoiceTask=useCallback((parsed)=>{
    const sid=parsed.section||"general";
    const newTask={id:genId(),text:parsed.text,status:parsed.status||"waiting_on_me",priority:parsed.priority||"medium",dueDate:parsed.dueDate||"",notes:parsed.notes||"",subtasks:[],isRich:false};
    const newTasks={...tasks,[sid]:[...(tasks[sid]||[]),newTask]};
    setTasks(newTasks);saveToFirebase(newTasks);
    setTab(WORK_SECTIONS.some(s=>s.id===sid)?"work":"personal");
  },[tasks,saveToFirebase]);

  const sections=tab==="work"?WORK_SECTIONS:PERSONAL_SECTIONS;
  const allTabTasks=sections.flatMap(s=>tasks[s.id]||[]);
  const totalDone=allTabTasks.filter(t=>t.status==="done").length;
  const totalCount=allTabTasks.length;
  const statusCounts={};
  STATUSES.forEach(s=>{statusCounts[s.id]=s.id==="all"?totalCount:allTabTasks.filter(t=>t.status===s.id).length;});

  if(dbLoading) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#f0f0ff",flexDirection:"column",gap:16}}>
      <div style={{fontSize:32,animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</div>
      <p style={{fontSize:14,color:"#6b7280",fontFamily:"inherit"}}>Loading your tasks…</p>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:tab==="work"?"linear-gradient(160deg,#f0f0ff 0%,#f8f7ff 60%,#faf9ff 100%)":"linear-gradient(160deg,#f0fdf4 0%,#f7fef9 60%,#fafff8 100%)",transition:"background 0.4s",paddingBottom:88}}>
      <div style={{background:tab==="work"?"#1e1b4b":"#14532d",color:"white",transition:"background 0.4s",position:"sticky",top:0,zIndex:50}}>
        <div style={{maxWidth:860,margin:"0 auto",padding:"16px 16px 0"}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
            <div>
              <h1 style={{margin:0,fontSize:22,fontWeight:900,letterSpacing:"-0.5px"}}>{tab==="work"?"💼":"🏠"} My To-Dos</h1>
              <p style={{margin:"3px 0 0",fontSize:11,opacity:0.5}}>{new Date().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</p>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:28,fontWeight:900,lineHeight:1}}>{totalCount>0?Math.round((totalDone/totalCount)*100):0}<span style={{fontSize:14,opacity:0.6}}>%</span></div>
              <div style={{fontSize:11,opacity:0.45,marginTop:2}}>{totalDone}/{totalCount} · {totalCount-totalDone} left</div>
            </div>
          </div>
          <div style={{display:"flex",gap:4}}>
            {[{id:"work",label:"💼 Work"},{id:"personal",label:"🏠 Personal"}].map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 18px",borderRadius:"8px 8px 0 0",border:"none",background:tab===t.id?"white":"rgba(255,255,255,0.1)",color:tab===t.id?(t.id==="work"?"#1e1b4b":"#14532d"):"rgba(255,255,255,0.75)",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:"inherit",transition:"all 0.2s",WebkitTapHighlightColor:"transparent"}}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div style={{maxWidth:860,margin:"0 auto",padding:"14px 12px 16px"}}>
        {tab==="work"&&!signedIn&&<SignInBanner onSignIn={handleSignIn} loading={gapiLoading}/>}
        {syncMsg&&(
          <div style={{padding:"10px 14px",borderRadius:10,marginBottom:12,fontSize:12,background:syncMsg.type==="ok"?"#f0fdf4":"#fef2f2",color:syncMsg.type==="ok"?"#15803d":"#b91c1c",border:`1px solid ${syncMsg.type==="ok"?"#bbf7d0":"#fecaca"}`,display:"flex",alignItems:"center",gap:8}}>
            {syncMsg.type==="ok"?"✅":"❌"} {syncMsg.msg}
            <button onClick={()=>setSyncMsg(null)} style={{marginLeft:"auto",background:"none",border:"none",cursor:"pointer",fontSize:20,lineHeight:1,minWidth:28}}>×</button>
          </div>
        )}
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
            <button onClick={()=>setShowFilters(f=>!f)} style={{fontSize:12,padding:"6px 12px",borderRadius:8,border:"1px solid #e5e7eb",background:showFilters?accent:"white",color:showFilters?"white":"#374151",cursor:"pointer",fontWeight:600,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,WebkitTapHighlightColor:"transparent"}}>
              ⚡ Filters {statusFilter!=="all"&&<span style={{background:"white",color:accent,borderRadius:99,fontSize:10,fontWeight:800,padding:"1px 5px"}}>1</span>}
            </button>
            <div style={{marginLeft:"auto",display:"flex",border:"1px solid #e5e7eb",borderRadius:8,overflow:"hidden"}}>
              {[{id:"cards",label:"⊞"},{id:"table",label:"≡"}].map(v=>(
                <button key={v.id} onClick={()=>setViewMode(v.id)} style={{padding:"6px 14px",border:"none",fontFamily:"inherit",background:viewMode===v.id?accent:"white",color:viewMode===v.id?"white":"#6b7280",fontSize:14,fontWeight:700,cursor:"pointer",transition:"all 0.15s",minHeight:34,WebkitTapHighlightColor:"transparent"}}>{v.label}</button>
              ))}
            </div>
          </div>
          {showFilters&&(
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {STATUSES.map(s=>(
                <Pill key={s.id} label={`${s.label}${statusCounts[s.id]?" · "+statusCounts[s.id]:""}`} active={statusFilter===s.id} color={s.color} onClick={()=>setStatusFilter(s.id)}/>
              ))}
            </div>
          )}
        </div>
        {sections.map(section=>(
          <SectionPanel key={section.id} section={section} tasks={tasks[section.id]||[]}
            onTasksChange={updated=>updateSectionTasks(section.id,updated)}
            accent={accent} viewMode={viewMode} statusFilter={statusFilter}
            onSync={syncDeals} syncing={syncing}/>
        ))}
        <p style={{fontSize:11,color:"#b0b5be",textAlign:"center",marginTop:20,lineHeight:1.8}}>
          Synced across all devices via Firebase · Tap badges to cycle status/priority
        </p>
      </div>
      <VoiceButton onTaskCreated={handleVoiceTask} currentTab={tab}/>
    </div>
  );
}
