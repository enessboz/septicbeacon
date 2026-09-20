const SUPABASE_URL="https://dkpsiwytmvgylqhbntmg.supabase.co";
const ANON_KEY=window.SEPTICBEACON_SUPABASE_ANON_KEY||"sb_publishable_AvR-71NF4xi_KdBZc-gSAg_mN8Cq8rl";
const $=(s,r=document)=>r.querySelector(s), token=()=>localStorage.getItem("sb_access_token"), refreshToken=()=>localStorage.getItem("sb_refresh_token");
const ADMIN_BASE="/sb-control-8n4k";
const loginPath=location.pathname===ADMIN_BASE+"/login";
const adminPath=!loginPath&&(location.pathname===ADMIN_BASE||location.pathname.startsWith(ADMIN_BASE+"/"));
const esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const headers=(auth=true)=>({apikey:ANON_KEY,"Content-Type":"application/json",...(auth&&token()?{Authorization:`Bearer ${token()}`}:{})});
let currentUser=null;
let currentSiteTimezone="America/New_York";

function formatSiteDateTime(iso){
  if(!iso)return "";
  try{
    return new Intl.DateTimeFormat("en-US",{
      timeZone:currentSiteTimezone,year:"numeric",month:"short",day:"2-digit",
      hour:"2-digit",minute:"2-digit",hour12:false,timeZoneName:"short"
    }).format(new Date(iso));
  }catch{return new Date(iso).toLocaleString()}
}
function siteLocalValue(iso){
  if(!iso)return "";
  try{
    const parts=new Intl.DateTimeFormat("en-CA",{
      timeZone:currentSiteTimezone,year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(new Date(iso));
    const v=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
  }catch{return ""}
}
function zoneOffsetMs(date,timeZone){
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  }).formatToParts(date);
  const v=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,Number(x.value)]));
  return Date.UTC(v.year,v.month-1,v.day,v.hour,v.minute,v.second)-date.getTime();
}
function siteLocalToIso(value){
  const m=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if(!m)return null;
  const naive=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],0);
  let guess=new Date(naive);
  let offset=zoneOffsetMs(guess,currentSiteTimezone);
  guess=new Date(naive-offset);
  offset=zoneOffsetMs(guess,currentSiteTimezone);
  return new Date(naive-offset).toISOString();
}

async function api(path,options={}){
  const r=await fetch(`${SUPABASE_URL}${path}`,{
    ...options,
    headers:{...headers(options.auth!==false),...(options.headers||{})}
  });
  const text=await r.text();
  if(!r.ok){
    let detail=text||r.statusText||`HTTP ${r.status}`;
    try{
      const parsed=text?JSON.parse(text):null;
      detail=parsed?.message||parsed?.error_description||parsed?.hint||detail;
      if(parsed?.details) detail+=` — ${parsed.details}`;
    }catch{}
    throw new Error(detail);
  }
  if(!text.trim()) return null;
  try{return JSON.parse(text)}
  catch{return text}
}
function saveSession(s){localStorage.setItem("sb_access_token",s.access_token);localStorage.setItem("sb_refresh_token",s.refresh_token)}
function clearSession(){localStorage.removeItem("sb_access_token");localStorage.removeItem("sb_refresh_token")}
async function renew(){if(!refreshToken())return false;try{saveSession(await api("/auth/v1/token?grant_type=refresh_token",{method:"POST",auth:false,body:JSON.stringify({refresh_token:refreshToken()})}));return true}catch{return false}}
async function requireAuth(){if(!token()&&!(await renew())){location.replace(ADMIN_BASE+"/login");return false}try{currentUser=await api("/auth/v1/user")}catch{if(!(await renew())){clearSession();location.replace(ADMIN_BASE+"/login");return false}currentUser=await api("/auth/v1/user")}const m=await api(`/rest/v1/site_members?user_id=eq.${currentUser.id}&select=role&limit=1`);if(!m.length){clearSession();location.replace(ADMIN_BASE+"/login?error=unauthorized");return false}currentUser.cmsRole=m[0].role;document.documentElement.style.visibility="visible";adminTools();return true}
function adminTools(){const a=$(".admin-actions");if(!a||$("#rvf-logout"))return;const role=document.createElement("span");role.className="subtle";role.textContent=currentUser.cmsRole;const b=document.createElement("button");b.id="rvf-logout";b.className="btn";b.type="button";b.textContent="Logout";b.onclick=async()=>{try{await api("/auth/v1/logout",{method:"POST"})}catch{}clearSession();location.replace(ADMIN_BASE+"/login")};a.prepend(role,b)}
const authReady=adminPath?requireAuth().catch(()=>{clearSession();location.replace(ADMIN_BASE+"/login");return false}):Promise.resolve(true);

if(loginPath){
  document.documentElement.style.visibility="visible";
  if(token())location.replace(ADMIN_BASE);

  $("#login")?.addEventListener("submit",async e=>{
    e.preventDefault();
    $("#message").textContent="Signing in…";
    try{
      const s=await api("/auth/v1/token?grant_type=password",{
        method:"POST",auth:false,
        body:JSON.stringify({email:$("#email").value.trim(),password:$("#password").value})
      });
      saveSession(s);
      location.replace(ADMIN_BASE);
    }catch(err){
      $("#message").textContent="Sign in failed. Check your email and password.";
    }
  });

  $("#signup")?.addEventListener("click",async ()=>{
    const email=$("#email").value.trim();
    const password=$("#password").value;
    if(!email||!password||password.length<8){
      $("#message").textContent="Enter your email and a password with at least 8 characters.";
      return;
    }
    $("#signup").disabled=true;
    $("#message").textContent="Creating your SepticBeacon admin account…";
    try{
      const s=await api("/auth/v1/signup",{
        method:"POST",auth:false,
        body:JSON.stringify({email,password,data:{name:"SepticBeacon Owner"}})
      });
      if(s?.access_token&&s?.refresh_token){
        saveSession(s);
        location.replace(ADMIN_BASE);
        return;
      }
      $("#message").textContent="Account created. Check your email to confirm it, then return here and sign in.";
    }catch(err){
      $("#message").textContent=err.message||"Account creation failed.";
    }finally{
      $("#signup").disabled=false;
    }
  });
}
async function site(){const r=await api("/rest/v1/sites?domain=eq.septicbeacon.com&select=id,name,timezone");if(!r.length)throw new Error("Site record not found");currentSiteTimezone=r[0].timezone||"America/New_York";return r[0]}
const statusLabel=s=>({draft:"Draft",editorial_qa:"Editorial QA",technical_review:"Technical Review",ready:"Ready",scheduled:"Scheduled",published:"Published",refresh:"Refresh",archived:"Archived"}[s]||s);
const nextStatus=a=>a.status==="published"?"draft":"published";


let articleCache=[];
async function loadArticles(){
  const body=$("#live-articles");
  if(!body||!(await authReady))return;
  const currentSite=await site();articleCache=await api(`/rest/v1/articles?site_id=eq.${currentSite.id}&select=id,title,slug,status,content_type,primary_keyword,updated_at,published_at,scheduled_at,categories(name,slug)&order=updated_at.desc`);
  renderArticles(articleCache);
  const counts=articleCache.reduce((a,x)=>{a.total++;a[x.status]=(a[x.status]||0)+1;return a},{total:0});
  const f=$("#article-filters");
  if(f)f.innerHTML=[
    ["all",`Tümü ${counts.total}`],["draft",`Taslak ${counts.draft||0}`],["scheduled",`Planlı ${counts.scheduled||0}`],["published",`Yayında ${counts.published||0}`],["archived",`Arşiv ${counts.archived||0}`]
  ].map(([k,t])=>`<button class="filter-chip" data-filter="${k}">${t}</button>`).join("");
  f?.addEventListener("click",e=>{const b=e.target.closest("[data-filter]");if(!b)return;const k=b.dataset.filter;renderArticles(k==="all"?articleCache:articleCache.filter(x=>x.status===k))});
  $("#article-search")?.addEventListener("input",e=>{const q=e.target.value.toLowerCase().trim();renderArticles(!q?articleCache:articleCache.filter(x=>[x.title,x.slug,x.primary_keyword].some(v=>String(v||"").toLowerCase().includes(q))))});
}
function renderArticles(rows){
  const body=$("#live-articles");if(!body)return;
  body.innerHTML=rows.map(a=>`<tr>
    <td><a href="${ADMIN_BASE}/quick-entry?id=${a.id}"><b>${esc(a.title)}</b></a><br><span class="subtle">/${esc(a.categories?.slug||"guides")}/${esc(a.slug)}</span></td>
    <td>${esc(a.content_type)}</td><td>${esc(a.categories?.name||"—")}</td>
    <td><span class="status ${a.status==="draft"?"draft":a.status==="published"?"":"review"}">${statusLabel(a.status)}</span>${a.status==="scheduled"&&a.scheduled_at?`<br><span class="subtle">${esc(formatSiteDateTime(a.scheduled_at))}</span>`:""}</td>
    <td><div class="admin-actions"><a class="btn" href="${ADMIN_BASE}/quick-entry?id=${a.id}">Edit</a>
    ${a.status==="published"?`<a class="btn" href="/${esc(a.categories?.slug||"guides")}/${esc(a.slug)}" target="_blank" rel="noopener">View</a><button class="btn" data-unpublish="${a.id}">Unpublish</button>`:`<button class="btn primary" data-publish="${a.id}">Publish</button>`}
    <button class="btn" data-archive="${a.id}">Archive</button></div></td>
    <td>${new Date(a.updated_at).toLocaleDateString()}</td></tr>`).join("")||'<tr><td colspan="6">Henüz içerik yok.</td></tr>';
  body.onclick=articleAction;
}
async function articleAction(e){
  const pub=e.target.closest("[data-publish]"),unpub=e.target.closest("[data-unpublish]"),archive=e.target.closest("[data-archive]");
  try{
    if(pub){
      pub.disabled=true;
      const id=pub.dataset.publish;
      await api(`/rest/v1/articles?id=eq.${id}`,{method:"PATCH",body:JSON.stringify({status:"published",published_at:new Date().toISOString(),updated_by:currentUser.id})});
      return loadArticles();
    }
    if(unpub){
      unpub.disabled=true;
      await api(`/rest/v1/articles?id=eq.${unpub.dataset.unpublish}`,{method:"PATCH",body:JSON.stringify({status:"draft",updated_by:currentUser.id})});
      return loadArticles();
    }
    if(archive&&confirm("Bu içerik arşive alınsın mı?")){
      archive.disabled=true;
      await api(`/rest/v1/articles?id=eq.${archive.dataset.archive}`,{method:"PATCH",body:JSON.stringify({status:"archived",updated_by:currentUser.id})});
      return loadArticles();
    }
  }catch(err){alert(`İşlem başarısız: ${err.message}`);loadArticles()}
}

async function syncRelations(articleId,siteId,sourcesText,linksText){
  await api(`/rest/v1/article_sources?article_id=eq.${articleId}`,{method:"DELETE"});
  await api(`/rest/v1/internal_links?source_article_id=eq.${articleId}`,{method:"DELETE"});
  const sources=sourcesText.split("\n").map((line,i)=>{const [label,url,source_type="reference"]=line.split("|").map(x=>x.trim());return label?{article_id:articleId,label,url:url||null,source_type,sort_order:i}:null}).filter(Boolean);
  const links=linksText.split("\n").map(line=>{const [anchor_text,target_path]=line.split("|").map(x=>x.trim());return anchor_text&&target_path?{site_id:siteId,source_article_id:articleId,anchor_text,target_path,is_live:true}:null}).filter(Boolean);
  if(sources.length)await api("/rest/v1/article_sources",{method:"POST",body:JSON.stringify(sources)});
  if(links.length)await api("/rest/v1/internal_links",{method:"POST",body:JSON.stringify(links)});
}

async function adminJson(path,options={}){
  const r=await fetch(path,{
    ...options,
    headers:{...(options.headers||{}),Authorization:`Bearer ${token()}`}
  });
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{}}catch{data={error:text||`HTTP ${r.status}`}}
  if(!r.ok)throw new Error(data.error||data.message||`HTTP ${r.status}`);
  return data;
}

async function decodeImageFile(file){
  if("createImageBitmap" in window){
    const bitmap=await createImageBitmap(file);
    return {source:bitmap,width:bitmap.width,height:bitmap.height,cleanup:()=>bitmap.close?.()};
  }
  const url=URL.createObjectURL(file);
  const img=await new Promise((resolve,reject)=>{
    const el=new Image();el.onload=()=>resolve(el);el.onerror=reject;el.src=url;
  });
  return {source:img,width:img.naturalWidth,height:img.naturalHeight,cleanup:()=>URL.revokeObjectURL(url)};
}

async function compressToWebp(file,{maxDimension=2000,quality=.82}={}){
  if(!file)throw new Error("Önce bir görsel seç.");
  if(!/^image\//.test(file.type))throw new Error("Geçerli bir görsel dosyası seç.");
  const decoded=await decodeImageFile(file);
  try{
    const scale=Math.min(1,maxDimension/Math.max(decoded.width,decoded.height));
    const width=Math.max(1,Math.round(decoded.width*scale));
    const height=Math.max(1,Math.round(decoded.height*scale));
    const canvas=document.createElement("canvas");
    canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext("2d");
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    ctx.drawImage(decoded.source,0,0,width,height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/webp",quality));
    if(!blob)throw new Error("WebP dönüşümü başarısız.");
    return {blob,width,height,originalBytes:file.size,optimizedBytes:blob.size};
  }finally{decoded.cleanup()}
}

async function uploadMediaFile(file,{alt="",caption="",articleId=null}={}){
  const prepared=await compressToWebp(file);
  const name=String(file.name||"septic-image").replace(/\.[^.]+$/,"");
  const params=new URLSearchParams({
    name,
    alt,
    caption,
    width:String(prepared.width),
    height:String(prepared.height),
    original_name:file.name||"",
    ...(articleId?{article_id:articleId}:{})
  });
  const data=await adminJson(`/api/media/upload?${params}`,{
    method:"POST",
    headers:{"Content-Type":"image/webp"},
    body:prepared.blob
  });
  return {...data.media,compression:{original:prepared.originalBytes,optimized:prepared.optimizedBytes}};
}

function mediaSavings(media){
  const c=media?.compression;
  if(!c||!c.original)return "";
  const pct=Math.max(0,Math.round((1-c.optimized/c.original)*100));
  return `${(c.original/1024/1024).toFixed(2)} MB → ${(c.optimized/1024).toFixed(0)} KB · %${pct} smaller`;
}

function insertAtCursor(textarea,text){
  const start=textarea.selectionStart??textarea.value.length;
  const end=textarea.selectionEnd??start;
  const before=textarea.value.slice(0,start);
  const after=textarea.value.slice(end);
  const prefix=before && !before.endsWith("\n")?"\n\n":"";
  const suffix=after && !after.startsWith("\n")?"\n\n":"";
  textarea.value=before+prefix+text+suffix+after;
  const pos=(before+prefix+text).length;
  textarea.focus();textarea.setSelectionRange(pos,pos);
  textarea.dispatchEvent(new Event("input",{bubbles:true}));
}

function mediaCardHtml(m,{pick=false}={}){
  const kb=m.bytes?`${Math.round(Number(m.bytes)/1024)} KB`:"";
  return `<article class="media-library-item" data-media-id="${esc(m.id)}">
    <button type="button" class="media-library-thumb ${pick?"is-pickable":""}" ${pick?`data-pick-media="${esc(m.id)}"`:""}>
      <img src="${esc(m.public_url)}" alt="${esc(m.alt_text||"")}" loading="lazy">
    </button>
    <div class="media-library-item-body">
      <div class="media-library-item-title">${esc(m.alt_text||m.original_name||"Untitled image")}</div>
      <div class="subtle">${m.width||"?"}×${m.height||"?"}${kb?` · ${kb}`:""}</div>
      ${m.caption?`<div class="media-caption-preview">${esc(m.caption)}</div>`:""}
      ${pick?"":`<div class="mini-actions"><button class="btn" type="button" data-copy-media="${esc(m.public_url)}">Copy URL</button><button class="btn" type="button" data-copy-md="${esc(m.id)}">Markdown</button><button class="btn" type="button" data-edit-media="${esc(m.id)}">Edit</button><button class="btn danger-soft" type="button" data-delete-media="${esc(m.id)}">Delete</button></div>`}
    </div>
  </article>`;
}

async function initEditor(){
  const form=$("#quick-entry-form");
  if(!form||!(await authReady))return;

  if($("#cms-db-state"))$("#cms-db-state").textContent="Connected";
  const message=$("#qe-message");
  const s=await site();
  if($("#schedule-timezone"))$("#schedule-timezone").textContent=currentSiteTimezone;
  const cats=await api(`/rest/v1/categories?site_id=eq.${s.id}&select=id,name,slug&order=sort_order`);
  $("#category_id").innerHTML='<option value="">Kategori seç</option>'+cats.map(c=>`<option value="${c.id}" data-slug="${esc(c.slug)}">${esc(c.name)}</option>`).join("");

  const slugify=v=>String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/&/g," and ").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,90);
  const categorySlug=()=>$("#category_id")?.selectedOptions?.[0]?.dataset?.slug||"guides";
  let slugTouched=false,canonicalTouched=false;
  let originalStatus="draft",originalPublishedAt=null;

  const lines=name=>(form.elements[name]?.value||"").split("\n").map(x=>x.trim()).filter(Boolean);
  const validSources=()=>lines("sources_text").filter(line=>{
    const [label,url]=line.split("|").map(x=>x.trim());
    return !!label && !!url && /^https?:\/\//i.test(url);
  });
  const validLinks=()=>lines("internal_links_text").filter(line=>{
    const [anchor,path]=line.split("|").map(x=>x.trim());
    return !!anchor && !!path && path.startsWith("/");
  });

  function inspect(){
    const title=form.title.value.trim();
    const slug=form.slug.value.trim();
    const seo=form.seo_title.value.trim();
    const meta=form.meta_description.value.trim();
    const body=form.content_markdown.value.trim();
    const sources=validSources();
    const links=validLinks();
    const category=!!form.category_id.value;
    const canonical=form.canonical_path.value.trim();

    const result={
      title:title.length>=3,
      category,
      seo:!!seo || !!meta || !!canonical,
      body:body.length>0,
      sources:sources.length>0,
      links:links.length>0
    };
    return {result,title,slug,seo,meta,body,sources,links,category,canonical};
  }

  function setGate(id,ok,text){
    const el=$(id);if(!el)return;
    el.textContent=text;
    el.className=ok?"gate-ok":"gate-warn";
  }

  function updateUI(){
    const c=inspect(),r=c.result;
    $("#seo-title-count").textContent=c.seo.length;
    $("#meta-count").textContent=c.meta.length;
    $("#body-count").textContent=c.body.length;

    setGate("#gate-title",r.title,r.title?"✓":"Önerilir");
    setGate("#gate-seo",r.seo,r.seo?"✓":"Opsiyonel");
    setGate("#gate-body",r.body,r.body?"✓":`${c.body.length} karakter`);
    setGate("#gate-sources",r.sources,String(c.sources.length));
    setGate("#gate-links",r.links,String(c.links.length));

    const score=Math.round(Object.values(r).filter(Boolean).length/Object.keys(r).length*100);
    $("#live-score").textContent=score;
    $("#editor-preview").innerHTML=`<b>${esc(c.title||"Untitled article")}</b><br><br>${esc(categorySlug())} · ${esc(form.content_type.value)}<br><br>${c.body?esc(c.body.replace(/^#+\s*/gm,"").slice(0,170))+"…":"Makale gövdesi henüz boş."}`;
    return {score,...c};
  }

  $("#slug")?.addEventListener("input",()=>{slugTouched=true;updateUI()});
  $("#canonical_path")?.addEventListener("input",()=>{canonicalTouched=true;updateUI()});
  $("#title")?.addEventListener("input",e=>{
    if(!slugTouched)$("#slug").value=slugify(e.target.value);
    if(!canonicalTouched)$("#canonical_path").value=`/${categorySlug()}/${$("#slug").value}/`;
    if(!$("#seo_title").dataset.touched)$("#seo_title").value=e.target.value.slice(0,70);
    updateUI();
  });
  $("#category_id")?.addEventListener("change",()=>{
    if(!canonicalTouched)$("#canonical_path").value=`/${categorySlug()}/${$("#slug").value}/`;
    updateUI();
  });
  $("#seo_title")?.addEventListener("input",e=>{e.target.dataset.touched="1"});
  form.addEventListener("input",updateUI);

  const modal=$("#preview-modal"),previewContent=$("#preview-content");
  $("#top-preview")?.addEventListener("click",()=>{
    const c=updateUI();
    previewContent.innerHTML=`<div class="breadcrumb">Preview / ${esc(categorySlug())}</div><span class="badge">${esc(form.content_type.value)}</span><h1>${esc(c.title||"Untitled")}</h1>${form.excerpt.value?`<p class="lead">${esc(form.excerpt.value)}</p>`:""}${md(c.body)}`;
    modal.hidden=false;
  });
  modal?.querySelectorAll("[data-close-preview]").forEach(el=>el.addEventListener("click",()=>modal.hidden=true));
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&modal&&!modal.hidden)modal.hidden=true});

  $("#validate-fields")?.addEventListener("click",()=>{
    const c=updateUI();
    const suggestions=Object.entries(c.result).filter(([,ok])=>!ok).map(([k])=>k);
    message.textContent=suggestions.length
      ? `Yayınlamaya engel yok. İstersen şu alanları iyileştirebilirsin: ${suggestions.join(", ")}.`
      : `İçerik kontrolleri tamam. Skor ${c.score}/100.`;
    message.className="cms-message success";
  });
  $("#run-checks")?.addEventListener("click",()=>$("#validate-fields")?.click());

  $("#clear-form")?.addEventListener("click",()=>{
    if(confirm("Form temizlensin mi?")){
      form.reset();slugTouched=false;canonicalTouched=false;originalStatus="draft";originalPublishedAt=null;
      history.replaceState(null,"",ADMIN_BASE+"/quick-entry");$("#save-draft").textContent="Save Draft";updateUI();
    }
  });

  let id=new URLSearchParams(location.search).get("id");
  if(id){
    const rows=await api(`/rest/v1/articles?id=eq.${encodeURIComponent(id)}&site_id=eq.${s.id}&select=*`);
    if(!rows.length)throw new Error("Article not found");
    const a=rows[0];
    originalStatus=a.status||"draft";
    originalPublishedAt=a.published_at||null;
    if($("#scheduled_at_local")&&a.scheduled_at)$("#scheduled_at_local").value=siteLocalValue(a.scheduled_at);

    ["title","slug","category_id","content_type","primary_keyword","search_intent","seo_title","canonical_path","excerpt","meta_description","content_markdown","featured_image_url","featured_image_prompt","featured_image_alt"].forEach(n=>{
      const f=form.elements.namedItem(n);if(f)f.value=a[n]??"";
    });

    const [sources,links]=await Promise.all([
      api(`/rest/v1/article_sources?article_id=eq.${id}&select=label,url,source_type&order=sort_order`),
      api(`/rest/v1/internal_links?source_article_id=eq.${id}&select=anchor_text,target_path`)
    ]);
    form.sources_text.value=sources.map(x=>`${x.label} | ${x.url||""} | ${x.source_type}`).join("\n");
    form.internal_links_text.value=links.map(x=>`${x.anchor_text} | ${x.target_path||""}`).join("\n");

    $("#editor-heading").textContent="İçeriği düzenle";
    if(originalStatus==="published")$("#save-draft").textContent="Save Changes";
    slugTouched=true;canonicalTouched=true;
  }
  updateUI();


  // -------- Media / featured image --------
  const featuredUrl=$("#featured_image_url");
  const featuredPreview=$("#featured-image-preview");
  const featuredStage=$("#featured-image-stage");
  const featuredEmpty=$("#featured-image-empty");
  const featuredStatus=$("#featured-image-status");
  const articleImageStatus=$("#article-image-status");
  const mediaPicker=$("#media-picker-modal");
  let pickerMode="featured";
  let mediaCache=[];

  const syncFeaturedPreview=()=>{
    const url=featuredUrl?.value?.trim();
    if(url){
      featuredPreview.src=url;
      featuredPreview.alt=form.featured_image_alt.value||form.title.value||"";
      featuredPreview.hidden=false;
      featuredEmpty.hidden=true;
      featuredStage.classList.remove("is-empty");
    }else{
      featuredPreview.removeAttribute("src");
      featuredPreview.hidden=true;
      featuredEmpty.hidden=false;
      featuredStage.classList.add("is-empty");
    }
  };
  syncFeaturedPreview();

  async function loadPicker(){
    const grid=$("#media-picker-grid");
    grid.innerHTML='<div class="empty-state">Media yükleniyor…</div>';
    const data=await adminJson("/api/media/list");
    mediaCache=data||[];
    grid.innerHTML=mediaCache.length?mediaCache.map(m=>mediaCardHtml(m,{pick:true})).join(""):'<div class="empty-state">Media Library henüz boş.</div>';
  }
  async function openPicker(mode){
    pickerMode=mode;
    mediaPicker.hidden=false;
    await loadPicker().catch(err=>{$("#media-picker-grid").innerHTML=`<div class="cms-message error">${esc(err.message)}</div>`});
  }
  mediaPicker?.querySelectorAll("[data-close-media-picker]").forEach(el=>el.addEventListener("click",()=>mediaPicker.hidden=true));
  $("#choose-featured-image")?.addEventListener("click",()=>openPicker("featured"));
  $("#choose-article-image")?.addEventListener("click",()=>openPicker("article"));

  $("#media-picker-grid")?.addEventListener("click",e=>{
    const btn=e.target.closest("[data-pick-media]");if(!btn)return;
    const m=mediaCache.find(x=>x.id===btn.dataset.pickMedia);if(!m)return;
    if(pickerMode==="featured"){
      featuredUrl.value=m.public_url||"";
      if(!form.featured_image_alt.value)form.featured_image_alt.value=m.alt_text||"";
      syncFeaturedPreview();
    }else{
      const alt=m.alt_text||"Septic system image";
      const caption=m.caption?` "${m.caption.replace(/"/g,"'")}"`:"";
      insertAtCursor(form.content_markdown,`![${alt}](${m.public_url}${caption})`);
    }
    mediaPicker.hidden=true;
  });

  $("#upload-featured-image")?.addEventListener("click",async()=>{
    const file=$("#featured_image_file")?.files?.[0];
    const btn=$("#upload-featured-image");
    btn.disabled=true;featuredStatus.textContent="Sıkıştırılıyor ve WebP olarak yükleniyor…";featuredStatus.className="cms-message";
    try{
      const m=await uploadMediaFile(file,{alt:form.featured_image_alt.value.trim(),articleId:id});
      featuredUrl.value=m.public_url||"";
      syncFeaturedPreview();
      featuredStatus.textContent=`Yüklendi. ${mediaSavings(m)}`;
      featuredStatus.className="cms-message success";
    }catch(err){featuredStatus.textContent=err.message;featuredStatus.className="cms-message error"}
    finally{btn.disabled=false}
  });

  $("#remove-featured-image")?.addEventListener("click",()=>{
    featuredUrl.value="";syncFeaturedPreview();
    featuredStatus.textContent="Featured image bu içerikten kaldırıldı. Kaydettiğinde uygulanacak.";
    featuredStatus.className="cms-message";
  });

  $("#upload-article-image")?.addEventListener("click",async()=>{
    const file=$("#article_image_file")?.files?.[0],btn=$("#upload-article-image");
    btn.disabled=true;articleImageStatus.textContent="Sıkıştırılıyor ve içeriğe hazırlanıyor…";articleImageStatus.className="cms-message";
    try{
      const alt=$("#article_image_alt").value.trim()||"Septic system image";
      const caption=$("#article_image_caption").value.trim();
      const m=await uploadMediaFile(file,{alt,caption,articleId:id});
      const cap=caption?` "${caption.replace(/"/g,"'")}"`:"";
      insertAtCursor(form.content_markdown,`![${alt}](${m.public_url}${cap})`);
      articleImageStatus.textContent=`Görsel içeriğe eklendi. ${mediaSavings(m)}`;
      articleImageStatus.className="cms-message success";
      $("#article_image_file").value="";
    }catch(err){articleImageStatus.textContent=err.message;articleImageStatus.className="cms-message error"}
    finally{btn.disabled=false}
  });

  form.featured_image_alt?.addEventListener("input",()=>{if(featuredPreview&&!featuredPreview.hidden)featuredPreview.alt=form.featured_image_alt.value});

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const b=e.submitter;
    const action=b?.value||"draft";
    const ui=updateUI();

    // Drafts only need enough identity to save safely.
    if(ui.title.length<3){
      message.textContent="Taslak kaydetmek için en az bir başlık gerekli.";
      message.className="cms-message error";
      return;
    }
    if(!ui.slug){
      form.slug.value=slugify(ui.title);
      if(!canonicalTouched)form.canonical_path.value=`/${categorySlug()}/${form.slug.value}/`;
    }

    b.disabled=true;
    message.textContent=id?"Güncelleniyor…":"Kaydediliyor…";
    message.className="cms-message";

    try{
      const raw=Object.fromEntries(new FormData(form));
      const sources=raw.sources_text||"",links=raw.internal_links_text||"";
      const scheduleLocal=raw.scheduled_at_local||"";
      delete raw.sources_text;delete raw.internal_links_text;delete raw.scheduled_at_local;
      let scheduledAt=null;
      if(action==="schedule"){
        scheduledAt=siteLocalToIso(scheduleLocal);
        if(!scheduledAt)throw new Error("Planlı yayın için tarih ve saat seç.");
        if(new Date(scheduledAt).getTime()<=Date.now()+30000)throw new Error("Planlı yayın zamanı gelecekte olmalı.");
      }

      // Empty select/string fields should be null where relational/optional.
      const payload={...raw};
      if(!payload.category_id)payload.category_id=null;
      for(const key of ["primary_keyword","search_intent","excerpt","seo_title","meta_description","canonical_path","content_markdown","featured_image_prompt","featured_image_alt"]){
        if(payload[key]==="")payload[key]=null;
      }
      Object.assign(payload,{site_id:s.id,reviewer_required:false,updated_by:currentUser.id});

      if(id){
        await api(`/rest/v1/articles?id=eq.${id}&site_id=eq.${s.id}`,{method:"PATCH",body:JSON.stringify(payload)});
      }else{
        Object.assign(payload,{status:"draft",created_by:currentUser.id});
        const created=await api("/rest/v1/articles?select=id",{
          method:"POST",
          headers:{Prefer:"return=representation"},
          body:JSON.stringify(payload)
        });
        if(!created?.[0]?.id)throw new Error("Article created but no ID was returned.");
        id=created[0].id;
        history.replaceState(null,"",`${ADMIN_BASE}/quick-entry?id=${id}`);
      }

      await syncRelations(id,s.id,sources,links);

      if(action==="schedule"){
        const gateRows=await api(`/rest/v1/article_publish_gate?id=eq.${id}&select=can_publish,checks&limit=1`);
        const gate=gateRows?.[0];
        if(!gate?.can_publish){
          const failed=Object.entries(gate?.checks||{}).filter(([,ok])=>!ok).map(([key])=>key.replace(/^has_/,"").replaceAll("_"," "));
          throw new Error(`Schedule publish gate failed${failed.length?": "+failed.join(", "):""}.`);
        }
      }

      if(action==="publish"){
        const publishedAt=originalPublishedAt||new Date().toISOString();
        await api(`/rest/v1/articles?id=eq.${id}&site_id=eq.${s.id}`,{
          method:"PATCH",
          body:JSON.stringify({status:"published",published_at:publishedAt,scheduled_at:null,updated_by:currentUser.id})
        });
        originalStatus="published";originalPublishedAt=publishedAt;
        $("#save-draft").textContent="Save Changes";
        message.textContent="İçerik yayınlandı.";
      }else if(action==="schedule"){
        await api(`/rest/v1/articles?id=eq.${id}&site_id=eq.${s.id}`,{
          method:"PATCH",
          body:JSON.stringify({status:"scheduled",scheduled_at:scheduledAt,published_at:null,updated_by:currentUser.id})
        });
        originalStatus="scheduled";originalPublishedAt=null;
        message.textContent=`İçerik ${formatSiteDateTime(scheduledAt)} için planlandı.`;
      }else{
        message.textContent=originalStatus==="published"?"Yayınlanan içerikteki değişiklikler kaydedildi.":originalStatus==="scheduled"?"Planlanan içerikteki değişiklikler kaydedildi.":"Taslak kaydedildi.";
      }

      message.className="cms-message success";
      history.replaceState(null,"",`${ADMIN_BASE}/quick-entry?id=${id}`);
    }catch(err){
      message.textContent=`Kayıt başarısız: ${err.message}`;
      message.className="cms-message error";
    }finally{
      b.disabled=false;
    }
  });
}

function md(markdown=""){
  const inline=value=>{
    let x=esc(value);
    x=x.replace(/`([^`]+)`/g,"<code>$1</code>");
    x=x.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
    x=x.replace(/\*([^*]+)\*/g,"<em>$1</em>");
    x=x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g,'<a href="$2">$1</a>');
    return x;
  };

  const lines=String(markdown||"").replace(/\r/g,"").split("\n");
  const out=[];
  let list=null,items=[];

  const flush=()=>{
    if(!list)return;
    out.push(`<${list}>${items.map(i=>`<li>${inline(i)}</li>`).join("")}</${list}>`);
    list=null;items=[];
  };

  for(const raw of lines){
    const line=raw.trimEnd();
    if(!line.trim()){flush();continue}

    let m;
    if((m=line.match(/^###\s+(.+)/))){flush();out.push(`<h3>${inline(m[1])}</h3>`);continue}
    if((m=line.match(/^##\s+(.+)/))){flush();out.push(`<h2>${inline(m[1])}</h2>`);continue}
    if((m=line.match(/^#\s+(.+)/))){flush();out.push(`<h1>${inline(m[1])}</h1>`);continue}
    if((m=line.match(/^>\s?(.+)/))){flush();out.push(`<blockquote>${inline(m[1])}</blockquote>`);continue}
    if((m=line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/))){
      flush();
      out.push(`<figure class="article-content-figure"><img src="${esc(m[2])}" alt="${esc(m[1]||"")}" loading="lazy">${m[3]?`<figcaption>${esc(m[3])}</figcaption>`:""}</figure>`);
      continue;
    }
    if((m=line.match(/^[-*]\s+(.+)/))){
      if(list!=="ul"){flush();list="ul"}items.push(m[1]);continue
    }
    if((m=line.match(/^\d+\.\s+(.+)/))){
      if(list!=="ol"){flush();list="ol"}items.push(m[1]);continue
    }
    flush();
    out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}
async function publicArticle(){
  const main=$("main");
  if(!main||main.dataset.serverRendered==="1")return;

  const params=new URLSearchParams(location.search);
  const parts=location.pathname.split("/").filter(Boolean);
  const categorySlug=params.get("category")||(parts.length===2?parts[0]:null);
  const slug=params.get("slug")||(parts.length===2?parts[1]:null);

  // Only run on article-shaped URLs or article.html.
  const isArticleRoute=location.pathname.endsWith("/article.html")||(parts.length===2&&!location.pathname.startsWith(ADMIN_BASE+"/")&&!location.pathname.startsWith("/category/"));
  if(!isArticleRoute||!slug)return;

  try{
    const rows=await api(`/rest/v1/articles?slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=title,excerpt,content_markdown,published_at,seo_title,meta_description,canonical_path,featured_image_url,featured_image_alt,categories(name,slug)`,{auth:false});
    if(!rows.length){location.replace("/404.html");return}

    const a=rows.find(x=>!categorySlug||x.categories?.slug===categorySlug);
    if(!a){location.replace("/404.html");return}
    document.title=`${a.seo_title||a.title} | SepticBeacon`;
    $('meta[name="description"]')?.setAttribute("content",a.meta_description||a.excerpt||"");
    const canonical=$('link[rel="canonical"]');
    if(canonical)canonical.setAttribute("href",new URL(a.canonical_path||`/${a.categories?.slug||categorySlug||"guides"}/${slug}`,location.origin).href);

    main.innerHTML=`<section class="section article-page-live">
      <div class="wrap article-layout">
        <article class="article-body">
          <div class="breadcrumb"><a href="/">Home</a> / <a href="/category/${esc(a.categories?.slug||categorySlug||"guides")}">${esc(a.categories?.name||"Guides")}</a></div>
          <span class="badge">${esc(a.categories?.name||"Septic Guide")}</span>
          <h1>${esc(a.title)}</h1>
          ${a.excerpt?`<p class="lead">${esc(a.excerpt)}</p>`:""}
          <p class="subtle">Published ${a.published_at?new Date(a.published_at).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}):""}</p>
          ${a.featured_image_url?`<img class="live-featured-image" src="${esc(a.featured_image_url)}" alt="${esc(a.featured_image_alt||a.title)}">`:""}
          ${md(a.content_markdown)}
        </article>
      </div>
    </section>`;
  }catch(err){
    console.error("Article render failed",err);
    main.innerHTML=`<section class="section"><div class="wrap"><div class="no-results"><h1>Article could not be loaded</h1><p>${esc(err.message)}</p></div></div></section>`;
  }
}
async function publicCategory(){if(!location.pathname.startsWith("/category/"))return;const main=$("main");if(main?.dataset.serverRendered==="1")return;const slug=new URLSearchParams(location.search).get("slug")||location.pathname.split("/").filter(Boolean).pop();const cats=await api(`/rest/v1/categories?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,name,slug`,{auth:false});if(!cats.length){location.replace("/404.html");return}const c=cats[0],articles=await api(`/rest/v1/articles?category_id=eq.${c.id}&status=eq.published&select=title,slug,excerpt,content_type,published_at&order=published_at.desc`,{auth:false});document.title=`${c.name} Septic Guides | SepticBeacon`;$('main').innerHTML=`<section class="category-hero"><div class="wrap"><div class="breadcrumb"><a href="/">Home</a> / RV Systems / ${esc(c.name)}</div><div class="category-hero-card"><div><div class="kicker"><span class="dot"></span> ${esc(c.name)}</div><h1>${esc(c.name)} RV repair guides</h1><p>Practical troubleshooting and maintenance guidance.</p></div><div class="category-stats"><div class="category-stat"><b>${articles.length}</b><span>Published guides</span></div></div></div></div></section><section class="section"><div class="wrap"><div class="guide-grid">${articles.map(a=>`<a class="guide-card" href="/${c.slug}/${a.slug}"><div class="thumb"></div><div class="article-copy"><div class="meta"><span class="badge">${esc(a.content_type)}</span></div><h3>${esc(a.title)}</h3><p>${esc(a.excerpt||"Open this practical RV guide.")}</p></div></a>`).join("")||"<p>No published guides yet.</p>"}</div></div></section>`}


async function publicHome(){
  if(location.pathname!=="/" && !location.pathname.endsWith("/index.html"))return;

  // Cloudflare Worker already server-renders the homepage from Supabase.
  // Do not overwrite that HTML with the legacy client-side placeholders.
  const serverCategories=$("#live-home-categories");
  const serverArticles=$("#live-home-articles");
  const serverPopular=$("#live-home-popular");
  if(
    serverCategories?.querySelector(".topic-icon-image") ||
    serverCategories?.dataset.serverRendered==="1"
  ){
    return;
  }

  const [cats,articles]=await Promise.all([
    api("/rest/v1/categories?is_active=eq.true&select=id,name,slug,description&order=sort_order",{auth:false}),
    api("/rest/v1/articles?status=eq.published&select=id,title,slug,excerpt,content_type,published_at,categories(name,slug)&order=published_at.desc&limit=12",{auth:false})
  ]);
  const cg=$("#live-home-categories");
  if(cg)cg.innerHTML=cats.map(c=>`<a class="topic topic-vector" href="/category/${esc(c.slug)}"><div class="topic-copy"><h3>${esc(c.name)}</h3><p>${esc(c.description||"Septic maintenance and troubleshooting guides.")}</p></div><span class="topic-arrow" aria-hidden="true">→</span></a>`).join("")||'<p class="subtle">Henüz kategori yok.</p>';
  const ag=$("#live-home-articles");
  if(ag)ag.innerHTML=articles.slice(0,6).map(a=>`<a class="article-card" href="/${esc(a.categories?.slug||"guides")}/${esc(a.slug)}"><div class="thumb"></div><div class="article-copy"><div class="meta"><span class="badge">${esc(a.categories?.name||"Guide")}</span><span>${a.published_at?new Date(a.published_at).toLocaleDateString("en-US",{month:"short",year:"numeric"}):""}</span></div><h3>${esc(a.title)}</h3><p>${esc(a.excerpt||"Open this RV guide.")}</p></div></a>`).join("")||'<p class="subtle">Henüz yayınlanmış içerik yok.</p>';
  const pg=$("#live-home-popular");
  if(pg)pg.innerHTML=articles.slice(0,4).map((a,i)=>`<a class="check" href="/${esc(a.categories?.slug||"guides")}/${esc(a.slug)}"><i>${i+1}</i><span>${esc(a.title)}</span></a>`).join("")||'<span class="subtle">Henüz yayınlanmış içerik yok.</span>';
}
async function publicSearch(){
  const mount=$("#live-search-results");if(!mount)return;
  const input=$("#site-search-input"),button=$("#site-search-button");
  const run=async()=>{
    const q=(input.value||"").trim();
    if(!q){mount.innerHTML='<div class="no-results"><p>Aramak için bir kelime yaz.</p></div>';return}
    history.replaceState(null,"",`/search.html?q=${encodeURIComponent(q)}`);
    const safe=q.replace(/[,*()]/g," ");
    const rows=await api(`/rest/v1/articles?status=eq.published&or=(title.ilike.*${encodeURIComponent(safe)}*,primary_keyword.ilike.*${encodeURIComponent(safe)}*,excerpt.ilike.*${encodeURIComponent(safe)}*)&select=title,slug,excerpt,content_type,featured_image_url,featured_image_alt,categories(name,slug)&limit=30`,{auth:false});
    mount.innerHTML=`<div class="search-results-head"><div><div class="kicker" style="color:var(--pine)">Search results</div><h2>Results for “${esc(q)}”</h2></div><p class="subtle">${rows.length} result</p></div>`+(rows.map(a=>`<a class="result-card" href="/${esc(a.categories?.slug||"guides")}/${esc(a.slug)}">${a.featured_image_url?`<div class="result-media"><img src="${esc(a.featured_image_url)}" alt="${esc(a.featured_image_alt||"")}" loading="lazy"></div>`:`<div class="result-media is-empty"></div>`}<div class="result-copy"><div class="meta"><span class="badge">${esc(a.categories?.name||"Guide")}</span><span>${esc(a.content_type)}</span></div><h3>${esc(a.title)}</h3><p>${esc(a.excerpt||"Open this RV guide.")}</p></div></a>`).join("")||'<div class="no-results"><p>No matching published content.</p></div>');
  };
  button?.addEventListener("click",run);input?.addEventListener("keydown",e=>{if(e.key==="Enter")run()});
  const q=new URLSearchParams(location.search).get("q");if(q){input.value=q;run()}
}
function emptyCard(text){return `<div class="admin-card"><p class="subtle">${esc(text)}</p></div>`}
async function loadAdminView(){
  const mount=$("#admin-live-view"),view=document.body.dataset.adminView;
  if(!mount||!view||!(await authReady))return;
  const s=await site();
  const refresh=()=>loadAdminView().catch(console.error);
  $("#refresh-view")?.addEventListener("click",refresh,{once:true});
  if(view==="dashboard"){
    const rows=await api(`/rest/v1/articles?site_id=eq.${s.id}&select=id,title,status,updated_at,published_at,categories(name,slug)&order=updated_at.desc`);
    const counts=rows.reduce((a,x)=>{a.total++;a[x.status]=(a[x.status]||0)+1;return a},{total:0});
    mount.innerHTML=`<div class="kpis"><div class="kpi"><span>TOPLAM İÇERİK</span><b>${counts.total}</b></div><div class="kpi"><span>YAYINDA</span><b>${counts.published||0}</b></div><div class="kpi"><span>TASLAK</span><b>${counts.draft||0}</b></div><div class="kpi"><span>ARŞİV</span><b>${counts.archived||0}</b></div></div><div class="table-card"><h3 style="margin-top:0">Son içerikler</h3><table><thead><tr><th>İçerik</th><th>Durum</th><th>Güncelleme</th></tr></thead><tbody>${rows.slice(0,8).map(a=>`<tr><td><a href="${ADMIN_BASE}/quick-entry?id=${a.id}"><b>${esc(a.title)}</b></a></td><td>${statusLabel(a.status)}</td><td>${new Date(a.updated_at).toLocaleString()}</td></tr>`).join("")||'<tr><td colspan="3">Henüz içerik yok.</td></tr>'}</tbody></table></div>`;
  } else if(view==="topic-map"){
    const rows=await api(`/rest/v1/topic_keywords?site_id=eq.${s.id}&select=keyword,intent,cluster_name,priority,status,search_volume&order=priority.asc`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Keyword</th><th>Intent</th><th>Cluster</th><th>Priority</th><th>Status</th><th>Volume</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.keyword)}</td><td>${esc(x.intent||"—")}</td><td>${esc(x.cluster_name||"—")}</td><td>P${x.priority}</td><td>${esc(x.status)}</td><td>${x.search_volume??"—"}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Topic Map henüz boş.");
  } else if(view==="calendar"){
    const rows=await api(`/rest/v1/content_calendar?site_id=eq.${s.id}&select=event_type,scheduled_for,completed_at,notes,articles(title)&order=scheduled_for.asc`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Tarih</th><th>İçerik</th><th>Tür</th><th>Durum</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${new Date(x.scheduled_for).toLocaleString()}</td><td>${esc(x.articles?.title||x.notes||"—")}</td><td>${esc(x.event_type)}</td><td>${x.completed_at?"Tamamlandı":"Planlandı"}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Takvimde henüz kayıt yok.");
  } else if(view==="refresh"||view==="opportunities"){
    const rows=await api(`/rest/v1/seo_opportunities?site_id=eq.${s.id}&select=type,title,rationale,priority,status,score,detected_at,articles(title)&order=priority.asc,detected_at.desc`);
    const filtered=view==="refresh"?rows.filter(x=>["content_decay","ctr"].includes(x.type)):rows;
    mount.innerHTML=filtered.length?`<div class="table-card"><table><thead><tr><th>Fırsat</th><th>İçerik</th><th>Tür</th><th>Priority</th><th>Status</th></tr></thead><tbody>${filtered.map(x=>`<tr><td><b>${esc(x.title)}</b><br><span class="subtle">${esc(x.rationale||"")}</span></td><td>${esc(x.articles?.title||"—")}</td><td>${esc(x.type)}</td><td>P${x.priority}</td><td>${esc(x.status)}</td></tr>`).join("")}</tbody></table></div>`:emptyCard(view==="refresh"?"Refresh Queue boş.":"Henüz SEO opportunity yok.");
  } else if(view==="seo"){
    const articles=await api(`/rest/v1/articles?site_id=eq.${s.id}&select=id,status,seo_title,meta_description,canonical_path`);
    const published=articles.filter(x=>x.status==="published"),issues=published.filter(x=>!x.seo_title||!x.meta_description||!x.canonical_path).length;
    const gsc=await api(`/rest/v1/gsc_daily?site_id=eq.${s.id}&select=clicks,impressions,ctr,position&limit=5000`);
    const clicks=Math.round(gsc.reduce((a,x)=>a+Number(x.clicks||0),0)),impr=Math.round(gsc.reduce((a,x)=>a+Number(x.impressions||0),0));
    mount.innerHTML=`<div class="kpis"><div class="kpi"><span>YAYINDA</span><b>${published.length}</b></div><div class="kpi"><span>SEO EKSİĞİ</span><b>${issues}</b></div><div class="kpi"><span>GSC CLICKS</span><b>${clicks}</b></div><div class="kpi"><span>GSC IMPRESSIONS</span><b>${impr}</b></div></div>${gsc.length?"":emptyCard("GSC verisi henüz senkronlanmamış.")}`;
  } else if(view==="gsc"){
    const rows=await api(`/rest/v1/gsc_daily?site_id=eq.${s.id}&select=date,page,query,clicks,impressions,ctr,position&order=date.desc&limit=200`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Tarih</th><th>Query</th><th>Page</th><th>Clicks</th><th>Impr.</th><th>Pos.</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.date}</td><td>${esc(x.query||"—")}</td><td>${esc(x.page||"—")}</td><td>${x.clicks}</td><td>${x.impressions}</td><td>${Number(x.position||0).toFixed(1)}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Search Console henüz bağlı/senkronize değil. Dummy veri gösterilmiyor.");
  } else if(view==="internal-links"){
    const rows=await api(`/rest/v1/internal_links?site_id=eq.${s.id}&select=anchor_text,target_path,is_live,articles!internal_links_source_article_id_fkey(title)&order=created_at.desc&limit=200`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Source</th><th>Anchor</th><th>Target</th><th>Live</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.articles?.title||"—")}</td><td>${esc(x.anchor_text)}</td><td>${esc(x.target_path||"—")}</td><td>${x.is_live?"Yes":"No"}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Henüz internal link kaydı yok.");
  } else if(view==="crawl"){
    const rows=await api(`/rest/v1/crawl_runs?site_id=eq.${s.id}&select=id,status,started_at,finished_at,discovered_count,indexable_count,issue_count,created_at&order=created_at.desc&limit=50`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Run</th><th>Status</th><th>Discovered</th><th>Indexable</th><th>Issues</th><th>Date</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.id.slice(0,8)}</td><td>${esc(x.status)}</td><td>${x.discovered_count}</td><td>${x.indexable_count}</td><td>${x.issue_count}</td><td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Henüz crawl çalıştırılmamış.");
  } else if(view==="site-health"){
    const rows=await api(`/rest/v1/articles?site_id=eq.${s.id}&status=eq.published&select=id,title,seo_title,meta_description,canonical_path,content_markdown`);
    const problems=rows.map(x=>({title:x.title,meta:!x.seo_title||!x.meta_description,canonical:!x.canonical_path,body:(x.content_markdown||"").length<800})).filter(x=>x.meta||x.canonical||x.body);
    mount.innerHTML=`<div class="kpis"><div class="kpi"><span>PUBLISHED</span><b>${rows.length}</b></div><div class="kpi"><span>ISSUES</span><b>${problems.length}</b></div></div>${problems.length?`<div class="table-card"><table><thead><tr><th>Article</th><th>Metadata</th><th>Canonical</th><th>Body</th></tr></thead><tbody>${problems.map(x=>`<tr><td>${esc(x.title)}</td><td>${x.meta?"Eksik":"OK"}</td><td>${x.canonical?"Eksik":"OK"}</td><td>${x.body?"Kısa":"OK"}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Yayınlanmış içeriklerde temel CMS kontrolü temiz.")}`;
  } else if(view==="redirects"){
    const rows=await api(`/rest/v1/redirects?site_id=eq.${s.id}&select=id,source_path,destination_path,status_code,is_active,hit_count,created_at&order=created_at.desc`);
    mount.innerHTML=`
      <div class="admin-card" style="margin-bottom:14px">
        <div class="admin-grid">
          <div class="field"><label>Source path</label><input id="redirect-source" placeholder="/old-url"></div>
          <div class="field"><label>Destination</label><input id="redirect-destination" placeholder="/new-url"></div>
          <div class="field"><label>Status</label><select id="redirect-code"><option>301</option><option>302</option><option>307</option><option>308</option></select></div>
          <div class="field" style="align-self:end"><button class="btn primary" id="save-redirect" type="button">Add redirect</button></div>
        </div>
        <div id="redirect-message" class="cms-message"></div>
      </div>
      ${rows.length?`<div class="table-card"><table><thead><tr><th>Source</th><th>Destination</th><th>Code</th><th>Hits</th><th>Active</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.source_path)}</td><td>${esc(x.destination_path)}</td><td>${x.status_code}</td><td>${x.hit_count}</td><td>${x.is_active?"Yes":"No"}</td><td><button class="btn" data-delete-redirect="${x.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`:emptyCard("Henüz redirect kaydı yok.")}`;

    $("#save-redirect")?.addEventListener("click",async()=>{
      const msg=$("#redirect-message");
      let source=$("#redirect-source").value.trim(),dest=$("#redirect-destination").value.trim();
      const code=Number($("#redirect-code").value||301);
      if(!source.startsWith("/"))source=`/${source}`;
      if(!dest.startsWith("/")&&!/^https?:\/\//i.test(dest)){msg.textContent="Destination / ile başlamalı veya tam URL olmalı.";msg.className="cms-message error";return}
      if(source===dest){msg.textContent="Source ve destination aynı olamaz.";msg.className="cms-message error";return}
      try{
        await api("/rest/v1/redirects",{method:"POST",body:JSON.stringify({site_id:s.id,source_path:source,destination_path:dest,status_code:code,is_active:true})});
        msg.textContent="Redirect kaydedildi.";msg.className="cms-message success";setTimeout(()=>loadAdminView(),300);
      }catch(err){msg.textContent=err.message;msg.className="cms-message error"}
    });

    mount.addEventListener("click",async e=>{
      const btn=e.target.closest("[data-delete-redirect]");if(!btn)return;
      if(!confirm("Redirect silinsin mi?"))return;
      try{await api(`/rest/v1/redirects?id=eq.${btn.dataset.deleteRedirect}`,{method:"DELETE"});loadAdminView()}
      catch(err){alert(err.message)}
    });
  } else if(view==="alerts"){
    const rows=await api(`/rest/v1/alerts?site_id=eq.${s.id}&select=severity,title,message,status,created_at&order=created_at.desc&limit=100`);
    mount.innerHTML=rows.length?rows.map(x=>`<div class="alert-card ${esc(x.severity)}"><h3>${esc(x.title)}</h3><p>${esc(x.message||"")}</p><span class="subtle">${esc(x.status)} · ${new Date(x.created_at).toLocaleString()}</span></div>`).join(""):emptyCard("Açık alert yok.");
  } else if(view==="jobs"){
    const rows=await api(`/rest/v1/jobs?site_id=eq.${s.id}&select=job_type,status,priority,error,created_at,finished_at&order=created_at.desc&limit=100`);
    mount.innerHTML=rows.length?`<div class="table-card"><table><thead><tr><th>Job</th><th>Status</th><th>Priority</th><th>Error</th><th>Date</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.job_type)}</td><td>${esc(x.status)}</td><td>P${x.priority}</td><td>${esc(x.error||"—")}</td><td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>`:emptyCard("Job queue boş.");
  } else if(view==="analytics"){
    const [ga4,gsc]=await Promise.all([api(`/rest/v1/ga4_daily?site_id=eq.${s.id}&select=sessions,active_users,engaged_sessions,views&limit=5000`),api(`/rest/v1/gsc_daily?site_id=eq.${s.id}&select=clicks,impressions&limit=5000`)]);
    const sum=(arr,k)=>Math.round(arr.reduce((a,x)=>a+Number(x[k]||0),0));
    mount.innerHTML=`<div class="kpis"><div class="kpi"><span>GA4 SESSIONS</span><b>${sum(ga4,"sessions")}</b></div><div class="kpi"><span>ACTIVE USERS</span><b>${sum(ga4,"active_users")}</b></div><div class="kpi"><span>GSC CLICKS</span><b>${sum(gsc,"clicks")}</b></div><div class="kpi"><span>GSC IMPRESSIONS</span><b>${sum(gsc,"impressions")}</b></div></div>${(!ga4.length&&!gsc.length)?emptyCard("GA4/GSC henüz senkronlanmamış. Dummy rakam gösterilmiyor."):""}`;
  } else if(view==="integrations"){
    const rows=await api(`/rest/v1/integrations?site_id=eq.${s.id}&select=provider,status,external_property_id,last_sync_at,last_error&order=provider`);
    mount.innerHTML=rows.length?`<div class="integration-grid">${rows.map(x=>`<div class="integration-card">
      <div class="integration-head"><div><h3>${esc(x.provider)}</h3><p class="subtle">${esc(x.external_property_id||"Property tanımlı değil")}</p></div><span class="connection ${x.status==="connected"?"":"off"}">${esc(x.status)}</span></div>
      <p class="subtle">Last sync: ${x.last_sync_at?new Date(x.last_sync_at).toLocaleString():"—"}</p>
      ${x.last_error?`<p class="cms-message error">${esc(x.last_error)}</p>`:""}
      ${x.provider==="gsc"?'<a class="btn" href="${ADMIN_BASE}/gsc">Manage Search Console</a>':""}
    </div>`).join("")}</div>`:emptyCard("Henüz integration kaydı yok. Search Console bağlantısını SEO & Growth bölümünden başlatabilirsin.");
  }
}



async function initMediaLibrary(){
  if(document.body.dataset.adminView!=="media"||!(await authReady))return;
  const grid=$("#admin-media-grid"),count=$("#media-library-count"),status=$("#media-library-upload-status");

  async function load(){
    grid.innerHTML='<div class="empty-state">Media yükleniyor…</div>';
    try{
      const rows=await adminJson("/api/media/list");
      count.textContent=`${rows.length} media item`;
      grid.innerHTML=rows.length?rows.map(m=>mediaCardHtml(m)).join(""):'<div class="empty-state">Media Library henüz boş.</div>';
      grid._rows=rows;
    }catch(err){grid.innerHTML=`<div class="cms-message error">${esc(err.message)}</div>`}
  }

  async function upload(){
    const file=$("#media-library-file")?.files?.[0],btn=$("#media-library-upload");
    btn.disabled=true;status.textContent="Sıkıştırılıyor ve WebP olarak yükleniyor…";status.className="cms-message";
    try{
      const m=await uploadMediaFile(file,{alt:$("#media-library-alt").value.trim(),caption:$("#media-library-caption").value.trim()});
      status.textContent=`Yüklendi. ${mediaSavings(m)}`;
      status.className="cms-message success";
      $("#media-library-file").value="";$("#media-library-alt").value="";$("#media-library-caption").value="";
      await load();
    }catch(err){status.textContent=err.message;status.className="cms-message error"}
    finally{btn.disabled=false}
  }

  $("#media-library-upload")?.addEventListener("click",upload);
  $("#media-library-refresh")?.addEventListener("click",load);

  const dz=$("#media-dropzone");
  ["dragenter","dragover"].forEach(ev=>dz?.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("is-dragging")}));
  ["dragleave","drop"].forEach(ev=>dz?.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("is-dragging")}));
  dz?.addEventListener("drop",e=>{
    const f=e.dataTransfer?.files?.[0];
    if(f){
      const dt=new DataTransfer();dt.items.add(f);$("#media-library-file").files=dt.files;
    }
  });

  grid?.addEventListener("click",async e=>{
    const rows=grid._rows||[];
    const copy=e.target.closest("[data-copy-media]");
    if(copy){await navigator.clipboard.writeText(copy.dataset.copyMedia);copy.textContent="Copied";setTimeout(()=>copy.textContent="Copy URL",900);return}
    const md=e.target.closest("[data-copy-md]");
    if(md){
      const m=rows.find(x=>x.id===md.dataset.copyMd);if(!m)return;
      const cap=m.caption?` "${String(m.caption).replace(/"/g,"'")}"`:"";
      await navigator.clipboard.writeText(`![${m.alt_text||"Septic system image"}](${m.public_url}${cap})`);
      md.textContent="Copied";setTimeout(()=>md.textContent="Markdown",900);return;
    }
    const edit=e.target.closest("[data-edit-media]");
    if(edit){
      const m=rows.find(x=>x.id===edit.dataset.editMedia);if(!m)return;
      const alt=prompt("Alt text",m.alt_text||"");if(alt===null)return;
      const caption=prompt("Caption",m.caption||"");if(caption===null)return;
      try{await adminJson(`/api/media/meta?id=${encodeURIComponent(m.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({alt_text:alt,caption})});await load()}
      catch(err){alert(err.message)}
      return;
    }
    const del=e.target.closest("[data-delete-media]");
    if(del){
      const m=rows.find(x=>x.id===del.dataset.deleteMedia);if(!m)return;
      if(!confirm("Bu görsel R2 ve Media Library’den silinsin mi? İçerik içinde kullanılıyorsa kırık görsel oluşabilir."))return;
      try{await adminJson(`/api/media/delete?id=${encodeURIComponent(m.id)}`,{method:"DELETE"});await load()}
      catch(err){alert(err.message)}
    }
  });

  load();
}

async function gscSetup(){
  const mount=$("#gsc-setup-app");
  if(!mount||document.body.dataset.adminView!=="gsc-setup"||!(await authReady))return;

  const s=await site();
  let v={},integration={status:"disconnected"},loadError="";

  try{
    const [verRows,intRows]=await Promise.all([
      api(`/rest/v1/site_verification?site_id=eq.${s.id}&provider=eq.gsc&select=*`),
      api(`/rest/v1/integrations?site_id=eq.${s.id}&provider=eq.gsc&select=*`)
    ]);
    v=verRows?.[0]||{};
    integration=intRows?.[0]||{status:"disconnected"};
  }catch(err){
    loadError=err.message;
  }

  const justConnected=new URLSearchParams(location.search).get("connected")==="1";
  const connected=integration.status==="connected";
  const propertySelected=!!integration.external_property_id;
  const verificationMethod=v.verification_method||"meta";
  const hasVerification=
    (verificationMethod==="meta"&&!!v.meta_token)||
    (verificationMethod==="html_file"&&!!v.html_filename&&!!v.html_content)||
    (verificationMethod==="dns"&&!!v.dns_record_value);

  mount.innerHTML=`
    ${justConnected?'<div class="cms-message success" style="margin-bottom:14px">Google hesabı bağlandı. Şimdi Search Console property seçimini tamamlayabilirsin.</div>':""}
    ${loadError?`<div class="cms-message error" style="margin-bottom:14px">Panel verisi yüklenirken hata: ${esc(loadError)}</div>`:""}

    <div class="admin-card" style="margin-bottom:14px;padding:20px">
      <div class="integration-head">
        <div>
          <div class="subtle">Google Search Console Setup</div>
          <h2 style="margin:4px 0 6px">Search Console bağlantısını tamamla</h2>
          <p class="subtle" style="margin:0">4 kısa adım. Teknik alanları yalnızca gerektiğinde görürsün.</p>
        </div>
        <span class="connection ${connected&&propertySelected?"":"off"}">${connected&&propertySelected?"Connected":"Setup required"}</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px">
        ${[
          ["1","Google account",connected],
          ["2","Property",propertySelected],
          ["3","Verification",hasVerification],
          ["4","Data sync",!!integration.last_sync_at]
        ].map(([no,label,ok])=>`<div class="preview-box" style="padding:12px"><div class="${ok?"gate-ok":"subtle"}" style="font-weight:700">${ok?"✓":no}</div><b>${label}</b></div>`).join("")}
      </div>
    </div>

    <div class="integration-grid">
      <div class="integration-card">
        <div class="integration-head">
          <div>
            <div class="subtle">STEP 1</div>
            <h3 style="margin:2px 0 4px">Connect Google account</h3>
            <p class="subtle">Search Console hesabını güvenli OAuth bağlantısıyla bağla.</p>
          </div>
          <span class="connection ${connected?"":"off"}">${connected?"Connected":"Not connected"}</span>
        </div>
        <button type="button" class="btn primary" id="gsc-connect">${connected?"Reconnect Google":"Connect Google Search Console"}</button>
        <div id="gsc-connect-message" class="cms-message"></div>
      </div>

      <div class="integration-card">
        <div class="subtle">STEP 2</div>
        <h3 style="margin:2px 0 4px">Choose property</h3>
        <p class="subtle">Bağlı Google hesabındaki property'lerden SepticBeacon olanı seç.</p>
        <div class="field" style="margin-top:12px">
          <label>Search Console property</label>
          <select id="gsc-property-select">
            <option value="">Load properties…</option>
          </select>
        </div>
        <div class="mini-actions" style="margin-top:12px">
          <button type="button" class="btn" id="gsc-load-properties">Load properties</button>
          <button type="button" class="btn primary" id="gsc-save-property">Save property</button>
        </div>
        <div id="gsc-property-message" class="cms-message"></div>
        <div class="side-list" style="margin-top:12px">
          <div><span>Selected</span><b id="selected-property">${esc(integration.external_property_id||"Not selected")}</b></div>
        </div>
      </div>
    </div>

    <div class="admin-card" style="margin-top:14px;padding:20px">
      <div class="integration-head">
        <div>
          <div class="subtle">STEP 3</div>
          <h3 style="margin:2px 0 4px">Verify site ownership</h3>
          <p class="subtle">En kolay yöntem genellikle HTML meta tag. Domain property kullanıyorsan DNS TXT seç.</p>
        </div>
        <span class="connection ${hasVerification?"":"off"}">${hasVerification?"Saved":"Not configured"}</span>
      </div>

      <div class="mini-actions" style="margin:14px 0">
        <button type="button" class="btn ${verificationMethod==="meta"?"primary":""}" data-gsc-method="meta">HTML Meta Tag</button>
        <button type="button" class="btn ${verificationMethod==="html_file"?"primary":""}" data-gsc-method="html_file">HTML File</button>
        <button type="button" class="btn ${verificationMethod==="dns"?"primary":""}" data-gsc-method="dns">DNS TXT</button>
      </div>

      <div id="gsc-method-meta" ${verificationMethod==="meta"?"":"hidden"}>
        <div class="field">
          <label>Google verification tag veya token</label>
          <textarea id="gsc-meta-token" rows="3" placeholder='<meta name="google-site-verification" content="ABC123...">'>${esc(v.meta_token||"")}</textarea>
          <div class="helper">Google'ın verdiği tam meta etiketi veya sadece content değerini yapıştırabilirsin. Sistem tokenı otomatik ayıklar.</div>
        </div>
        <button class="btn primary" type="button" id="gsc-save-meta" style="margin-top:10px">Save verification</button>
        <div id="gsc-meta-msg" class="cms-message"></div>
      </div>

      <div id="gsc-method-html_file" ${verificationMethod==="html_file"?"":"hidden"}>
        <div class="quick-grid">
          <div class="quick-field">
            <label>Filename</label>
            <input id="gsc-html-filename" value="${esc(v.html_filename||"")}" placeholder="google1234567890abcdef.html">
          </div>
          <div class="quick-field">
            <label>Exact file content</label>
            <textarea id="gsc-html-content" rows="3" placeholder="google-site-verification: google123....html">${esc(v.html_content||"")}</textarea>
          </div>
        </div>
        <button class="btn primary" type="button" id="gsc-save-file" style="margin-top:10px">Save HTML file</button>
        <div id="gsc-file-msg" class="cms-message"></div>
      </div>

      <div id="gsc-method-dns" ${verificationMethod==="dns"?"":"hidden"}>
        <div class="quick-grid">
          <div class="quick-field">
            <label>DNS host</label>
            <input id="gsc-dns-name" value="${esc(v.dns_record_name||"@")}" placeholder="@">
          </div>
          <div class="quick-field">
            <label>TXT value</label>
            <textarea id="gsc-dns-value" rows="3" placeholder="google-site-verification=...">${esc(v.dns_record_value||"")}</textarea>
          </div>
        </div>
        <div class="helper">Bu değer burada referans olarak tutulur. TXT kaydını Cloudflare DNS'e ayrıca eklemen gerekir.</div>
        <button class="btn primary" type="button" id="gsc-save-dns" style="margin-top:10px">Save DNS verification</button>
        <div id="gsc-dns-msg" class="cms-message"></div>
      </div>
    </div>

    <div class="integration-grid" style="margin-top:14px">
      <div class="integration-card">
        <div class="subtle">STEP 4</div>
        <h3 style="margin:2px 0 4px">Sync Search Console data</h3>
        <p class="subtle">Property seçildikten sonra GSC verilerini SepticBeacon paneline aktar.</p>
        <div class="side-list">
          <div><span>Last sync</span><b>${integration.last_sync_at?new Date(integration.last_sync_at).toLocaleString():"Never"}</b></div>
          <div><span>Status</span><b>${esc(integration.status||"disconnected")}</b></div>
        </div>
        ${integration.last_error?`<div class="cms-message error">${esc(integration.last_error)}</div>`:""}
        <button type="button" class="btn primary" id="gsc-sync" style="margin-top:12px">Sync GSC Data</button>
      </div>

      <div class="integration-card">
        <h3 style="margin-top:0">System check</h3>
        <p class="subtle">Bağlantıda problem varsa önce buradan environment kontrolü yap.</p>
        <button type="button" class="btn" id="gsc-test-config">Test configuration</button>
        <div id="gsc-diagnostics" class="side-list" style="margin-top:12px"><div><span>Status</span><b>Not tested</b></div></div>
        <div id="gsc-diagnostic-message" class="cms-message"></div>
      </div>
    </div>

    <details class="admin-card" style="margin-top:14px;padding:18px">
      <summary style="cursor:pointer;font-weight:700">Advanced verification details</summary>
      <div class="side-list" style="margin-top:14px">
        <div><span>Method</span><b>${esc(v.verification_method||"Not set")}</b></div>
        <div><span>Meta token</span><b>${v.meta_token?"Saved":"—"}</b></div>
        <div><span>HTML file</span><b>${esc(v.html_filename||"—")}</b></div>
        <div><span>DNS host</span><b>${esc(v.dns_record_name||"—")}</b></div>
      </div>
    </details>
  `;

  const fetchWorkerJson=async(path,options={})=>{
    const r=await fetch(path,{
      ...options,
      headers:{...(options.headers||{}),Authorization:`Bearer ${token()}`}
    });
    const text=await r.text();
    let data={};
    try{data=text?JSON.parse(text):{}}catch{data={error:text||`HTTP ${r.status}`}}
    if(!r.ok)throw new Error(data.error||data.message||`HTTP ${r.status}`);
    return data;
  };

  const extractToken=raw=>{
    const value=String(raw||"").trim();
    const m=value.match(/<meta[^>]+name=["']google-site-verification["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || value.match(/content=["']([^"']+)["']/i);
    const tokenValue=(m?m[1]:value).trim();
    if(!tokenValue||/[<>\s]/.test(tokenValue))throw new Error("Google verification token geçerli görünmüyor.");
    if(tokenValue.length>500)throw new Error("Verification token çok uzun.");
    return tokenValue;
  };

  async function saveVerification(patch){
    await api("/rest/v1/site_verification?on_conflict=site_id,provider",{
      method:"POST",
      headers:{Prefer:"resolution=merge-duplicates"},
      body:JSON.stringify({site_id:s.id,provider:"gsc",enabled:true,...patch})
    });
  }

  document.querySelectorAll("[data-gsc-method]").forEach(btn=>btn.addEventListener("click",()=>{
    const method=btn.dataset.gscMethod;
    document.querySelectorAll("[data-gsc-method]").forEach(x=>x.classList.toggle("primary",x===btn));
    ["meta","html_file","dns"].forEach(x=>{
      const el=$("#gsc-method-"+x);
      if(el)el.hidden=x!==method;
    });
  }));

  $("#gsc-save-meta")?.addEventListener("click",async()=>{
    const msg=$("#gsc-meta-msg");
    try{
      const tokenValue=extractToken($("#gsc-meta-token").value);
      await saveVerification({
        verification_method:"meta",
        meta_token:tokenValue,
        html_filename:null,
        html_content:null,
        dns_record_name:null,
        dns_record_value:null
      });
      $("#gsc-meta-token").value=tokenValue;
      msg.textContent="Kaydedildi. Meta verification etiketi public sayfalara server-side eklenecek.";
      msg.className="cms-message success";
    }catch(err){msg.textContent=err.message;msg.className="cms-message error"}
  });

  $("#gsc-save-file")?.addEventListener("click",async()=>{
    const msg=$("#gsc-file-msg");
    try{
      const filename=$("#gsc-html-filename").value.trim();
      const fileContent=$("#gsc-html-content").value.trim();
      if(!/^google[a-zA-Z0-9_-]+\.html$/.test(filename))throw new Error("Google verification filename geçerli görünmüyor.");
      if(!fileContent)throw new Error("Dosya içeriği boş.");
      if(fileContent.length>2000)throw new Error("Dosya içeriği beklenenden uzun.");
      await saveVerification({
        verification_method:"html_file",
        meta_token:null,
        html_filename:filename,
        html_content:fileContent,
        dns_record_name:null,
        dns_record_value:null
      });
      msg.textContent=`Kaydedildi. Test URL: /${filename}`;
      msg.className="cms-message success";
    }catch(err){msg.textContent=err.message;msg.className="cms-message error"}
  });

  $("#gsc-save-dns")?.addEventListener("click",async()=>{
    const msg=$("#gsc-dns-msg");
    try{
      const name=$("#gsc-dns-name").value.trim()||"@";
      const value=$("#gsc-dns-value").value.trim();
      if(!/^google-site-verification=\S+$/.test(value))throw new Error("Google DNS TXT değeri geçerli görünmüyor.");
      await saveVerification({
        verification_method:"dns",
        meta_token:null,
        html_filename:null,
        html_content:null,
        dns_record_name:name,
        dns_record_value:value
      });
      msg.textContent="DNS doğrulama bilgisi kaydedildi. Şimdi aynı TXT kaydını Cloudflare DNS'e ekle.";
      msg.className="cms-message success";
    }catch(err){msg.textContent=err.message;msg.className="cms-message error"}
  });

  const testConfig=async()=>{
    const msg=$("#gsc-diagnostic-message"),list=$("#gsc-diagnostics");
    msg.textContent="Kontrol ediliyor…";msg.className="cms-message";
    try{
      const d=await fetchWorkerJson("/api/gsc/status");
      list.innerHTML=[
        ["Google client",d.google_client_id&&d.google_client_secret],
        ["Supabase",d.supabase_url&&d.supabase_server_key],
        ["Database access",d.database_access]
      ].map(([name,ok])=>`<div><span>${name}</span><b class="${ok?"gate-ok":"gate-warn"}">${ok?"OK":"Needs attention"}</b></div>`).join("");
      msg.textContent=d.ready?"Configuration hazır.":"Eksik veya hatalı environment ayarı var.";
      msg.className=`cms-message ${d.ready?"success":"error"}`;
      return !!d.ready;
    }catch(err){
      msg.textContent=`Configuration test failed: ${err.message}`;
      msg.className="cms-message error";
      return false;
    }
  };
  $("#gsc-test-config")?.addEventListener("click",testConfig);

  const loadProperties=async()=>{
    const select=$("#gsc-property-select"),msg=$("#gsc-property-message");
    msg.textContent="Property listesi alınıyor…";msg.className="cms-message";
    try{
      const d=await fetchWorkerJson("/api/gsc/properties");
      const rows=d.properties||[];
      select.innerHTML='<option value="">Select a property…</option>'+rows.map(x=>
        `<option value="${esc(x.siteUrl)}" ${x.siteUrl===d.current?"selected":""}>${esc(x.siteUrl)} — ${esc(x.permissionLevel||"")}</option>`
      ).join("");
      msg.textContent=`${rows.length} property bulundu.`;
      msg.className="cms-message success";
      return rows;
    }catch(err){
      select.innerHTML='<option value="">Could not load properties</option>';
      msg.textContent=err.message;msg.className="cms-message error";return [];
    }
  };
  $("#gsc-load-properties")?.addEventListener("click",loadProperties);

  $("#gsc-save-property")?.addEventListener("click",async()=>{
    const siteUrl=$("#gsc-property-select").value,msg=$("#gsc-property-message");
    if(!siteUrl){msg.textContent="Önce bir property seç.";msg.className="cms-message error";return}
    try{
      const d=await fetchWorkerJson("/api/gsc/property",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({siteUrl})
      });
      $("#selected-property").textContent=d.siteUrl;
      msg.textContent=`Property kaydedildi: ${d.siteUrl}`;
      msg.className="cms-message success";
    }catch(err){msg.textContent=err.message;msg.className="cms-message error"}
  });

  $("#gsc-connect")?.addEventListener("click",async e=>{
    const btn=e.currentTarget,msg=$("#gsc-connect-message");
    btn.disabled=true;msg.textContent="Bağlantı hazırlanıyor…";msg.className="cms-message";
    try{
      const ready=await testConfig();
      if(!ready)throw new Error("Önce configuration eksiklerini düzelt.");
      const d=await fetchWorkerJson("/api/gsc/connect",{method:"POST"});
      if(!d.url)throw new Error("Google OAuth URL dönmedi.");
      window.location.assign(d.url);
    }catch(err){
      msg.textContent=`Bağlantı başlatılamadı: ${err.message}`;
      msg.className="cms-message error";
      btn.disabled=false;
    }
  });

  const sync=async btn=>{
    btn.disabled=true;
    const old=btn.textContent;
    btn.textContent="Syncing…";
    try{
      const d=await fetchWorkerJson("/api/gsc/sync",{method:"POST"});
      alert(`GSC sync tamamlandı. ${d.rows} satır yazıldı.`);
      location.reload();
    }catch(err){
      alert(`GSC sync failed: ${err.message}`);
    }finally{
      btn.disabled=false;
      btn.textContent=old;
    }
  };
  $("#gsc-sync")?.addEventListener("click",e=>sync(e.currentTarget));
  $("#gsc-sync-top")?.addEventListener("click",e=>sync(e.currentTarget));

  if(connected)loadProperties();
}

loadArticles().catch(console.error);initEditor().catch(console.error);loadAdminView().catch(console.error);initMediaLibrary().catch(console.error);gscSetup().catch(console.error);publicHome().catch(console.error);publicSearch().catch(console.error);publicArticle().catch(console.error);publicCategory().catch(console.error);
