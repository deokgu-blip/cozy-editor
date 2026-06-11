/* Cube Blast — in-browser editor addon (DEV ONLY, never shipped).
   Loads only when window.__EDITOR && window.__EDITOR_API present. Talks to editor_server.py. */
(function(){
  'use strict';
  function whenReady(fn){
    if (window.__EDITOR_API) return fn(window.__EDITOR_API);
    window.addEventListener('editor-api-ready', ()=>fn(window.__EDITOR_API), {once:true});
  }
  whenReady(function(API){
  const THREE = API.THREE;

  // ---- editor state ----
  window.__EDITOR_PAUSE = true;            // freeze gameplay (no firing/voxel-consume) while editing
  try{ API.config.AUTO_ROTATE = false; }catch(e){}
  let cfg = { config:{}, octo:{}, queue:{}, puffMax:undefined };   // overrides (saved)
  const undoStack = [], redoStack = []; const UNDO_MAX = 100;
  let mode = 'select';                     // select | translate | scale | rotate
  let sel = null;                          // { obj, kind, index }
  let dragStart = null;                    // for slider undo coalescing

  // ---- param schema (sliders; also editable via gizmo where spatial) ----
  const SCHEMA = [
    {grp:'일반', items:[
      {path:'config.BULLET_SPEED', label:'총알 속도', min:8, max:800, step:1},
      {path:'config.FIRE_INTERVAL', label:'발사 간격(초)', min:0.05, max:1.0, step:0.01},
      {path:'config.ROTATION_SPEED', label:'모델 기본 회전속도', min:0, max:2, step:0.01, rot:true},
      {path:'config.CRISIS_ROTATE_SPEED', label:'피버 회전속도', min:0, max:8, step:0.1, rot:'crisis'},
      {path:'config.VOXEL_SIZE', label:'복셀 크기', min:0.3, max:1.5, step:0.02},
      {path:'puffMax', label:'머리 부풂', min:0, max:1, step:0.02},
    ]},
    {grp:'슬롯 문어', items:[
      {path:'octo.scale', label:'크기', min:0.2, max:1.6, step:0.01},
      {path:'octo.yOff', label:'상하(Y)', min:-4, max:2, step:0.02},
      {path:'octo.dist', label:'거리(Z)', min:6, max:26, step:0.1},
      {path:'octo.faceY', label:'좌우각(yaw)', min:0, max:6.283, step:0.01},
      {path:'octo.tiltX', label:'상하각(tilt)', min:-1.2, max:1.2, step:0.01},
    ]},
    {grp:'슬롯 줄(전체 위치/간격)', items:[
      {path:'slotRow.x',   label:'좌우(X)',   min:-160, max:160, step:1},
      {path:'slotRow.y',   label:'상하(Y)',   min:-140, max:140, step:1},
      {path:'slotRow.gap', label:'슬롯 간격', min:0,    max:48,  step:1},
    ]},
    {grp:'큐 문어', items:[
      {path:'queue.scale', label:'크기', min:0.2, max:1.4, step:0.01},
      {path:'queue.cols', label:'열 수', min:1, max:6, step:1},
      {path:'queue.rowsPer', label:'열당 행', min:1, max:5, step:1},
      {path:'queue.colGap', label:'좌우 간격', min:0.4, max:3.2, step:0.02},
      {path:'queue.rowGap', label:'상하 간격', min:0.3, max:2.6, step:0.02},
      {path:'queue.baseY', label:'상하(Y)', min:-5, max:0.5, step:0.02},
      {path:'queue.faceY', label:'좌우각(yaw)', min:0, max:6.283, step:0.01},
      {path:'queue.tiltX', label:'상하각(tilt)', min:-1.2, max:1.2, step:0.01},
    ]},
  ];

  // ---- value get/set ----
  function getVal(path){
    if (path==='puffMax') return API.getPuffMax();
    const [g,k]=path.split('.');
    if (g==='config') return API.config[k];
    if (g==='octo') return API.octo[k];
    if (g==='queue') return API.queue[k];
    if (g==='slotRow') return API.slotRow ? API.slotRow[k] : 0;
    return 0;
  }
  function setOverride(path, val){
    if (path==='puffMax'){ cfg.puffMax=val; return; }
    const [g,k]=path.split('.'); (cfg[g]=cfg[g]||{})[k]=val;
  }
  function applyLive(path){
    if (path==='config.VOXEL_SIZE'){ try{ API.rebuildVoxelMesh(); }catch(e){} return; }
    if (path.indexOf('octo.')===0){ try{ API.refreshSlotOctos(); }catch(e){} return; }
    if (path.indexOf('queue.')===0){ try{ API.rebuildQueueOctos(); }catch(e){} return; }
    if (path.indexOf('slotRow.')===0){ try{ API.applySlotRow(); }catch(e){} return; }
    // config.* (bullet/fire/rotation) read per-frame → instant; puffMax via setter below
  }
  function setVal(path, val, opts){
    val = +val;
    if (path==='puffMax') API.setPuffMax(val);
    else { const [g,k]=path.split('.'); if (g==='config') API.config[k]=val; else if (g==='octo') API.octo[k]=val; else if (g==='queue') API.queue[k]=val; else if (g==='slotRow' && API.slotRow) API.slotRow[k]=val; }
    setOverride(path, val);
    applyLive(path);
    if (!opts || !opts.silent) syncSlider(path, val);
  }
  function pushUndo(path, from, to){
    if (from===to) return;
    undoStack.push({path, from, to}); if (undoStack.length>UNDO_MAX) undoStack.shift();
    redoStack.length=0; updateUndoLabel();
  }

  // ---- 회전속도 라이브 프리뷰 ----
  // 게임 루프는 phase==='playing' && AUTO_ROTATE && !dragging 일 때만 돈다(에디터는 AUTO_ROTATE=false).
  // 그래서 에디터에선 별도 RAF 로 모델을 직접 돌려 슬라이더 값을 눈으로 확인시킨다.
  //   - rotPreview: '회전 미리보기' 토글(켜두면 항상 기본 회전속도로 회전 프리뷰)
  //   - rotFlashUntil: 회전속도 계열 슬라이더 조작 시 잠깐(2.5s) 자동으로 켜지는 프리뷰
  //   - rotMode: 'base'(기본)|'crisis'(피버) — 어떤 속도값으로 돌지
  let rotPreview=false, rotFlashUntil=0, rotMode='base', rotRAF=0, rotLastT=0, rotTotal=0;
  function rotPreviewActive(){ return (rotPreview || performance.now()<rotFlashUntil); }
  function rotSpeed(){
    // 피버 모드면 절대 CRISIS_ROTATE_SPEED, 아니면 기본 ROTATION_SPEED. 게임 로직(line 6658)과 동일 의미.
    return rotMode==='crisis' ? (+API.config.CRISIS_ROTATE_SPEED||0) : (+API.config.ROTATION_SPEED||0);
  }
  function rotTick(t){
    rotRAF=0;
    const dt = rotLastT ? Math.min(0.05,(t-rotLastT)/1000) : 0; rotLastT=t;
    // 복셀편집/2D모드/미리보기(실제 게임루프가 돌리는 중)에는 프리뷰 회전 안 함 — 충돌 방지.
    if (rotPreviewActive() && !vEdit && !uiMode && !previewing){
      const sp=rotSpeed();
      if (sp>0){ try{ API.rotateModelYaw(-sp*dt); rotTotal+=sp*dt; }catch(e){} }
    }
    if (rotPreviewActive()) scheduleRot(); else rotLastT=0;
  }
  function scheduleRot(){ if(!rotRAF) rotRAF=requestAnimationFrame(rotTick); }
  // 회전속도 슬라이더 조작 시 호출 → 잠깐 회전 프리뷰 켜고(또는 토글 ON 유지), 모드 설정.
  function flashRotPreview(it){
    if (!it || !it.rot) return;
    rotMode = (it.rot==='crisis') ? 'crisis' : 'base';
    rotFlashUntil = performance.now()+2500;   // 조작 후 2.5초간 회전(값 확인)
    scheduleRot();
  }
  function setRotPreview(on){
    rotPreview=on; document.body.classList.toggle('ed-rotpreview', on);
    const b=window.__edRotBtn; if(b) b.classList.toggle('on', on);
    if(on){ scheduleRot(); flash('회전 미리보기 ON — 모델이 기본 회전속도로 회전'); }
    else { flash('회전 미리보기 OFF'); }
  }

  // ---- DOM: toolbar + panel ----
  const sliderEls = {};
  function el(tag, cls, txt){ const e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function buildUI(){
    const bar = el('div','ed-bar');
    bar.innerHTML = '<b>EDITOR</b>';
    const mkBtn=(label,title,fn)=>{ const b=el('button','ed-btn',label); b.title=title; b.onclick=fn; bar.appendChild(b); return b; };
    const modeBtns={};
    [['select','선택(Q)'],['translate','이동(W)'],['scale','크기(E)'],['rotate','각도(R)']].forEach(([m,l])=>{
      modeBtns[m]=mkBtn(l, l, ()=>setMode(m));
    });
    window.__edModeBtns = modeBtns;
    mkBtn('◀','이전 스테이지',()=>gotoStage(API.stageIndex-1));
    const stageLbl = el('span','ed-stage','—'); bar.appendChild(stageLbl); window.__edStageLbl=stageLbl;
    mkBtn('▶','다음 스테이지',()=>gotoStage(API.stageIndex+1));
    mkBtn('↶ Undo','되돌리기(Cmd/Ctrl+Z)',()=>doUndo());
    mkBtn('펄스','머리 부풂 미리보기',()=>{ try{ API.deployAll(); API.pulseHeads(); }catch(e){} });
    const rotBtn=mkBtn('🔄 회전','모델 회전 미리보기 켜기/끄기(기본 회전속도)',()=>setRotPreview(!rotPreview)); window.__edRotBtn=rotBtn;
    // 참조 이미지 오버레이: 타깃 스크린샷을 게임 위에 반투명으로 깔아 UI를 1:1 정렬(클라이언트 전용·서버 불필요).
    const refBtn=mkBtn('🖼 참조','참조 이미지(스크린샷)를 게임 위에 반투명 오버레이 → UI 1:1 정렬',()=>toggleRefPanel()); window.__edRefBtn=refBtn;
    mkBtn('🧊 복셀편집','이 스테이지 복셀 편집',()=>enterVoxelEdit());
    // 코인·설정·파워업 등 모든 2D UI 편집 진입(사용자가 '코인/설정이 안 보인다' → 이 버튼 뒤에 숨어있던 문제 해소: 라벨·강조).
    const uiBtn=mkBtn('🖼 UI 편집','코인·설정·레벨·파워업·클리어 등 모든 2D UI: 위치·크기·회전·이미지교체',()=>toggleUIMode()); window.__edUIBtn=uiBtn; uiBtn.classList.add('ed-ui-cta');
    const saveBtn=mkBtn('💾 저장','현재 값을 기본값으로 저장(로컬 서버)',()=>save());
    const buildBtn=mkBtn('🛠 빌드','배포용 HTML 빌드 → 다운로드 폴더에 cube_blast.html 저장',()=>build());
    if (window.__EDITOR_API_BASE===false){ [saveBtn,buildBtn].forEach(b=>{ b.classList.add('ed-disabled'); b.title='정적(폰) 모드: 비활성 — ⬇ Export 사용'; }); }
    mkBtn('⬇ Export','전체 설정(이미지 포함)을 JSON 파일로 다운로드(백엔드 불필요)',()=>exportJSON());
    mkBtn('⬆ Import','JSON 설정 불러오기',()=>importJSON());
    const prevBtn=mkBtn('▶ 미리보기','에디터 UI 숨기고 플레이',()=>togglePreview()); window.__edPreviewBtn=prevBtn;
    document.body.appendChild(bar);

    // 미리보기 중에도 항상 떠 있는 '편집으로 돌아가기' 버튼(상단 바가 숨겨지므로 별도 플로팅). 평소엔 CSS로 숨김.
    const backBtn=el('button','ed-backbtn','■ 편집으로'); backBtn.title='에디터로 돌아가기 (Esc)';
    backBtn.onclick=()=>togglePreview(); document.body.appendChild(backBtn); window.__edBackBtn=backBtn;

    const panel = el('div','ed-panel');
    SCHEMA.forEach(sec=>{
      panel.appendChild(el('div','ed-sec', sec.grp));
      sec.items.forEach(it=>{
        const row=el('div','ed-row');
        row.appendChild(el('label','ed-lbl', it.label));
        const s=el('input','ed-range'); s.type='range'; s.min=it.min; s.max=it.max; s.step=it.step;
        const num=el('input','ed-num'); num.type='number'; num.min=it.min; num.max=it.max; num.step=it.step;
        const v=getVal(it.path); s.value=v; num.value=fmt(v);
        const onStart=()=>{ dragStart={path:it.path, from:getVal(it.path)}; if(it.rot) flashRotPreview(it); };
        const onInput=(src)=>{ const val=+src.value; setVal(it.path, val, {silent:true}); s.value=val; num.value=fmt(val); if(it.rot) flashRotPreview(it); };
        s.addEventListener('pointerdown', onStart); s.addEventListener('focus', onStart);
        s.addEventListener('input', ()=>onInput(s));
        s.addEventListener('change', ()=>{ if(dragStart&&dragStart.path===it.path){ pushUndo(it.path, dragStart.from, +s.value); dragStart=null; } });
        num.addEventListener('focus', onStart);
        num.addEventListener('input', ()=>onInput(num));
        num.addEventListener('change', ()=>{ if(dragStart&&dragStart.path===it.path){ pushUndo(it.path, dragStart.from, +num.value); dragStart=null; } });
        row.appendChild(s); row.appendChild(num);
        sliderEls[it.path]={s, num, it};
        panel.appendChild(row);
      });
    });
    const sec=el('div','ed-sec','선택(기즈모: 캔버스 클릭 또는 버튼)');
    panel.appendChild(sec);
    const selRow=el('div','ed-row');
    ['슬롯0','슬롯1','슬롯2','모델'].forEach((l,i)=>{ const b=el('button','ed-btn',l); b.onclick=()=>{ if(l==='모델') selectModel(); else selectSlot(i); }; selRow.appendChild(b); });
    panel.appendChild(selRow);
    const tip=el('div','ed-tip','Q 선택 · W 이동 · E 크기 · R 각도 · 축 핸들만 드래그 · Cmd/Ctrl+Z 되돌리기');
    panel.appendChild(tip);
    document.body.appendChild(panel);
    window.__edPanel=panel;
    updateStageLabel();
    setMode('select');
  }
  function fmt(v){ v=+v; return (Math.abs(v)>=100||Number.isInteger(v))? String(v) : v.toFixed(2); }
  function syncSlider(path, val){ const e=sliderEls[path]; if(e){ e.s.value=val; e.num.value=fmt(val); } }
  function refreshAllSliders(){ for(const p in sliderEls){ const v=getVal(p); sliderEls[p].s.value=v; sliderEls[p].num.value=fmt(v); } }
  function updateStageLabel(){ try{ const i=API.stageIndex; window.__edStageLbl.textContent=(i+1)+'/'+API.STAGES.length+' '+(API.STAGES[i].name||''); }catch(e){} }
  function updateUndoLabel(){ const b=[...document.querySelectorAll('.ed-btn')].find(x=>x.textContent.indexOf('Undo')>=0); if(b) b.textContent='↶ Undo('+undoStack.length+')'; }

  // ---- gizmo (TransformControls) ----
  let tc=null;
  function ensureTC(){
    if (tc || !THREE.TransformControls) return tc;
    tc = new THREE.TransformControls(API.viewCam, API.renderer.domElement);
    tc.setSpace('world'); tc.setSize(1.7);
    API.scene.add(tc);
    let before=null;
    tc.addEventListener('dragging-changed', e=>{
      if (e.value){ before=captureSel(); API.config.AUTO_ROTATE=false; }
      else if (before){ commitSelUndo(before); before=null; }
    });
    tc.addEventListener('objectChange', ()=>{ writeBackSel(); try{ guideReadoutPoke(); }catch(e){} });
    return tc;
  }
  function selectSlot(i){ const s=API.slots[i]; if(!s||!s.octo){ try{API.deployAll();}catch(e){} } const s2=API.slots[i]; if(s2&&s2.octo) attach(s2.octo,'slot',i); }
  function selectModel(){ attach(API.modelGroup,'model',-1); }
  function attach(obj, kind, index){
    ensureTC(); if(!tc) return;
    sel={obj, kind, index}; tc.attach(obj);
    if (mode==='select') setMode('translate'); else tc.setMode(gmode());
    flash('선택: '+kind+(index>=0?(' '+index):''));
    try{ guideReadoutPoke(); }catch(e){}
  }
  function gmode(){ return mode==='select'?'translate':mode; }
  function writeBackSel(){
    if(!sel) return;
    const o=sel.obj;
    if (sel.kind==='slot'){
      API.octo.yOff=o.position.y; API.octo.dist=-o.position.z; API.octo.scale=o.scale.x;
      API.octo.tiltX=o.rotation.x; API.octo.faceY=o.rotation.y-(o.userData.aimYaw||0);
      ['octo.yOff','octo.dist','octo.scale','octo.tiltX','octo.faceY'].forEach(p=>{ setOverride(p,getVal(p)); syncSlider(p,getVal(p)); });
      try{ API.recomputeSlotXs(); API.slots.forEach((s,i)=>{ if(s&&s.octo&&s.octo!==o){ s.octo.position.set(API.octoLocalX(i),API.octo.yOff,-API.octo.dist); s.octo.scale.setScalar(API.octo.scale); s.octo.rotation.set(API.octo.tiltX,API.octo.faceY+(s.octo.userData.aimYaw||0),0);} }); }catch(e){}
    } else if (sel.kind==='model'){ /* transient view transform */ }
  }
  function captureSel(){
    if(!sel) return null;
    if (sel.kind==='slot') return {kind:'slot', octoBefore:{yOff:API.octo.yOff,dist:API.octo.dist,scale:API.octo.scale,tiltX:API.octo.tiltX,faceY:API.octo.faceY}};
    return {kind:sel.kind};
  }
  function commitSelUndo(b){
    if (b && b.kind==='slot' && b.octoBefore){
      undoStack.push({kind:'octoSnap', before:b.octoBefore}); if(undoStack.length>UNDO_MAX) undoStack.shift();
      redoStack.length=0; updateUndoLabel();
    }
  }

  // ---- modes / shortcuts ----
  function setMode(m){ mode=m; if(tc && sel) tc.setMode(gmode()); if(tc && m==='select') {}
    const mb=window.__edModeBtns||{}; for(const k in mb) mb[k].classList.toggle('on', k===m);
  }
  window.addEventListener('keydown', e=>{
    if (e.code==='Escape' && previewing){ e.preventDefault(); togglePreview(); return; }   // 미리보기 → Esc로 편집 복귀
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if ((e.metaKey||e.ctrlKey) && e.code==='KeyZ'){ e.preventDefault(); doUndo(); return; }
    if (e.code==='KeyQ'){ setMode('select'); if(tc) tc.detach(); sel=null; }
    else if (e.code==='KeyW') setMode('translate');
    else if (e.code==='KeyE') setMode('scale');
    else if (e.code==='KeyR') setMode('rotate');
  }, true);

  // ---- canvas click select (capture phase; block game when gizmo dragging) ----
  const ray = new THREE.Raycaster();
  let downXY=null;
  function onCanvasDown(e){
    if (vEdit){ e.stopImmediatePropagation(); vDown=true; vLastX=e.clientX; vLastY=e.clientY; vMoved=0; return; }
    if (tc && tc.dragging){ e.stopImmediatePropagation(); downXY={x:e.clientX,y:e.clientY}; return; }
    downXY={x:e.clientX,y:e.clientY};
  }
  function onCanvasMove(e){
    if (vEdit){ e.stopImmediatePropagation();
      if (vDown){ const dx=e.clientX-vLastX, dy=e.clientY-vLastY; vMoved+=Math.abs(dx)+Math.abs(dy);
        API.modelGroup.rotation.y += dx*0.01;                                   // 드래그 = 턴테이블 회전
        API.modelGroup.rotation.x = Math.max(-1.2, Math.min(1.2, API.modelGroup.rotation.x + dy*0.006));
        vLastX=e.clientX; vLastY=e.clientY; }
      return; }
    if (tc && tc.dragging) e.stopImmediatePropagation();
  }
  function onCanvasUp(e){
    if (vEdit){ e.stopImmediatePropagation(); const click=vDown && vMoved<6; vDown=false; if (click) voxelOp(e); return; }
    if (tc && tc.dragging){ e.stopImmediatePropagation(); return; }
    if (!downXY) return; const moved=Math.hypot(e.clientX-downXY.x, e.clientY-downXY.y); downXY=null;
    if (moved>6) return;                       // drag = let game orbit; click = select
    const hit=pick(e); if (hit){ e.stopImmediatePropagation(); attach(hit[0], hit[1], hit[2]); }
  }
  function pick(e){
    const r=API.canvas.getBoundingClientRect();
    const nx=((e.clientX-r.left)/r.width)*2-1, ny=-((e.clientY-r.top)/r.height)*2+1;
    ray.setFromCamera({x:nx,y:ny}, API.viewCam);
    let best=null, bd=1e9;
    const consider=(obj,kind,idx)=>{ if(!obj) return; const h=ray.intersectObject(obj,true); if(h.length&&h[0].distance<bd){bd=h[0].distance; best=[obj,kind,idx];} };
    API.slots.forEach((s,i)=>{ if(s&&s.octo) consider(s.octo,'slot',i); });
    API.queueOctos.forEach((q,i)=>{ if(q&&q.octo) consider(q.octo,'queue',i); });
    consider(API.modelGroup,'model',-1);
    return best;
  }

  // ---- undo ----
  function doUndo(){
    if (vEdit){ undoV(); return; }
    const u=undoStack.pop(); if(!u) return; updateUndoLabel();
    if (u.path){ setVal(u.path, u.from); }
    else if (u.kind==='octoSnap' && u.before){ const b=u.before; ['yOff','dist','scale','tiltX','faceY'].forEach(k=>{ API.octo[k]=b[k]; setOverride('octo.'+k,b[k]); }); try{API.refreshSlotOctos();}catch(e){} refreshAllSliders(); }
    else if (u.kind==='uiSnap' && u.before){ const o=uiObj(u.sel); for(const k in o) delete o[k]; const b=u.before; ['dx','dy','w','h','scale','rot','font'].forEach(k=>{ if(b[k]) o[k]=b[k]; }); if(b.asset) o.asset=b.asset; const e2=elById(u.sel); if(e2){ e2.style.transform='';e2.style.fontSize='';e2.style.width='';e2.style.height=''; if(!b.asset && e2.tagName!=='IMG') e2.style.backgroundImage=''; } applyUI(u.sel); if(uiMode){ uiOutlineUpdate(); buildUIBar(); } }
  }

  // ---- stage nav ----
  function gotoStage(i){
    const n=API.STAGES.length; i=((i%n)+n)%n;
    try{ API.loadStage(i); }catch(e){}
    window.__EDITOR_PAUSE=true;
    setTimeout(()=>{ try{ API.deployAll(); API.refreshSlotOctos(); }catch(e){} updateStageLabel(); }, 60);
  }

  // ---- server I/O ----
  function serialize(){
    const out={config:{...cfg.config}, octo:{...cfg.octo}, queue:{...cfg.queue}};
    if(cfg.puffMax!=null) out.puffMax=cfg.puffMax;
    if(cfg.slotRow&&Object.keys(cfg.slotRow).length) out.slotRow=cfg.slotRow;
    // ui: 빈(미수정) 요소는 제외하고 직렬화(Export/저장 비대 방지)
    if(cfg.ui){ const ui={}; for(const id in cfg.ui){ if(hasOv(cfg.ui[id])) ui[id]=cfg.ui[id]; } if(Object.keys(ui).length) out.ui=ui; }
    if(cfg.perStage&&Object.keys(cfg.perStage).length) out.perStage=cfg.perStage;
    return out;
  }
  function isStatic(){ return window.__EDITOR_API_BASE===false; }
  async function save(){
    if (isStatic()){ flash('정적 모드: 저장 비활성 — ⬇ Export 로 JSON 다운로드'); return; }
    try{ const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(serialize())}); const j=await r.json(); flash(j.ok?'저장됨 ✓':'저장 실패'); }
    catch(e){ flash('저장 오류: '+e); }
  }
  async function build(){
    if (isStatic()){ flash('정적 모드: 빌드 비활성 — ⬇ Export 로 JSON 다운로드 후 PC에서 빌드'); return; }
    try{
      await save();
      const r=await fetch('/api/build-release',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();
      if(!j.ok){ flash('빌드 실패: '+(j.error||'')); return; }
      // 베이크된 배포물을 브라우저 다운로드 폴더(~/Downloads)로 저장 — blob 강제 다운로드(캐시 우회)
      flash('다운로드 중…');
      const resp=await fetch(j.url+'?v='+Date.now(), {cache:'no-store'});
      const blob=await resp.blob();
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download='cube_blast.html';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
      flash('빌드 ✓ '+Math.round(j.bytes/1024)+'KB → 다운로드됨 (cube_blast.html)');
    }
    catch(e){ flash('빌드 오류: '+e); }
  }
  async function loadConfig(){
    let data=null;
    // 백엔드(에디터 서버) 우선, 없으면 정적 주입(window.__EDITOR_CONFIG)으로 폴백 → 정적 배포에서도 동작
    if (window.__EDITOR_API_BASE!==false){
      try{ const r=await fetch('/api/load',{cache:'no-store'}); if(r.ok) data=await r.json(); }catch(e){}
    }
    if (!data || typeof data!=='object') data = (window.__EDITOR_CONFIG||{});
    applyLoadedConfig(data);
    // '제작' 탭(editor.html?making=1): 로드 후 자동으로 2D 편집 ON + 디오라마 제작 화면 진입(첫 제작요소 선택).
    if (/[?&]making=1/.test(location.search)){
      setTimeout(()=>{ try{ if(!uiMode) toggleUIMode();
        const g=UI_TREE.find(x=>/제작/.test(x.grp||'')); if(g&&g.items[0]) selectUI(g.items[0]);
      }catch(e){} }, 500);
    }
  }
  // 구버전 CSS-셀렉터 키({"#preview-strip":...,".coin-pill":...}) → data-edit-id 키로 마이그레이션
  function migrateUI(ui){
    if(!ui) return {};
    const MAP={'#preview-strip':'preview-strip','.coin-pill':'coin-pill','#coin-amount':'coin-amount',
               '.coin-icon':'coin-icon','.coin-bg':'coin-bg','#level-label':'level-label',
               '#settings-btn':'settings-btn','#powerups':'powerups'};
    const out={};
    for(const k in ui){ const nk=MAP[k]||k; out[nk]={...(out[nk]||{}),...ui[k]}; }
    return out;
  }
  function applyLoadedConfig(data){
    data=data||{};
    cfg = {config:data.config||{}, octo:data.octo||{}, queue:data.queue||{}, puffMax:data.puffMax, slotRow:data.slotRow||{}, ui:migrateUI(data.ui), perStage:data.perStage||{}};
    // apply overrides live
    for(const k in cfg.config){ API.config[k]=cfg.config[k]; }
    for(const k in cfg.octo){ API.octo[k]=cfg.octo[k]; }
    for(const k in cfg.queue){ API.queue[k]=cfg.queue[k]; }
    if (API.slotRow) for(const k in cfg.slotRow){ API.slotRow[k]=cfg.slotRow[k]; }
    if (cfg.puffMax!=null) API.setPuffMax(cfg.puffMax);
    // apply saved per-stage voxel edits (clone-on-edit) so the editor reopens with them
    for (const si in cfg.perStage){ const d=cfg.perStage[si]; if(d&&d.data){ const cid=d.modelId||('me'+si); API.VOX_MODELS[cid]={pal:d.pal,data:d.data}; API.MODELS[cid]={vox:true,build:()=>API.buildVox(cid)}; if(API.STAGES[+si]) API.STAGES[+si].modelId=cid; } }
    try{ if(cfg.config.VOXEL_SIZE!=null) API.rebuildVoxelMesh(); API.applySlotRow(); API.refreshSlotOctos(); API.rebuildQueueOctos(); ensureUIObserver(); applyAllUI(); }catch(e){}
    refreshAllSliders(); if(uiMode) buildUIBar();
  }

  // ========== 2D 리소스 에디터 — 모든 UI/배경: 위치/크기/회전/이미지교체 ==========
  // data-edit-id 로 안정 식별. 트리(그룹) + 캔버스 드래그/리사이즈/회전 핸들 + 이미지 드롭존.
  // 스키마(요소별): { dx, dy, w, h, scale, rot, font, asset(dataURI) }.
  // 동적 생성 요소(파워업 등)도 data-edit-id 가 있으면 자동 등록·재적용(MutationObserver).
  const UI_TREE = [
    {grp:'재화(코인)', items:[
      {id:'coin-pill',   label:'코인 전체'},
      {id:'coin-bg',     label:'· 숫자배경', img:true},
      {id:'coin-icon',   label:'· 코인아이콘', img:true},
      {id:'coin-amount', label:'· 코인숫자', font:true},
    ]},
    {grp:'레벨/상단', items:[
      {id:'hud-top',     label:'상단바 전체'},
      {id:'level-label', label:'· 레벨칩', font:true, img:true},
      {id:'settings-btn',label:'설정(기어) 버튼', img:true},
      {id:'preview-strip',label:'이모지 미리보기줄'},
    ]},
    {grp:'슬롯/큐(2D 컨테이너)', items:[
      {id:'slots-row',   label:'슬롯 줄'},
    ]},
    {grp:'대포 카운트 숫자', items:[
      {id:'octo-num-slot',  label:'슬롯 숫자(전체)', font:true},
      {id:'octo-num-queue', label:'큐 숫자(전체)', font:true},
    ]},
    {grp:'파워업 바', items:[
      {id:'pu-tray',     label:'· 흰색 배경(트레이)', img:true},
      {id:'powerups',    label:'파워업 바 전체'},
      {id:'pu-magnet',   label:'· 자석 전체'},
      {id:'pu-frame-magnet', label:'·· 자석 프레임', img:true},
      {id:'pu-icon-magnet',  label:'·· 자석 아이콘', img:true},
      {id:'pu-badge-magnet', label:'·· 자석 개수배지', img:true},
      {id:'pu-lv-magnet',    label:'·· 자석 잠금LV', font:true},
      {id:'pu-wand',     label:'· 마법봉 전체'},
      {id:'pu-frame-wand', label:'·· 마법봉 프레임', img:true},
      {id:'pu-icon-wand',  label:'·· 마법봉 아이콘', img:true},
      {id:'pu-badge-wand', label:'·· 마법봉 개수배지', img:true},
      {id:'pu-lv-wand',    label:'·· 마법봉 잠금LV', font:true},
      {id:'pu-extra',    label:'· 스프링 전체'},
      {id:'pu-frame-extra', label:'·· 스프링 프레임', img:true},
      {id:'pu-icon-extra',  label:'·· 스프링 아이콘', img:true},
      {id:'pu-badge-extra', label:'·· 스프링 개수배지', img:true},
      {id:'pu-lv-extra',    label:'·· 스프링 잠금LV', font:true},
      {id:'pu-rainbow',  label:'· 대포 전체'},
      {id:'pu-frame-rainbow', label:'·· 대포 프레임', img:true},
      {id:'pu-icon-rainbow',  label:'·· 대포 아이콘', img:true},
      {id:'pu-badge-rainbow', label:'·· 대포 개수배지', img:true},
      {id:'pu-lv-rainbow',    label:'·· 대포 잠금LV', font:true},
    ]},
    {grp:'클리어 화면', items:[
      {id:'clear-title',     label:'클리어 타이틀', font:true},
      {id:'clear-blocks',    label:'블록 보상 전체'},
      {id:'clear-block-icon',label:'· 블록 아이콘', img:true},
      {id:'clear-block-val', label:'· 블록 숫자', font:true},
      {id:'clear-coin',      label:'코인 보상 전체'},
      {id:'clear-coin-icon', label:'· 코인 아이콘', img:true},
      {id:'clear-coin-val',  label:'· 코인 숫자', font:true},
      {id:'clear-tap',       label:'다음 안내', font:true},
    ]},
    {grp:'디오라마 제작 화면', items:[
      {id:'make-label',  label:'제작 안내문구', font:true},
      {id:'make-top',    label:'상단 진행영역 전체'},
      {id:'make-hammer', label:'· 망치 진행원', img:true},
      {id:'make-bar',    label:'· 진행 바'},
      {id:'make-btn',    label:'큐브 버튼', img:true},
      {id:'make-next',   label:'계속 버튼', img:true, font:true},
      {id:'make-home',   label:'홈 버튼', img:true},
      {id:'make-pct',    label:'퍼센트 숫자', font:true},
    ]},
    {grp:'배경', items:[
      {id:'@background', label:'게임 배경 이미지', img:true, bgvar:'--asset-background', bgmode:'cover'},
    ]},
  ];
  // id -> 메타(라벨/플래그). '@'로 시작하면 가상(배경 등 CSS 변수 대상).
  const UI_META = {};
  UI_TREE.forEach(g=>g.items.forEach(it=>{ UI_META[it.id]=it; }));

  let uiMode=false, uiSel=null, uiOutline=null, uiBar=null, uiTreeWrap=null, uiObserver=null;
  function gameScale(){ const v=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--game-scale')); return v||1; }
  function elById(id){
    if(id && id[0]==='@') return null;               // 가상 요소(배경)는 DOM 핸들 없음
    return document.querySelector('[data-edit-id="'+id+'"]');
  }
  function uiObj(id){ cfg.ui=cfg.ui||{}; return (cfg.ui[id]=cfg.ui[id]||{}); }
  function hasOv(o){ return o && (o.dx||o.dy||o.w||o.h||(o.scale&&o.scale!==1)||o.rot||o.font||o.asset||o.hidden); }

  // ---- 적용: transform(이동/크기/회전) + 폰트 + 이미지 교체 ----
  function applyUI(id){
    const o=uiObj(id), meta=UI_META[id]||{};
    if (id[0]==='@'){                                // 가상: 배경 등 CSS 변수 교체
      if (meta.bgvar && o.asset){
        const mode=meta.bgmode||'cover';
        document.documentElement.style.setProperty(meta.bgvar, 'center/'+mode+' no-repeat url("'+o.asset+'")');
      }
      return;
    }
    const els=document.querySelectorAll('[data-edit-id="'+id+'"]'); if(!els.length) return;
    els.forEach(el2=>{
      el2.style.display = o.hidden ? 'none' : '';      // 숨김(삭제) — 게임/로비에서도 동일 적용
      const parts=[];
      if (o.dx||o.dy) parts.push('translate('+(o.dx||0)+'px,'+(o.dy||0)+'px)');
      if (o.rot) parts.push('rotate('+o.rot+'deg)');
      if (o.scale && o.scale!==1) parts.push('scale('+o.scale+')');
      el2.style.transform = parts.length ? parts.join(' ') : '';
      if (parts.length) el2.style.transformOrigin='center center';
      el2.style.width  = o.w ? (o.w+'px') : '';
      el2.style.height = o.h ? (o.h+'px') : '';
      if (o.font) el2.style.fontSize=o.font+'px'; else if (o.font===0 && el2.style.fontSize) el2.style.fontSize='';
      if (o.asset) applyAsset(el2, o.asset);
    });
  }
  // 요소 종류별 이미지 교체: <img>=src, 그 외=background-image
  function applyAsset(el2, uri){
    if (el2.tagName==='IMG'){ el2.src=uri; return; }
    el2.style.backgroundImage='url("'+uri+'")';
    const cs=getComputedStyle(el2);
    if (cs.backgroundSize==='auto' || !el2.style.backgroundSize) el2.style.backgroundSize='contain';
    if (!el2.style.backgroundRepeat) el2.style.backgroundRepeat='no-repeat';
    if (!el2.style.backgroundPosition) el2.style.backgroundPosition='center';
  }
  function applyAllUI(){ if(cfg.ui) for(const id in cfg.ui){ if(hasOv(cfg.ui[id])) applyUI(id); } }

  // 동적 요소(파워업 등) 재생성 시 오버라이드 자동 재적용
  function ensureUIObserver(){
    if (uiObserver) return;
    uiObserver=new MutationObserver(muts=>{
      let touched=false;
      for(const m of muts){ for(const n of m.addedNodes){ if(n.nodeType!==1) continue;
        if(n.hasAttribute&&n.hasAttribute('data-edit-id')){ const id=n.getAttribute('data-edit-id'); if(hasOv(uiObj(id))){ applyUI(id); touched=true; } }
        const kids=n.querySelectorAll?n.querySelectorAll('[data-edit-id]'):[];
        kids.forEach(k=>{ const id=k.getAttribute('data-edit-id'); if(hasOv(uiObj(id))){ applyUI(id); touched=true; } });
      } }
      if(touched && uiMode) uiOutlineUpdate();
    });
    uiObserver.observe(document.body, {childList:true, subtree:true});
  }

  function uiOutlineUpdate(){
    if(!uiMode||!uiSel||!uiOutline){ if(uiOutline) uiOutline.style.display='none'; return; }
    if(uiSel.id[0]==='@'){ uiOutline.style.display='none'; return; }   // 배경 = 전체화면, 외곽선 생략
    const el2=elById(uiSel.id); if(!el2){ uiOutline.style.display='none'; return; }
    const r=el2.getBoundingClientRect();
    uiOutline.style.display='block';
    uiOutline.style.left=r.left+'px'; uiOutline.style.top=r.top+'px';
    uiOutline.style.width=Math.max(10,r.width)+'px'; uiOutline.style.height=Math.max(10,r.height)+'px';
    const o=uiObj(uiSel.id);
    uiOutline.style.transform = o.rot ? ('rotate('+o.rot+'deg)') : '';
    try{ guideReadoutPoke(); }catch(e){}   // 이동/크기/회전 드래그마다 px 읽기 갱신
  }
  function uiPushUndo(id){ const o=uiObj(id); undoStack.push({kind:'uiSnap', sel:id, before:{dx:o.dx||0,dy:o.dy||0,w:o.w||0,h:o.h||0,scale:o.scale||1,rot:o.rot||0,font:o.font||0,asset:o.asset||null}}); if(undoStack.length>UNDO_MAX)undoStack.shift(); redoStack.length=0; updateUndoLabel(); }

  function ensureUIOutline(){
    if(uiOutline) return;
    uiOutline=el('div','ed-ui-outline');
    const hScale=el('div','ed-ui-handle ed-h-scale'); hScale.title='크기';
    const hRot=el('div','ed-ui-handle ed-h-rot');     hRot.title='회전';
    uiOutline.appendChild(hScale); uiOutline.appendChild(hRot);
    let mv=null, sc=null, rt=null;
    uiOutline.addEventListener('pointerdown', e=>{
      if(e.target!==uiOutline || !uiSel) return;
      e.preventDefault(); e.stopPropagation();
      uiPushUndo(uiSel.id); const o=uiObj(uiSel.id);
      mv={x:e.clientX,y:e.clientY,dx0:o.dx||0,dy0:o.dy||0}; uiOutline.setPointerCapture(e.pointerId);
    });
    uiOutline.addEventListener('pointermove', e=>{
      if(!mv||!uiSel) return; const s=gameScale(); const o=uiObj(uiSel.id);
      o.dx=Math.round(mv.dx0+(e.clientX-mv.x)/s); o.dy=Math.round(mv.dy0+(e.clientY-mv.y)/s);
      applyUI(uiSel.id); uiOutlineUpdate(); syncUIBar();
    });
    uiOutline.addEventListener('pointerup', ()=>{ mv=null; });
    // 크기 핸들(우하단)
    hScale.addEventListener('pointerdown', e=>{
      if(!uiSel) return; e.preventDefault(); e.stopPropagation();
      uiPushUndo(uiSel.id); const o=uiObj(uiSel.id);
      sc={y:e.clientY,s0:o.scale||1}; hScale.setPointerCapture(e.pointerId);
    });
    hScale.addEventListener('pointermove', e=>{
      if(!sc||!uiSel) return; const o=uiObj(uiSel.id);
      o.scale=Math.max(0.2, Math.min(4, +(sc.s0+(e.clientY-sc.y)/120).toFixed(3)));
      applyUI(uiSel.id); uiOutlineUpdate(); syncUIBar();
    });
    hScale.addEventListener('pointerup', ()=>{ sc=null; });
    // 회전 핸들(우상단) — 요소 중심 기준 각도
    hRot.addEventListener('pointerdown', e=>{
      if(!uiSel) return; e.preventDefault(); e.stopPropagation();
      uiPushUndo(uiSel.id); const el2=elById(uiSel.id); if(!el2)return; const r=el2.getBoundingClientRect();
      rt={cx:r.left+r.width/2, cy:r.top+r.height/2, r0:uiObj(uiSel.id).rot||0,
          a0:Math.atan2(e.clientY-(r.top+r.height/2), e.clientX-(r.left+r.width/2))};
      hRot.setPointerCapture(e.pointerId);
    });
    hRot.addEventListener('pointermove', e=>{
      if(!rt||!uiSel) return; const o=uiObj(uiSel.id);
      const a=Math.atan2(e.clientY-rt.cy, e.clientX-rt.cx);
      let deg=rt.r0 + (a-rt.a0)*180/Math.PI;
      deg=Math.round(deg); o.rot=((deg%360)+360)%360; if(o.rot>180)o.rot-=360;
      applyUI(uiSel.id); uiOutlineUpdate(); syncUIBar();
    });
    hRot.addEventListener('pointerup', ()=>{ rt=null; });
    document.body.appendChild(uiOutline);
  }
  function selectUI(item){
    uiSel=item;
    // 디오라마 제작 화면 요소를 고르면 제작화면을 띄워야 보이고 조절 가능 → 진입/이탈 자동 전환.
    try{ if (item && /^make-/.test(item.id)){ if(API.enterMakingPreview) API.enterMakingPreview(); }
         else { if(API.exitMakingPreview) API.exitMakingPreview(); } }catch(e){}
    ensureUIOutline(); uiOutlineUpdate(); buildUIBar(); refreshTreeSel();
  }
  function refreshTreeSel(){ if(!uiTreeWrap)return; uiTreeWrap.querySelectorAll('.ed-tree-item').forEach(b=>b.classList.toggle('on', uiSel&&b.dataset.id===uiSel.id)); }
  function syncUIBar(){ if(!uiBar||!uiSel)return; const o=uiObj(uiSel.id);
    uiBar.querySelectorAll('input.ed-range,input.ed-num2').forEach(s=>{ const k=s.dataset.k; if(!k)return; const v=(o[k]!=null?o[k]:(k==='scale'?1:0)); s.value=v; }); }

  function buildTree(){
    if(!uiTreeWrap){ uiTreeWrap=el('div','ed-tree'); }
    uiTreeWrap.innerHTML='';
    // 현재 화면의 요소만 표시: 제작 미리보기면 '디오라마 제작' 그룹만(+배경), 아니면 제작 그룹 제외(인게임 요소).
    let inMaking=false; try{ inMaking=(API.phase==='making'); }catch(e){}
    UI_TREE.forEach(g=>{
      const isMaking=/제작/.test(g.grp||''), isBg=/배경/.test(g.grp||'');
      if(!isBg){ if(inMaking!==isMaking) return; }   // 제작모드↔제작그룹만, 그 외엔 비제작 그룹만
      uiTreeWrap.appendChild(el('div','ed-tree-grp', g.grp));
      g.items.forEach(it=>{
        const b=el('div','ed-tree-item', it.label); b.dataset.id=it.id;
        const dot=el('span','ed-tree-dot'); if(hasOv(uiObj(it.id))) dot.classList.add('on'); b.insertBefore(dot, b.firstChild);
        if(uiSel&&uiSel.id===it.id) b.classList.add('on');
        b.onclick=()=>selectUI(it);
        uiTreeWrap.appendChild(b);
      });
    });
  }
  function buildUIBar(){
    if(!uiBar){ uiBar=el('div','ed-uibar'); document.body.appendChild(uiBar); }
    uiBar.style.display=''; uiBar.innerHTML='';
    const hd=el('div','ed-sec','2D 리소스 에디터'); uiBar.appendChild(hd);
    buildTree(); uiBar.appendChild(uiTreeWrap);
    if(uiSel){
      const meta=UI_META[uiSel.id]||{};
      uiBar.appendChild(el('div','ed-sec','▸ '+(meta.label||uiSel.id)));
      const mkPair=(lbl,key,min,max,step)=>{
        const o=uiObj(uiSel.id);
        const r=el('div','ed-row'); r.appendChild(el('label','ed-lbl',lbl));
        const s=el('input','ed-range'); s.type='range'; s.min=min; s.max=max; s.step=step; s.dataset.k=key;
        s.value=(o[key]!=null?o[key]:(key==='scale'?1:0));
        const n=el('input','ed-num2'); n.type='number'; n.min=min; n.max=max; n.step=step; n.dataset.k=key;
        n.value=(o[key]!=null?o[key]:(key==='scale'?1:0));
        const apply=(val)=>{ const o2=uiObj(uiSel.id); o2[key]=+val; applyUI(uiSel.id); uiOutlineUpdate(); s.value=val; n.value=val; buildTreeDots(); };
        s.addEventListener('pointerdown', ()=>uiPushUndo(uiSel.id));
        s.addEventListener('input', ()=>apply(s.value));
        n.addEventListener('focus', ()=>uiPushUndo(uiSel.id));
        n.addEventListener('input', ()=>apply(n.value));
        r.appendChild(s); r.appendChild(n); uiBar.appendChild(r);
      };
      if(uiSel.id[0]!=='@'){
        mkPair('좌우(X)','dx',-300,300,1);
        mkPair('상하(Y)','dy',-300,300,1);
        mkPair('크기','scale',0.2,4,0.01);
        mkPair('회전(°)','rot',-180,180,1);
        mkPair('폭(px)','w',0,400,1);
        mkPair('높이(px)','h',0,400,1);
        if(meta.font) mkPair('폰트(px)','font',8,64,1);
      }
      // 이미지 교체 드롭존(이미지 가능 요소만)
      if(meta.img){
        const dz=el('div','ed-drop'); const o=uiObj(uiSel.id);
        dz.innerHTML = o.asset ? '<img class="ed-drop-thumb" src="'+o.asset+'"><div class="ed-drop-x">이미지 교체됨 · 클릭/드롭으로 변경 · ✕제거</div>'
                               : '<div class="ed-drop-hint">📁 이미지 드래그&드롭<br>또는 클릭해서 파일 선택</div>';
        const fileIn=el('input'); fileIn.type='file'; fileIn.accept='image/*'; fileIn.style.display='none';
        dz.appendChild(fileIn);
        const setImg=(file)=>{ if(!file)return; const rd=new FileReader();
          rd.onload=()=>{ uiPushUndo(uiSel.id); uiObj(uiSel.id).asset=rd.result; applyUI(uiSel.id); buildUIBar(); buildTreeDots(); flash('이미지 교체됨'); };
          rd.readAsDataURL(file); };
        dz.onclick=(e)=>{ if(e.target.classList.contains('ed-drop-x')&&o.asset){ uiPushUndo(uiSel.id); const e2=elById(uiSel.id); delete uiObj(uiSel.id).asset; if(e2){ if(e2.tagName==='IMG'){ /* src 원복: 게임 재렌더가 채움 */ } else e2.style.backgroundImage=''; } applyUI(uiSel.id); buildUIBar(); buildTreeDots(); return; } fileIn.click(); };
        dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('over'); });
        dz.addEventListener('dragleave', ()=>dz.classList.remove('over'));
        dz.addEventListener('drop', e=>{ e.preventDefault(); dz.classList.remove('over'); if(e.dataTransfer.files[0]) setImg(e.dataTransfer.files[0]); });
        fileIn.addEventListener('change', ()=>{ if(fileIn.files[0]) setImg(fileIn.files[0]); });
        uiBar.appendChild(dz);
      }
      if (uiSel.id[0]!=='@'){
        const isHidden=!!uiObj(uiSel.id).hidden;
        const hb=el('span','ed-uibtn', isHidden?'👁 다시 표시':'🚫 숨기기(삭제)'); if(isHidden) hb.classList.add('on');
        hb.onclick=()=>{ uiPushUndo(uiSel.id); const o2=uiObj(uiSel.id); o2.hidden=!o2.hidden; applyUI(uiSel.id); uiOutlineUpdate(); buildUIBar(); buildTreeDots(); flash(o2.hidden?'숨김(게임에서 안 보임)':'다시 표시'); };
        uiBar.appendChild(hb);
      }
      const rb=el('span','ed-uibtn','↺ 이 요소 리셋'); rb.onclick=()=>{ uiPushUndo(uiSel.id); const e2=elById(uiSel.id); cfg.ui[uiSel.id]={}; if(e2){e2.style.transform='';e2.style.fontSize='';e2.style.width='';e2.style.height='';e2.style.backgroundImage='';e2.style.display='';} if(uiSel.id[0]==='@'&&meta.bgvar) document.documentElement.style.removeProperty(meta.bgvar); uiOutlineUpdate(); buildUIBar(); buildTreeDots(); };
      uiBar.appendChild(rb);
      uiBar.appendChild(el('div','ed-tip','목록 선택 → 외곽 드래그=이동 · ◣크기 · ↻회전 · 숫자입력 · 이미지 드롭 교체 · 🚫숨기기'));
    }
  }
  function buildTreeDots(){ if(!uiTreeWrap)return; uiTreeWrap.querySelectorAll('.ed-tree-item').forEach(b=>{ const d=b.querySelector('.ed-tree-dot'); if(d) d.classList.toggle('on', hasOv(uiObj(b.dataset.id))); }); }

  function toggleUIMode(){
    uiMode=!uiMode; document.body.classList.toggle('ed-uimode',uiMode);
    // 2D UI 편집 중엔 3D 슬라이더 패널 숨김(둘이 우측에서 겹쳐 보이던 문제 해소 — UI 트리만 보이게).
    if(window.__edPanel) window.__edPanel.style.display = uiMode ? 'none' : 'block';
    if(uiMode){ if(tc)tc.detach(); sel=null; if(!uiSel)uiSel=UI_TREE[0].items[0]; ensureUIObserver(); ensureUIOutline(); buildUIBar(); uiOutlineUpdate(); flash('UI 편집 ON — 코인·설정·파워업 등 목록/캔버스에서 편집'); }
    else { if(uiOutline)uiOutline.style.display='none'; if(uiBar)uiBar.style.display='none'; try{ if(API.exitMakingPreview) API.exitMakingPreview(); }catch(e){} flash('UI 편집 OFF — 3D 값 슬라이더로 복귀'); }
    if(window.__edUIBtn) window.__edUIBtn.classList.toggle('on',uiMode);
  }
  // UI 모드에서 화면 요소 직접 클릭 → 선택(게임 동작 차단)
  document.addEventListener('pointerdown', e=>{
    if(!uiMode) return;
    if(uiOutline&&uiOutline.contains(e.target)) return;
    if(uiBar&&uiBar.contains(e.target)) return;
    if(e.target.closest&&e.target.closest('.ed-bar')) return;
    // 가장 구체적인(가장 깊은) data-edit-id 를 선택
    const hit=e.target.closest&&e.target.closest('[data-edit-id]');
    if(hit){ const id=hit.getAttribute('data-edit-id'); const meta=UI_META[id]; if(meta){ selectUI(meta); e.preventDefault(); e.stopPropagation(); return; } }
  }, true);
  document.addEventListener('click', e=>{   // UI 모드: 등록 요소 클릭이 게임에 전달되지 않도록
    if(!uiMode) return;
    const hit=e.target.closest&&e.target.closest('[data-edit-id]');
    if(hit&&UI_META[hit.getAttribute('data-edit-id')]){ e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.addEventListener('resize', ()=>{ if(uiMode) uiOutlineUpdate(); });

  // ---- Export: 백엔드 없이 전체 설정(transforms + asset dataURI)을 단일 JSON 다운로드 ----
  function exportJSON(){
    const data=serialize();
    const blob=new Blob([JSON.stringify(data,null,1)], {type:'application/json'});
    const a=el('a'); a.href=URL.createObjectURL(blob); a.download='editor_config.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    flash('Export ✓ editor_config.json 다운로드됨 (asset 포함)');
  }
  // Import: 파일에서 설정 불러오기(정적 모드 검증·재편집용)
  function importJSON(){
    const fi=el('input'); fi.type='file'; fi.accept='application/json,.json'; fi.style.display='none';
    fi.onchange=()=>{ const f=fi.files[0]; if(!f)return; const rd=new FileReader();
      rd.onload=()=>{ try{ const d=JSON.parse(rd.result); applyLoadedConfig(d); flash('Import ✓ 설정 적용됨'); }catch(e){ flash('Import 실패: '+e.message); } };
      rd.readAsText(f); };
    document.body.appendChild(fi); fi.click(); fi.remove();
  }

  // ---- preview toggle ----
  let previewing=false;
  function togglePreview(){
    previewing=!previewing;
    window.__EDITOR_PAUSE=!previewing ? true : false;
    if (tc) tc.detach(); sel=null;
    document.body.classList.toggle('ed-previewing', previewing);
    if (window.__edPreviewBtn) window.__edPreviewBtn.textContent = previewing ? '■ 편집으로' : '▶ 미리보기';
    if (!previewing){ try{ API.config.AUTO_ROTATE=false; API.deployAll(); }catch(e){} }
  }

  // ---- toast ----
  let toastT=null;
  function flash(msg){ let t=document.getElementById('ed-toast'); if(!t){ t=el('div'); t.id='ed-toast'; document.body.appendChild(t);} t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1800); }

  // ============ VOXEL EDITOR (P2) ============
  const VPAL = ['0xe02626','0xff7a1a','0xf5b400','0x22c533','0x1f78e0','0x7a30c6','0xff2d8a','0x7a4e22','0xf4f1ea','0x1f1f1f'];
  let vEdit=false, EV=[], vCx=0,vCy=0,vCz=0, vMesh=null, vMode='add', vColor='0xe02626', vUndo=[], vHidden=null, origModelId=null, vPanel=null;
  let vPlaneY=0, vMinY=0, vMaxY=0, vDown=false, vLastX=0, vLastY=0, vMoved=0;   // build-plane + in-edit orbit
  function vComputeCenter(){ let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9; EV.forEach(v=>{mnx=Math.min(mnx,v.x);mny=Math.min(mny,v.y);mnz=Math.min(mnz,v.z);mxx=Math.max(mxx,v.x);mxy=Math.max(mxy,v.y);mxz=Math.max(mxz,v.z);}); vCx=(mnx+mxx)/2; vCy=(mny+mxy)/2; vCz=(mnz+mxz)/2; }
  function buildVMesh(){
    if (vMesh){ API.modelGroup.remove(vMesh); if(vMesh.geometry)vMesh.geometry.dispose(); vMesh=null; }
    if (!EV.length) return;
    const geo=new THREE.BoxGeometry(0.9,0.9,0.9), mat=new THREE.MeshLambertMaterial();
    vMesh=new THREE.InstancedMesh(geo, mat, EV.length);
    const d=new THREE.Object3D(), col=new THREE.Color();
    EV.forEach((v,i)=>{ d.position.set(v.x-vCx, v.y-vCy, v.z-vCz); d.updateMatrix(); vMesh.setMatrixAt(i,d.matrix); col.setHex(parseInt(v.c)); vMesh.setColorAt(i,col); });
    vMesh.instanceColor.needsUpdate=true; vMesh.userData.editor=true;
    API.modelGroup.add(vMesh);
  }
  function snapshotV(){ vUndo.push(EV.map(v=>({x:v.x,y:v.y,z:v.z,c:v.c}))); if(vUndo.length>UNDO_MAX) vUndo.shift(); }
  function undoV(){ if(!vUndo.length){ flash('되돌릴 항목 없음'); return; } EV=vUndo.pop(); buildVMesh(); updateVInfo(); }
  function encodeVox(list){
    if(!list.length) throw new Error('빈 모델');
    let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
    list.forEach(v=>{mnx=Math.min(mnx,v.x);mny=Math.min(mny,v.y);mnz=Math.min(mnz,v.z);mxx=Math.max(mxx,v.x);mxy=Math.max(mxy,v.y);mxz=Math.max(mxz,v.z);});
    if(mxx-mnx>28||mxy-mny>28||mxz-mnz>28) throw new Error('bbox>28');
    const pal=[], pidx={}; let s='';
    for(const v of list){ const x=v.x-mnx,y=v.y-mny,z=v.z-mnz; let c=v.c; if(pidx[c]===undefined){ if(pal.length>=29) throw new Error('색 과다(>29)'); pidx[c]=pal.length; pal.push(c);} s+=String.fromCharCode(x+63)+String.fromCharCode(y+63)+String.fromCharCode(z+63)+String.fromCharCode(pidx[c]+63); }
    return {pal, data:s};
  }
  function enterVoxelEdit(){
    if (vEdit) return;
    vEdit=true; window.__EDITOR_PAUSE=true; API.config.AUTO_ROTATE=false;
    if (tc) tc.detach(); sel=null;
    API.modelGroup.rotation.set(0,0,0);
    origModelId = API.STAGES[API.stageIndex].modelId;
    EV = API.buildVox(origModelId).map(v=>({x:v.x,y:v.y,z:v.z,c:v.c}));
    vComputeCenter();
    vMinY = Math.min.apply(null, EV.map(v=>v.y)); vMaxY = Math.max.apply(null, EV.map(v=>v.y)); vPlaneY = vMinY;
    vHidden = API.modelGroup.children.slice();   // hide game voxelMesh
    vHidden.forEach(c=>{ c.visible=false; });
    buildVMesh(); vUndo.length=0;
    showVPanel(true); updateVInfo();
    flash('복셀 편집: 추가/삭제/색칠 (캔버스 클릭)');
  }
  function exitVoxelEdit(save){
    if(!vEdit) return;
    if(save){ if(!commitVoxelEdit()) return; }
    vEdit=false;
    if(vMesh){ API.modelGroup.remove(vMesh); vMesh=null; }
    showVPanel(false);
    try{ API.loadStage(API.stageIndex); }catch(e){}      // re-render via game (clone if saved, original if not)
    window.__EDITOR_PAUSE=true;
    setTimeout(()=>{ try{ API.deployAll(); API.refreshSlotOctos(); }catch(e){} }, 60);
    flash(save?'복셀 저장됨(이 스테이지)':'편집 취소');
  }
  function commitVoxelEdit(){
    let enc; try{ enc=encodeVox(EV); }catch(err){ flash('인코딩 실패: '+err.message); return false; }
    const si=API.stageIndex, cloneId='me'+si;
    API.VOX_MODELS[cloneId]={pal:enc.pal, data:enc.data};
    API.MODELS[cloneId]={vox:true, build:()=>API.buildVox(cloneId)};
    API.STAGES[si].modelId=cloneId;
    cfg.perStage=cfg.perStage||{}; cfg.perStage[si]={modelId:cloneId, pal:enc.pal, data:enc.data};
    return true;
  }
  function tryAdd(X,Y,Z){
    if (EV.some(v=>v.x===X&&v.y===Y&&v.z===Z)) return false;
    const xs=EV.map(v=>v.x).concat(X), ys=EV.map(v=>v.y).concat(Y), zs=EV.map(v=>v.z).concat(Z);
    if (Math.max(...xs)-Math.min(...xs)>28||Math.max(...ys)-Math.min(...ys)>28||Math.max(...zs)-Math.min(...zs)>28){ flash('범위 초과(28)'); return false; }
    snapshotV(); EV.push({x:X,y:Y,z:Z,c:vColor}); buildVMesh(); return true;
  }
  function voxelOp(e){
    const r=API.canvas.getBoundingClientRect();
    const nx=((e.clientX-r.left)/r.width)*2-1, ny=-((e.clientY-r.top)/r.height)*2+1;
    ray.setFromCamera({x:nx,y:ny}, API.viewCam);
    const hits=vMesh?ray.intersectObject(vMesh,true):[];
    if (hits.length){
      const h=hits[0], idx=h.instanceId; if(idx==null) return true;
      if (vMode==='remove'){ snapshotV(); EV.splice(idx,1); buildVMesh(); }
      else if (vMode==='paint'){ if(EV[idx].c!==vColor){ snapshotV(); EV[idx].c=vColor; buildVMesh(); } }
      else { // add adjacent on hit face normal (face.normal is geometry-local → 회전 무관)
        const n=h.face.normal, b=EV[idx];
        tryAdd(b.x+Math.round(n.x), b.y+Math.round(n.y), b.z+Math.round(n.z));
      }
    } else if (vMode==='add'){
      // 빈 공간 클릭 → 바닥 빌드 플레인(vPlaneY)에 추가. modelGroup 로컬공간 ray로 회전 보정.
      API.modelGroup.updateWorldMatrix(true,true);
      const inv=new THREE.Matrix4().copy(API.modelGroup.matrixWorld).invert();
      const lray=ray.ray.clone().applyMatrix4(inv);
      const plane=new THREE.Plane(new THREE.Vector3(0,1,0), -(vPlaneY - vCy));
      const pt=new THREE.Vector3();
      if (lray.intersectPlane(plane, pt)) tryAdd(Math.round(pt.x+vCx), Math.round(vPlaneY), Math.round(pt.z+vCz));
      else flash('평면 밖');
    }
    updateVInfo(); return true;
  }
  function showVPanel(on){
    if (on && !vPanel){
      vPanel=el('div','ed-vpanel');
      vPanel.appendChild(el('div','ed-sec','🧊 복셀 편집'));
      const mrow=el('div','ed-row');
      [['add','추가'],['remove','삭제'],['paint','색칠']].forEach(([m,l])=>{ const b=el('button','ed-btn'+(m===vMode?' on':''),l); b.dataset.vm=m; b.onclick=()=>{ vMode=m; [...vPanel.querySelectorAll('[data-vm]')].forEach(x=>x.classList.toggle('on',x.dataset.vm===m)); }; mrow.appendChild(b); });
      vPanel.appendChild(mrow);
      const pal=el('div','ed-pal');
      VPAL.forEach(hx=>{ const sw=el('div','ed-sw'+(hx===vColor?' on':'')); sw.style.background='#'+hx.slice(2); sw.dataset.c=hx; sw.onclick=()=>{ vColor=hx; [...pal.children].forEach(x=>x.classList.toggle('on',x.dataset.c===hx)); }; pal.appendChild(sw); });
      vPanel.appendChild(pal);
      // 빈 공간 추가용 바닥 평면 높이
      const pr=el('div','ed-row');
      pr.appendChild(el('label','ed-lbl','바닥 높이 Y'));
      const ps=el('input','ed-range'); ps.type='range'; ps.step=1; ps.id='ed-planey';
      const pn=el('span','ed-num'); pn.id='ed-planey-n';
      ps.addEventListener('input',()=>{ vPlaneY=+ps.value; pn.textContent=vPlaneY; });
      pr.appendChild(ps); pr.appendChild(pn); vPanel.appendChild(pr);
      const info=el('div','ed-vinfo','—'); info.id='ed-vinfo'; vPanel.appendChild(info);
      const brow=el('div','ed-row');
      const rb=el('button','ed-btn','↺ 초기화'); rb.onclick=()=>{ snapshotV(); EV=API.buildVox(origModelId).map(v=>({x:v.x,y:v.y,z:v.z,c:v.c})); vComputeCenter(); buildVMesh(); updateVInfo(); };
      const sb=el('button','ed-btn','✓ 저장 후 닫기'); sb.onclick=()=>exitVoxelEdit(true);
      const cb=el('button','ed-btn','✗ 취소'); cb.onclick=()=>exitVoxelEdit(false);
      brow.appendChild(rb); brow.appendChild(sb); brow.appendChild(cb); vPanel.appendChild(brow);
      document.body.appendChild(vPanel);
    }
    if (on && vPanel){ const ps=vPanel.querySelector('#ed-planey'), pn=vPanel.querySelector('#ed-planey-n'); if(ps){ ps.min=vMinY-3; ps.max=vMaxY+3; ps.value=vPlaneY; pn.textContent=vPlaneY; } }
    if (vPanel) vPanel.style.display = on?'block':'none';
    if (window.__edPanel) window.__edPanel.style.display = on?'none':'block';   // hide main panel during voxel edit
  }
  function updateVInfo(){ const e=document.getElementById('ed-vinfo'); if(!e)return; let valid='OK'; try{ encodeVox(EV); }catch(err){ valid='⚠ '+err.message; } e.textContent='복셀 '+EV.length+' · '+valid; }

  // ========== 참조 이미지 오버레이 (REFERENCE) — 타깃 스크린샷을 게임 위에 반투명으로 깔아 UI 1:1 정렬 ==========
  //  - 100% 클라이언트(FileReader/dataURI) → 정적/공개 배포에서도 서버 없이 동작.
  //  - 오버레이 <img> 는 #fit-root(=기기박스 ?res / 없으면 게임영역)의 화면 박스에 맞춰 정렬 → 같은 스케일로 겹침.
  //  - pointer-events:none → 밑의 게임 UI/3D(기즈모·캔버스 선택)를 그대로 클릭/드래그 가능.
  //  - z-index: 게임 렌더 위 + 에디터 크롬(툴바100000·기즈모99998) 아래(99990) → 에디터 조작은 항상 가능.
  let refImg=null, refPanel=null, refTrackRAF=0, refVisible=true, refOpacity=0.5, refLoaded=false;
  function fitRootRect(){
    const fr=document.getElementById('fit-root');
    if (fr){ const r=fr.getBoundingClientRect(); if(r.width>4&&r.height>4) return r; }
    // 폴백: 게임 캔버스(없으면 윈도우 전체)
    try{ if(API.canvas){ const r=API.canvas.getBoundingClientRect(); if(r.width>4&&r.height>4) return r; } }catch(e){}
    return {left:0, top:0, width:window.innerWidth, height:window.innerHeight};
  }
  function ensureRefImg(){
    if (refImg) return refImg;
    refImg=el('img','ed-ref-overlay'); refImg.alt=''; refImg.draggable=false;
    document.body.appendChild(refImg);
    return refImg;
  }
  function refTrack(){
    refTrackRAF=0;
    if (refImg && refImg.style.display!=='none'){
      const r=fitRootRect();
      refImg.style.left=r.left+'px'; refImg.style.top=r.top+'px';
      refImg.style.width=r.width+'px'; refImg.style.height=r.height+'px';
    }
    // 게임 fit 이 늦게 정착(visualViewport·타이머)하므로 표시 중엔 가볍게 추적.
    if (refLoaded && refVisible) scheduleRefTrack();
  }
  function scheduleRefTrack(){ if(!refTrackRAF) refTrackRAF=requestAnimationFrame(refTrack); }
  function applyRefVisible(){
    if(!refImg) return;
    refImg.style.display = (refLoaded && refVisible) ? 'block' : 'none';
    if (refLoaded && refVisible){ refImg.style.opacity=String(refOpacity); scheduleRefTrack(); }
  }
  function loadRefFile(file){
    if(!file) return; const rd=new FileReader();
    rd.onload=()=>{ ensureRefImg().src=rd.result; refLoaded=true; refVisible=true; applyRefVisible(); buildRefPanel(); flash('참조 이미지 로드됨 — 반투명 오버레이로 정렬'); };
    rd.readAsDataURL(file);
  }
  function clearRef(){
    refLoaded=false;
    if(refImg){ refImg.src=''; refImg.style.display='none'; }
    buildRefPanel(); flash('참조 이미지 제거됨');
  }
  // 가이드 컨트롤(중앙선/그리드 토글 + px 읽기)을 참조 패널에 함께 그린다 → 오버레이 옆에서 발견성↑.
  function buildGuideSection(){
    refPanel.appendChild(el('div','ed-sec','📐 가이드'));
    const row=el('div','ed-row');
    const cb=el('span','ed-uibtn', guideCenterOn?'✚ 중앙선 ON':'✚ 중앙선');
    if(guideCenterOn) cb.classList.add('on');
    cb.onclick=()=>{ setGuideCenter(!guideCenterOn); };
    const gb=el('span','ed-uibtn', guideGridOn?'▦ 그리드 ON':'▦ 그리드');
    if(guideGridOn) gb.classList.add('on');
    gb.onclick=()=>{ setGuideGrid(!guideGridOn); };
    row.appendChild(cb); row.appendChild(gb); refPanel.appendChild(row);
    // 선택요소 px 읽기 — RAF/선택 변화 시 갱신. 패널 열려있을 때만 표시(닫히면 비용 0).
    refPanel.appendChild(guideHUDEnsure());
    updateGuideHUD();
    refPanel.appendChild(el('div','ed-tip','중앙선·그리드는 게임 디자인공간(390×844) 박스에 맞춰 표시됩니다(클릭 통과). 요소(코인·레벨·설정·파워업 등)를 선택하면 위치/크기를 px로 읽어 참조와 1:1로 맞출 수 있습니다.'));
  }
  function buildRefPanel(){
    if(!refPanel){ refPanel=el('div','ed-refpanel'); document.body.appendChild(refPanel); }
    refPanel.innerHTML='';
    refPanel.appendChild(el('div','ed-sec','🖼 참조 이미지'));
    // 파일 선택(클라이언트 전용 — 서버 호출 없음)
    const fileIn=el('input'); fileIn.type='file'; fileIn.accept='image/*'; fileIn.style.display='none';
    fileIn.addEventListener('change', ()=>{ if(fileIn.files[0]) loadRefFile(fileIn.files[0]); });
    refPanel.appendChild(fileIn);
    if(!refLoaded){
      const dz=el('div','ed-refdrop','📁 클릭/드롭으로 참조 스크린샷 불러오기');
      dz.onclick=()=>fileIn.click();
      dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', ()=>dz.classList.remove('over'));
      dz.addEventListener('drop', e=>{ e.preventDefault(); dz.classList.remove('over'); if(e.dataTransfer.files[0]) loadRefFile(e.dataTransfer.files[0]); });
      refPanel.appendChild(dz);
      refPanel.appendChild(el('div','ed-tip','타깃 화면 스크린샷을 올리면 게임 위에 반투명으로 겹쳐서 보여줍니다. 우리 UI를 드래그/슬라이더로 그 위치에 맞추세요.'));
      buildGuideSection();   // 참조 미로드 상태에서도 가이드는 사용 가능
      return;
    }
    // 미리보기 썸네일 + 교체/제거
    const thumb=el('img','ed-refthumb'); thumb.src=refImg?refImg.src:''; refPanel.appendChild(thumb);
    // 투명도 슬라이더(0~100%)
    const or=el('div','ed-row'); or.appendChild(el('label','ed-lbl','투명도'));
    const os=el('input','ed-range'); os.type='range'; os.min=0; os.max=100; os.step=1; os.value=Math.round(refOpacity*100);
    const on=el('span','ed-num'); on.textContent=Math.round(refOpacity*100)+'%';
    os.addEventListener('input', ()=>{ refOpacity=(+os.value)/100; on.textContent=os.value+'%'; if(refImg) refImg.style.opacity=String(refOpacity); });
    or.appendChild(os); or.appendChild(on); refPanel.appendChild(or);
    // 보이기/숨기기 토글
    const tr=el('div','ed-row');
    const tb=el('span','ed-uibtn',refVisible?'👁 표시 중(숨기기)':'🚫 숨김(표시)'); if(refVisible) tb.classList.add('on');
    tb.onclick=()=>{ refVisible=!refVisible; applyRefVisible(); buildRefPanel(); };
    const rep=el('span','ed-uibtn','🔄 교체'); rep.onclick=()=>fileIn.click();
    const cl=el('span','ed-uibtn','🗑 제거'); cl.onclick=()=>clearRef();
    tr.appendChild(tb); tr.appendChild(rep); tr.appendChild(cl); refPanel.appendChild(tr);
    refPanel.appendChild(el('div','ed-tip','오버레이는 클릭이 통과(pointer-events:none)되어 밑의 게임 UI·3D를 그대로 편집할 수 있습니다. 기기(📱) 선택 시 기기박스에 맞춰 정렬됩니다.'));
    buildGuideSection();
  }
  function toggleRefPanel(){
    if(!refPanel){ buildRefPanel(); }
    const showing = refPanel.style.display!=='none' && refPanel.dataset.open==='1';
    refPanel.dataset.open = showing ? '0' : '1';
    refPanel.style.display = showing ? 'none' : 'block';
    if(window.__edRefBtn) window.__edRefBtn.classList.toggle('on', !showing);
    if(!showing){ buildRefPanel(); refPanel.style.display='block'; refPanel.dataset.open='1'; if(window.__edRefBtn) window.__edRefBtn.classList.add('on'); }
  }
  window.addEventListener('resize', ()=>{ if(refLoaded&&refVisible) scheduleRefTrack(); });
  if (window.visualViewport){ window.visualViewport.addEventListener('resize', ()=>{ if(refLoaded&&refVisible) scheduleRefTrack(); }); }

  // ========== 디자인 가이드 (GUIDES) — 중앙선 + 그리드 + 선택요소 px 읽기 (디자인툴 감각) ==========
  //  - 100% 클라이언트(DOM/RAF) → 정적/공개 배포에서도 서버 없이 동작. 참조 오버레이와 공존.
  //  - 게임 디자인공간 박스(#game-container, 390×844 가 --game-scale 로 스케일된 화면 rect)에 정렬.
  //    참조 오버레이는 #fit-root(기기박스)에 맞추지만, 가이드/읽기는 실제 디자인공간 박스(390×844)에
  //    맞춰야 px 가 정확 → gameBoxRect() 별도 사용. 둘 다 RAF 로 추적(리사이즈/기기변경/늦은 fit 정착 대응).
  //  - pointer-events:none → 밑 게임/UI 편집을 그대로. z 99991~99992: 참조(99990) 위, 에디터 크롬(99998↑) 아래.
  let guideLayer=null, guideV=null, guideH=null, guideGridOn=false, guideCenterOn=false, guideRAF=0, guideHUD=null;
  // 디자인공간(390×844) 박스의 화면 rect. #game-container 가 transform:scale 로 그려진 실제 픽셀 박스.
  function gameBoxRect(){
    const gc=document.getElementById('game-container');
    if (gc){ const r=gc.getBoundingClientRect(); if(r.width>4&&r.height>4) return r; }
    return fitRootRect();   // 폴백
  }
  function ensureGuideLayer(){
    if (guideLayer) return guideLayer;
    guideLayer=el('div','ed-guide-layer');           // 박스에 맞춰 위치/크기 잡는 컨테이너(pointer-events:none)
    guideV=el('div','ed-guide-line v');               // 세로 중앙선
    guideH=el('div','ed-guide-line h');               // 가로 중앙선
    guideLayer.appendChild(guideV); guideLayer.appendChild(guideH);
    document.body.appendChild(guideLayer);
    return guideLayer;
  }
  function guideActive(){ return guideCenterOn || guideGridOn; }
  // 그리드를 디자인공간 px(GRID_DESIGN) 간격으로 그린다 → 화면에선 scale 곱해 표시(반복 배경).
  const GRID_DESIGN = 10;
  function applyGuideGridBg(scale){
    if(!guideLayer) return;
    if (guideGridOn){
      const step=(GRID_DESIGN*scale);
      const major=step*5;   // 50디자인px 굵은 선
      guideLayer.style.backgroundImage =
        'linear-gradient(to right, rgba(0,255,255,.18) 1px, transparent 1px),'+
        'linear-gradient(to bottom, rgba(0,255,255,.18) 1px, transparent 1px),'+
        'linear-gradient(to right, rgba(0,255,255,.34) 1px, transparent 1px),'+
        'linear-gradient(to bottom, rgba(0,255,255,.34) 1px, transparent 1px)';
      guideLayer.style.backgroundSize = step+'px '+step+'px, '+step+'px '+step+'px, '+major+'px '+major+'px, '+major+'px '+major+'px';
      guideLayer.style.backgroundPosition='0 0';
    } else {
      guideLayer.style.backgroundImage='none';
    }
  }
  function guideTrack(){
    guideRAF=0;
    if (!guideActive()){ if(guideLayer) guideLayer.style.display='none'; return; }
    ensureGuideLayer();
    const r=gameBoxRect();
    guideLayer.style.display='block';
    guideLayer.style.left=r.left+'px'; guideLayer.style.top=r.top+'px';
    guideLayer.style.width=r.width+'px'; guideLayer.style.height=r.height+'px';
    guideV.style.display = guideCenterOn ? 'block' : 'none';
    guideH.style.display = guideCenterOn ? 'block' : 'none';
    applyGuideGridBg(gameScale());
    scheduleGuide();   // fit 이 늦게 정착하므로 켜있는 동안 가볍게 추적
    updateGuideHUD();
  }
  function scheduleGuide(){ if(!guideRAF && guideActive()) guideRAF=requestAnimationFrame(guideTrack); }
  function setGuideCenter(on){ guideCenterOn=!!on; if(guideActive()){ ensureGuideLayer(); scheduleGuide(); } else if(guideLayer){ guideLayer.style.display='none'; } if(refPanel&&refPanel.style.display!=='none') buildRefPanel(); }
  function setGuideGrid(on){ guideGridOn=!!on; if(guideActive()){ ensureGuideLayer(); scheduleGuide(); } else if(guideLayer){ guideLayer.style.display='none'; } if(refPanel&&refPanel.style.display!=='none') buildRefPanel(); }

  // ---- 선택 요소 px 읽기(디자인공간 390×844 기준) ----
  //  DOM UI 요소: getBoundingClientRect() 를 게임박스 원점·gameScale 로 역매핑 → 디자인 px.
  //  3D(model/슬롯/큐): 화면 bbox 를 디자인 px 로 환산(보너스). 둘 다 없으면 '—'.
  function guideHUDEnsure(){
    if (guideHUD) return guideHUD;
    guideHUD=el('div','ed-guide-readout'); guideHUD.textContent='—';
    return guideHUD;
  }
  // 선택된 것의 디자인공간 px {x,y,w,h,label}. UI편집 우선(uiSel), 그다음 3D 기즈모(sel).
  //  기준 원점은 #fit-root(=화면/기기 박스) 좌상단, 스케일은 --game-scale(디자인→화면 px).
  //  이유: HUD·설정·파워업 등은 #fit-root 직속(화면 끝 고정, 미스케일), 슬롯/큐는 #game-container(스케일) 안.
  //  둘을 같은 디자인 px 로 읽으려면 화면 박스(fit-root) 기준·gameScale 나눗셈이 일관적이고 참조 측정과 맞음.
  function selectedDesignBox(){
    const box=fitRootRect(), s=gameScale()||1;
    const toDesign=(r)=>({ x:Math.round((r.left-box.left)/s), y:Math.round((r.top-box.top)/s),
                           w:Math.round(r.width/s), h:Math.round(r.height/s) });
    // 1) 2D UI 편집 선택
    if (uiMode && uiSel && uiSel.id && uiSel.id[0]!=='@'){
      const e2=elById(uiSel.id); if(e2){ const d=toDesign(e2.getBoundingClientRect()); const m=UI_META[uiSel.id]||{}; return {...d, label:(m.label||uiSel.id)}; }
    }
    // 2) 3D 기즈모 선택(model/slot/queue) — 화면 bbox 투영
    if (sel && sel.obj){
      try{
        const r=projectObjScreenRect(sel.obj);
        if(r){ const d=toDesign(r); return {...d, label:(sel.kind+(sel.index>=0?(' '+sel.index):'')), is3d:true}; }
      }catch(e){}
    }
    return null;
  }
  // 3D 오브젝트의 화면 bbox(클라이언트 px). Box3 → 8코너 투영 → 화면 min/max.
  const _gb3=new THREE.Box3(), _gv3=new THREE.Vector3();
  function projectObjScreenRect(obj){
    _gb3.setFromObject(obj); if(!isFinite(_gb3.min.x)) return null;
    const cr=API.canvas.getBoundingClientRect(); let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
    const corners=[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
    for(const c of corners){
      _gv3.set(c[0]?_gb3.max.x:_gb3.min.x, c[1]?_gb3.max.y:_gb3.min.y, c[2]?_gb3.max.z:_gb3.min.z);
      _gv3.project(API.viewCam);
      const sx=cr.left+(_gv3.x*0.5+0.5)*cr.width, sy=cr.top+(-_gv3.y*0.5+0.5)*cr.height;
      mnx=Math.min(mnx,sx); mny=Math.min(mny,sy); mxx=Math.max(mxx,sx); mxy=Math.max(mxy,sy);
    }
    return {left:mnx, top:mny, width:mxx-mnx, height:mxy-mny};
  }
  function updateGuideHUD(){
    if(!guideHUD) return;
    const b=selectedDesignBox();
    if(!b){ guideHUD.innerHTML='<span class="ed-gr-dim">요소를 선택하면 px 표시</span>'; return; }
    guideHUD.innerHTML='<b>'+(b.label||'')+'</b>'+(b.is3d?' <span class="ed-gr-dim">(3D 투영)</span>':'')+
      '<div class="ed-gr-grid"><span>X</span><b>'+b.x+'</b><span>Y</span><b>'+b.y+'</b>'+
      '<span>W</span><b>'+b.w+'</b><span>H</span><b>'+b.h+'</b></div>'+
      '<div class="ed-gr-dim">디자인공간 390×844 px</div>';
  }
  // 선택/드래그 변할 때 읽기 갱신 — 가이드가 켜져있으면 RAF 가 매 프레임 갱신하지만,
  // 꺼져있어도 패널이 열려있으면 즉시 갱신되도록 외부 훅에서 호출.
  function guideReadoutPoke(){ if(refPanel&&refPanel.style.display!=='none'&&guideHUD) updateGuideHUD(); }
  window.addEventListener('resize', ()=>{ if(guideActive()) scheduleGuide(); });
  if (window.visualViewport){ window.visualViewport.addEventListener('resize', ()=>{ if(guideActive()) scheduleGuide(); }); }
  // .ed-previewing 시 가이드 숨김은 CSS(.ed-guide-layer)가 처리.

  // ---- boot editor ----
  buildUI();
  API.canvas.addEventListener('pointerdown', onCanvasDown, true);
  API.canvas.addEventListener('pointerup', onCanvasUp, true);
  API.canvas.addEventListener('pointermove', onCanvasMove, true);
  setTimeout(async ()=>{
    await loadConfig();
    refreshAllSliders();
    try{ API.deployAll(); API.refreshSlotOctos(); }catch(e){}
    updateStageLabel();
    flash('에디터 준비됨');
  }, 120);
  window.__ED = { API, cfg:()=>cfg, getVal, setVal, save, build, gotoStage, undo:doUndo, selectSlot, selectModel, setMode, undoLen:()=>undoStack.length,
    enterVoxelEdit, exitVoxelEdit, setVMode:(m)=>{vMode=m;}, setVColor:(c)=>{vColor=c;}, evLen:()=>EV.length, evRef:()=>EV, vUndoFn:undoV, snapshotV, buildVMesh,
    encodeTest:()=>{ try{ return encodeVox(EV); }catch(e){ return {error:e.message}; } },
    exportJSON, importJSON, applyConfig:applyLoadedConfig, serialize,
    setRotPreview, rotPreviewOn:()=>rotPreview, flashRot:(mode)=>{ flashRotPreview({rot:mode==='crisis'?'crisis':true}); },
    modelYaw:()=>{ try{ return API.modelGroup.rotation.y; }catch(e){ return 0; } },
    rotTotal:()=>rotTotal, rotActive:()=>rotPreviewActive(),
    ref:{ toggle:toggleRefPanel, set:(uri)=>{ ensureRefImg().src=uri; refLoaded=true; refVisible=true; applyRefVisible(); if(refPanel)buildRefPanel(); },
          opacity:(v)=>{ refOpacity=Math.max(0,Math.min(1,+v)); if(refImg)refImg.style.opacity=String(refOpacity); if(refPanel)buildRefPanel(); },
          show:(on)=>{ refVisible=!!on; applyRefVisible(); if(refPanel)buildRefPanel(); },
          clear:clearRef, loaded:()=>refLoaded, visible:()=>refVisible, opacityVal:()=>refOpacity,
          rect:()=>{ if(!refImg) return null; const r=refImg.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height,pe:getComputedStyle(refImg).pointerEvents,z:getComputedStyle(refImg).zIndex,opacity:getComputedStyle(refImg).opacity,display:getComputedStyle(refImg).display}; },
          fitRect:()=>{ const r=fitRootRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; } },
    guides:{ center:(on)=>setGuideCenter(on), grid:(on)=>setGuideGrid(on),
             centerOn:()=>guideCenterOn, gridOn:()=>guideGridOn,
             readout:()=>selectedDesignBox(),   // 선택요소 디자인 px {x,y,w,h,label}
             layerRect:()=>{ if(!guideLayer) return null; const r=guideLayer.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height,pe:getComputedStyle(guideLayer).pointerEvents,z:getComputedStyle(guideLayer).zIndex,display:getComputedStyle(guideLayer).display}; },
             gameBox:()=>{ const r=gameBoxRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; } },
    ui:{ toggle:toggleUIMode, mode:()=>uiMode, list:()=>Object.keys(UI_META), sel:()=>uiSel&&uiSel.id,
         select:(id)=>selectUI(UI_META[id]||UI_TREE[0].items[0]),
         set:(id,k,v)=>{ uiPushUndo(id); uiObj(id)[k]=v; applyUI(id); uiOutlineUpdate(); syncUIBar(); buildTreeDots&&buildTreeDots(); },
         setAsset:(id,uri)=>{ uiPushUndo(id); uiObj(id).asset=uri; applyUI(id); if(uiMode)buildUIBar(); },
         get:(id)=>({...uiObj(id)}) } };
  });
})();
