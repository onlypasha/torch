(async () => {
  const results = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const select = (id, value) => { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new Event('change', {bubbles:true})); };
  const bounds = region => {
    const box = region.getBoundingClientRect();
    for (const node of region.querySelectorAll('button,input,.widget-title,.timer-digits,.metric,.calendar-note,.weather-hours,.lyric p')) {
      const b = node.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      assert(b.left >= box.left-1 && b.right <= box.right+1 && b.bottom <= box.bottom+1, `fits ${region.closest('section').id}: ${node.className || node.tagName}`);
      if(node.matches('button,input')) assert(b.width >= 43.9 && b.height >= 43.9, `target44 ${node.textContent || node.id}`);
    }
  };
  for (const section of document.querySelectorAll('.concept')) {
    const id = section.id;
    const region = section.querySelector('.widget-region');
    for(let widget=0; widget<6; widget++) {
      select(`widget-${id}`, String(widget));
      bounds(region);
      for(const state of ['empty','loading','error']) {
        select(`state-${id}`,state);
        assert(!!region.querySelector('[role=status]'), `${id} widget${widget} ${state}`);
        if(state==='error') { region.querySelector('[data-action=retry]').click(); assert(!region.querySelector('[role=status]'),`${id} retry`); }
      }
      select(`state-${id}`,'ready');
    }
    select(`widget-${id}`,'0');
    for(const action of ['mute','dnd']) {
      region.querySelector(`[data-action=${action}]`).click();
      assert(region.querySelector(`[data-action=${action}]`).getAttribute('aria-pressed')==='true',`${id} ${action} on`);
      region.querySelector(`[data-action=${action}]`).click();
      assert(region.querySelector(`[data-action=${action}]`).getAttribute('aria-pressed')==='false',`${id} ${action} off`);
    }
    for(const input of region.querySelectorAll('input')) { input.value='35';input.dispatchEvent(new Event('input',{bubbles:true}));assert(input.previousElementSibling.textContent.includes('35%'),`${id} range ${input.id}`); }
    select(`widget-${id}`,'2');
    for(const day of [13,14,15]) {region.querySelector(`[data-day="${day}"]`).click();assert(region.querySelector('.date-heading strong').textContent===String(day),`${id} date${day}`);}
    select(`widget-${id}`,'3');
    region.querySelector('[data-action=timer]').click();
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert(region.querySelector('.timer-digits').textContent !== '25:00',`${id} timer ticks`);
    region.querySelector('[data-action=timer]').click();
    assert(region.querySelector('[data-action=timer]').textContent==='Mulai',`${id} timer pause`);
    region.querySelector('[data-action=reset]').click();
    assert(region.querySelector('.timer-digits').textContent==='25:00',`${id} timer reset`);
    if(id==='glance') {
      region.querySelector('[data-action=back]').click();
      for(const widget of [2,3,5]) {region.querySelector(`[data-open="${widget}"]`).click();assert(!!region.querySelector('.back'),`glance opens${widget}`);region.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!!region.querySelector('.glance-list'),`glance Escape${widget}`);}
    } else {
      for(const step of ['1','-1']) {const before=document.getElementById(`widget-${id}`).value;region.querySelector(`[data-step="${step}"]`).click();assert(document.getElementById(`widget-${id}`).value!==before,`${id} navigation${step}`);}
    }
    section.querySelector('.choose').click(); assert(section.querySelector('.choose').getAttribute('aria-pressed')==='true',`${id} choose`);
  }
  for(const link of document.querySelectorAll('.jump-nav a')) {link.click(); assert(!!document.querySelector(link.hash),`jump${link.hash}`);}
  assert(document.documentElement.scrollWidth <= innerWidth, 'no page overflow');
  function lum(hex) {const c=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
  const contrast=[];
  for(const [foreground,background] of [['f4f4f6','202329'],['b0b3bd','202329'],['b0b3bd','303640'],['b0b3bd','000000'],['c4d7f8','000000'],['000000','c4d7f8'],['30343d','c4d7f8']]) {const a=lum(foreground),b=lum(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert(ratio>=4.5,`contrast${foreground}/${background}`);contrast.push({foreground,background,ratio:ratio.toFixed(2)});}
  return JSON.stringify({checks:results.length,width:innerWidth,contrast,results});
})()
