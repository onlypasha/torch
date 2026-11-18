import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion, useReducedMotion } from "framer-motion";
import "../../tests/mock-native.js";
import { setRuntimeConfig } from "../../src/config";
import { useNook } from "../../src/useNook";
import { Nook } from "../../src/NookTab";
import { WidgetWheelNavigator } from "../../src/nook";
import "../../src/App.css";
import "./instruments.css";

setRuntimeConfig({features:{media:true,tray:false,sharing:false,notifications:false,activity:false},widgets:[]});
const names=["Pomodoro","Kalender","Kontrol cepat","Monitor sistem","Lirik","Cuaca"];
const descriptions=["Waktu sebagai fokus utama, kontrol tepat di sebelahnya.","Pita tanggal dengan penanda pilihan, langsung pada permukaan notch.","Volume dan cahaya menjadi dua instrumen, tanpa panel pembungkus.","Tiga jalur metrik, masing-masing mudah dibaca sekilas.","Satu baris aktif mendapat penekanan, konteks tetap terlihat.","Suhu utama dan prakiraan pendek membentuk satu komposisi."];
const format=(value:number)=>`${Math.floor(value/60).toString().padStart(2,"0")}:${(value%60).toString().padStart(2,"0")}`;

function Instrument({kind,state="ready",onRetry}:{kind:number;state?:string;onRetry?:()=>void}){
  const fieldId=useId();
  const dateRibbon=useRef<HTMLDivElement>(null);
  const [seconds,setSeconds]=useState(1500),[running,setRunning]=useState(false),[duration,setDuration]=useState(1500);
  const [day,setDay]=useState(15),[volume,setVolume]=useState(60),[brightness,setBrightness]=useState(75),[mute,setMute]=useState(false),[dnd,setDnd]=useState(false);
  useEffect(()=>{if(!running)return;const id=setInterval(()=>setSeconds(s=>Math.max(0,s-1)),1000);return()=>clearInterval(id);},[running]);
  useEffect(()=>{if(seconds===0)setRunning(false);},[seconds]);
  useEffect(()=>{
    const node=dateRibbon.current;
    if(!node)return;
    const navigation=new WidgetWheelNavigator();
    const wheel=(event:WheelEvent)=>{
      if(event.ctrlKey||!Number.isFinite(event.deltaY)||event.deltaY===0||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
      event.preventDefault();event.stopPropagation();
      const step=navigation.step(event.deltaY,event.deltaX,performance.now(),event.deltaMode);
      if(step)setDay(value=>Math.max(13,Math.min(17,value+step)));
    };
    node.addEventListener("wheel",wheel,{passive:false});
    return()=>node.removeEventListener("wheel",wheel);
  },[kind,state]);
  if(state!=="ready")return <div className="instrument data-notice" role="status"><h3>{state==="loading"?"Memuat widget":state==="empty"?"Belum ada data":"Data gagal dimuat"}</h3><p>{state==="loading"?`Menunggu data ${names[kind].toLowerCase()}.`:state==="empty"?`${names[kind]} belum tersedia.`:"Coba lagi untuk memulihkan simulasi."}</p>{state==="error"&&<button onClick={onRetry}>Coba lagi</button>}</div>;
  return <div className={`instrument instrument-${kind}`}>
    {kind===0&&<><div className="timer-head"><button className="mode-control" onClick={()=>{const next=duration===1500?300:duration===300?900:1500;setDuration(next);setSeconds(next);setRunning(false);}} aria-label="Ganti durasi Pomodoro">{duration===1500?"Fokus":duration===300?"Jeda singkat":"Jeda panjang"}<span>{duration/60} menit</span></button><button className="reset-control" aria-label="Reset timer" onClick={()=>{setRunning(false);setSeconds(duration);}}>↺</button></div><div className="timer-center"><strong>{format(seconds)}</strong><button className="timer-play" aria-label={running?"Jeda timer":"Mulai timer"} onClick={()=>setRunning(!running)}>{running?<span aria-hidden="true">Ⅱ</span>:<span aria-hidden="true">▶</span>}</button></div><div className="timer-rule" role="progressbar" aria-label="Waktu tersisa" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(seconds/duration*100)}><span style={{width:`${seconds/duration*100}%`}}/></div><p className="timer-caption">{running?"Sesi sedang berjalan":seconds===0?"Sesi selesai":"Siap saat Anda siap"}</p></>}
    {kind===1&&<><div className="calendar-top"><h3>November <span>2026</span></h3><button onClick={()=>setDay(15)}>Hari ini</button></div><div ref={dateRibbon} className="date-ribbon" role="group" aria-label="Tanggal simulasi">{["Jum","Sab","Min","Sen","Sel"].map((label,i)=><button key={label} onClick={()=>setDay(i+13)} aria-label={`${i+13} November`} aria-pressed={day===i+13}><span>{label}</span><strong>{i+13}</strong></button>)}</div><p className="agenda-note">{day===15?"Hari ini":`${day} November`}<span>Agenda belum terhubung</span></p></>}
    {kind===2&&<><h3 className="instrument-title">Kontrol cepat</h3><div className="control-pair">{[["Volume",volume,setVolume],["Kecerahan",brightness,setBrightness]].map(([name,value,setter])=><div key={String(name)}><label htmlFor={`${fieldId}-${name}`}>{String(name)}<output>{Number(value)}%</output></label><input id={`${fieldId}-${name}`} type="range" min="0" max="100" value={Number(value)} onChange={e=>(setter as (n:number)=>void)(Number(e.target.value))}/></div>)}</div><div className="control-actions"><button aria-pressed={mute} onClick={()=>setMute(!mute)}>{mute?"Audio dibisukan":"Bisukan audio"}</button><button aria-pressed={dnd} onClick={()=>setDnd(!dnd)}>{dnd?"DND aktif":"DND mati"}</button></div></>}
    {kind===3&&<><h3 className="instrument-title">Monitor sistem <span>Simulasi</span></h3><div className="system-lanes">{[["CPU",18,"Prosesor"],["RAM",42,"Memori"],["Disk",64,"Penyimpanan"]].map(([name,value,description])=><div className="system-lane" key={name}><div><span>{name}<small>{description}</small></span><strong>{value}<small>%</small></strong></div><div className="lane-track" aria-hidden="true"><span style={{width:`${value}%`}}/></div></div>)}</div></>}
    {kind===4&&<><h3 className="instrument-title">Lirik <span>Teks contoh</span></h3><div className="lyric-instrument"><p>Baris sebelumnya</p><strong>Baris yang sedang<br/>diputar</strong><p>Baris berikutnya</p></div></>}
    {kind===5&&<><h3 className="instrument-title">Cuaca <span>Simulasi</span></h3><div className="weather-reading"><strong>27<span>°</span></strong><div>Berawan<small>Prakiraan per jam</small></div></div><div className="hour-strip">{[["Kini",27],["16.00",26],["17.00",25],["18.00",25]].map(([hour,temp])=><div key={hour}><span>{hour}</span><strong>{temp}°</strong></div>)}</div></>}
  </div>;
}
function App(){
  const [active,setActive]=useState(0),[state,setState]=useState("ready");
  const widgetHost=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const node=widgetHost.current;
    if(!node)return;
    const navigation=new WidgetWheelNavigator();
    const wheel=(event:WheelEvent)=>{
      if(event.ctrlKey||!Number.isFinite(event.deltaY)||event.deltaY===0||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
      event.preventDefault();event.stopPropagation();
      if(event.target instanceof Element&&event.target.closest("input,select,.date-ribbon"))return;
      const step=navigation.step(event.deltaY,event.deltaX,performance.now(),event.deltaMode);
      if(step){setActive(value=>(value+step+names.length)%names.length);setState("ready");}
    };
    node.addEventListener("wheel",wheel,{passive:false});
    return()=>node.removeEventListener("wheel",wheel);
  },[]);
  const nook=useNook(false),reduced=useReducedMotion();
  return <><header className="instrument-page-head"><a href="index.html">Kembali ke tiga konsep</a><h1>Nook sebagai panel instrumen.</h1><p>Setiap widget punya bentuknya sendiri, menyatu dengan permukaan notch.</p><small>Preview desain. Data dan kontrol widget merupakan simulasi lokal. Media memakai komponen asli aplikasi dalam keadaan kosong.</small></header>
  <main className="instrument-main"><nav className="instrument-picker" aria-label="Pilih widget">{names.map((name,i)=><button key={name} aria-pressed={i===active} onClick={()=>{setActive(i);setState("ready");}}>{name}</button>)}</nav>
    <h2 className="preview-heading">Preview aktif</h2><div className="instrument-stage"><div className="instrument-shell"><div className="instrument-shell-heading"><span>Nook</span><span aria-live="polite">{names[active]}</span></div><div className="instrument-shell-content"><div className="original-media"><Nook nook={nook}/></div><div ref={widgetHost} className="instrument-wheel" role="group" tabIndex={0} aria-label="Widget Nook, gulir untuk berganti" onKeyDown={event=>{if(event.target!==event.currentTarget)return;const step=["ArrowDown","ArrowRight"].includes(event.key)?1:["ArrowUp","ArrowLeft"].includes(event.key)?-1:0;if(step){event.preventDefault();setActive(value=>(value+step+names.length)%names.length);setState("ready");}}}>{names.map((_,i)=><motion.div className={i===active?"active-instrument":"retained-instrument"} hidden={i!==active} key={i} initial={false} animate={{opacity:i===active?1:0}} transition={{duration:reduced?0:.12}}><Instrument kind={i} state={i===active?state:"ready"} onRetry={()=>setState("ready")}/></motion.div>)}</div></div></div></div>
    <div className="instrument-inspector"><div><p>{descriptions[active]}</p><p className="wheel-hint">Gulir di area widget untuk berganti. Pita tanggal tetap mengatur tanggal.</p></div><label htmlFor="instrument-state">Keadaan data<select id="instrument-state" value={state} onChange={e=>setState(e.target.value)}><option value="ready">Simulasi terisi</option><option value="empty">Kosong</option><option value="loading">Memuat</option><option value="error">Gagal</option></select></label></div>
    <section className="instrument-overview" aria-labelledby="all-widgets"><h2 id="all-widgets">Keenam bentuk widget</h2><p>Ukuran asli slot widget, 252 × 148 px. Pilih widget di atas untuk mencoba kontrolnya.</p><div className="instrument-contact-sheet">{names.map((name,i)=><figure key={name}><figcaption>{name}</figcaption><div className="instrument-swatch"><div className="inert-swatch" inert><Instrument kind={i}/></div></div></figure>)}</div></section>
  </main><footer className="instrument-footer">Ukuran shell desktop 640 × 200 px. Pada layar sempit, area widget ditampilkan sendiri. Preview belum diterapkan ke aplikasi.</footer></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
