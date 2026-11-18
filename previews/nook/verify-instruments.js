(async()=>{
 const log=[],check=(condition,name)=>{if(!condition)throw Error(name);log.push(name);};
 const wait=()=>new Promise(r=>setTimeout(r,160));
 const pick=async i=>{document.querySelectorAll('.instrument-picker button')[i].click();await wait();};
 const state=async value=>{const s=document.querySelector('#instrument-state');s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));await wait();};
 const area=()=>document.querySelector('.active-instrument');
 for(let i=0;i<6;i++){
  await pick(i);check(area().querySelector(`.instrument-${i}`),`widget ${i} visible`);
  const box=area().getBoundingClientRect();
  for(const e of area().querySelectorAll('button,input,h3,p,strong,.date-ribbon,.hour-strip,.lane-track')){
   const b=e.getBoundingClientRect();check(b.left>=box.left-1&&b.right<=box.right+1&&b.bottom<=box.bottom+1,`widget ${i} fits ${e.className||e.tagName}`);
   if(e.matches('button,input'))check(b.width>=44&&b.height>=44,`target44 ${e.textContent||e.id}`);
  }
  for(const s of ['empty','loading','error']){await state(s);check(area().querySelector('[role=status]'),`widget ${i} ${s}`);}
  area().querySelector('button').click();await wait();check(area().querySelector(`.instrument-${i}`),`retry ${i}`);
 }
 await pick(0);area().querySelector('.timer-play').click();await new Promise(r=>setTimeout(r,1200));check(area().querySelector('.timer-center strong').textContent!=='25:00','timer ticking');area().querySelector('.timer-play').click();await wait();check(area().querySelector('.timer-play').getAttribute('aria-label')==='Mulai timer','pause');
 area().querySelector('.reset-control').click();await wait();check(area().querySelector('.timer-center strong').textContent==='25:00','reset');
 for(const time of ['05:00','15:00','25:00']){area().querySelector('.mode-control').click();await wait();check(area().querySelector('.timer-center strong').textContent===time,`mode ${time}`);}
 await pick(1);for(const day of [13,14,15,16,17]){area().querySelector(`[aria-label="${day} November"]`).click();await wait();check(area().querySelector('[aria-pressed=true] strong').textContent===String(day),`date ${day}`);}area().querySelector('.calendar-top button').click();await wait();check(area().querySelector('[aria-pressed=true] strong').textContent==='15','today');
 await pick(2);for(const input of area().querySelectorAll('input')){const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'35');input.dispatchEvent(new Event('input',{bubbles:true}));await wait();check(input.previousElementSibling.querySelector('output').textContent==='35%','slider35');}
 for(let i=0;i<2;i++){area().querySelectorAll('.control-actions button')[i].click();await wait();check(area().querySelectorAll('.control-actions button')[i].getAttribute('aria-pressed')==='true',`toggle ${i} on`);area().querySelectorAll('.control-actions button')[i].click();await wait();check(area().querySelectorAll('.control-actions button')[i].getAttribute('aria-pressed')==='false',`toggle ${i} off`);}
 check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow');
 if(innerWidth>700){check(document.querySelector('.original-media .notch-media').getBoundingClientRect().width===352,'real Media width352');check(area().getBoundingClientRect().width===252,'widget width252');check(document.querySelector('.instrument-shell').getBoundingClientRect().height===200,'shell height200');}
 await pick(0);return JSON.stringify({width:innerWidth,checks:log.length,log});
})()
