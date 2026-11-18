(async()=>{
 const log=[],check=(condition,label)=>{if(!condition)throw Error(label);log.push(label);};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const pick=async i=>{document.querySelectorAll('.instrument-picker button')[i].click();await pause(220);};
 const selected=()=>[...document.querySelectorAll('.instrument-picker button')].findIndex(e=>e.getAttribute('aria-pressed')==='true');
 const wheel=(target,dy,dx=0,ctrl=false)=>{const event=new WheelEvent('wheel',{deltaY:dy,deltaX:dx,ctrlKey:ctrl,bubbles:true,cancelable:true});target.dispatchEvent(event);return event.defaultPrevented;};
 const host=document.querySelector('.instrument-wheel'),area=()=>document.querySelector('.active-instrument');
 await pick(0);const pageY=scrollY;
 check(wheel(area(),50),'wheel consumed');await pause(220);check(selected()===1,'down opens calendar');
 wheel(area().querySelector('.agenda-note'),-50);await pause(220);check(selected()===0,'up restores Pomodoro');
 for(let i=1;i<=6;i++){wheel(area(),50);await pause(220);check(selected()===i%6,`cycle ${i}`);}
 wheel(area(),-50);await pause(220);check(selected()===5,'reverse wraps');
 await pick(0);wheel(area(),40);await pause(20);for(const delta of [30,20,10,5,2]){wheel(area(),delta);await pause(45);}check(selected()===1,'momentum advances once');
 await pause(220);wheel(area().querySelector('.date-ribbon'),40);await pause(220);check(selected()===1,'calendar keeps widget');check(area().querySelector('.date-ribbon [aria-pressed=true] strong').textContent==='16','calendar scroll changes date');
 await pick(2);const slider=area().querySelector('input');wheel(slider,60);await pause(220);check(selected()===2,'slider scroll keeps widget');
 wheel(area(),30,70);await pause(220);check(selected()===2,'horizontal gesture ignored');
 wheel(area(),30,0,true);await pause(220);check(selected()===2,'zoom gesture ignored');
 await pick(0);area().querySelector('.mode-control').click();await pause(40);area().querySelector('.timer-play').click();await pause(30);wheel(area(),50);await pause(1250);wheel(area().querySelector('.agenda-note'),-50);await pause(220);check(selected()===0,'returned to timer');check(area().querySelector('.timer-play').getAttribute('aria-label')==='Jeda timer','timer stays running');check(area().querySelector('.timer-center strong').textContent<'05:00','timer progressed while hidden');area().querySelector('.reset-control').click();await pause(30);
 host.focus();host.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await pause(220);check(selected()===1,'keyboard next');host.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));await pause(220);check(selected()===0,'keyboard previous');
 check(scrollY===pageY,'widget scroll does not move page');check(document.querySelectorAll('.active-instrument').length===1,'only one active widget');
 return JSON.stringify({checks:log.length,log});
})()
