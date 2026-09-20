import { handleMcp, handleOAuth } from "./mcp.js";
import { generateArticleImage } from "./mcp-media.js";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const SB_PUBLIC_ANON_KEY="sb_publishable_AvR-71NF4xi_KdBZc-gSAg_mN8Cq8rl";
let SB_SITE_ID_CACHE=null;

async function sbSiteId(env){
  if(SB_SITE_ID_CACHE)return SB_SITE_ID_CACHE;
  if(!env.SUPABASE_URL)return null;
  const useService=!!env.SUPABASE_SERVICE_ROLE_KEY;
  const r=await fetch(`${env.SUPABASE_URL}/rest/v1/sites?domain=eq.septicbeacon.com&is_active=eq.true&select=id&limit=1`,{
    headers:supaHeaders(env,useService)
  });
  if(!r.ok)return null;
  const row=(await r.json())[0];
  SB_SITE_ID_CACHE=row?.id||null;
  return SB_SITE_ID_CACHE;
}

function supaHeaders(env, service=false, userToken=null){
  const key = service ? env.SUPABASE_SERVICE_ROLE_KEY : (env.SUPABASE_ANON_KEY||SB_PUBLIC_ANON_KEY);
  const h = {
    apikey: key,
    "Content-Type": "application/json"
  };

  // Legacy service_role keys are JWTs and can be used as Bearer tokens.
  // New Supabase sb_secret_* keys are API keys, not JWT bearer tokens.
  if(service && String(key||"").startsWith("eyJ")){
    h.Authorization=`Bearer ${key}`;
  }else if(!service && userToken){
    h.Authorization=userToken;
  }
  return h;
}


async function getIdentityItems(env){
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return [];
  try{
    const siteId=await sbSiteId(env);
    if(!siteId)return [];
    const r=await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_identity_items?site_id=eq.${siteId}&enabled=eq.true&select=id,provider,item_type,label,key_name,value,extra`,
      {headers:supaHeaders(env,true)}
    );
    if(!r.ok) return [];
    return await r.json();
  }catch{
    return [];
  }
}

async function getVerification(env){
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try{
    const siteId=await sbSiteId(env);
    if(!siteId)return null;
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_verification?site_id=eq.${siteId}&provider=eq.gsc&enabled=eq.true&select=verification_method,meta_token,html_filename,html_content&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    if(!r.ok) return null;
    return (await r.json())[0] || null;
  }catch{
    return null;
  }
}

async function requireCmsAdmin(request,env,allowedRoles=["owner","admin"]){
  const auth=request.headers.get("Authorization");
  if(!auth||!/^Bearer\s+.+/i.test(auth)) return null;

  const anon=env.SUPABASE_ANON_KEY||SB_PUBLIC_ANON_KEY;
  const userRes=await fetch(`${env.SUPABASE_URL}/auth/v1/user`,{
    headers:{apikey:anon,Authorization:auth}
  });
  if(!userRes.ok) return null;
  const user=await userRes.json();

  const memberRes=await fetch(
    `${env.SUPABASE_URL}/rest/v1/site_members?user_id=eq.${encodeURIComponent(user.id)}&select=site_id,role`,
    {headers:supaHeaders(env,true)}
  );
  if(!memberRes.ok) return null;
  const members=await memberRes.json();
  const requestedSite=String(request.headers.get("X-SB-Site-ID")||"").trim();
  const member=requestedSite
    ? members.find(x=>x.site_id===requestedSite)
    : members[0];
  if(!member || !allowedRoles.includes(member.role)) return null;

  return {user,site_id:member.site_id,role:member.role};
}

async function updateIntegration(env,siteId,patch,provider="gsc"){
  const body={site_id:siteId,provider,...patch};
  const r=await fetch(
    `${env.SUPABASE_URL}/rest/v1/integrations?on_conflict=site_id,provider`,
    {
      method:"POST",
      headers:{...supaHeaders(env,true),Prefer:"resolution=merge-duplicates,return=representation"},
      body:JSON.stringify(body)
    }
  );
  if(!r.ok) throw new Error(await r.text());
  return (await r.json())[0]||body;
}

async function saveCredential(env,siteId,t,existingRefresh=null,provider="gsc"){
  const expiresAt=t.expires_in ? new Date(Date.now()+Number(t.expires_in)*1000).toISOString() : null;
  const body={
    site_id:siteId,
    provider,
    access_token:t.access_token || null,
    refresh_token:t.refresh_token || existingRefresh || null,
    token_type:t.token_type || "Bearer",
    scopes:t.scope || (provider==="ga4"?GA4_SCOPE:GSC_SCOPE),
    expires_at:expiresAt
  };
  const r=await fetch(`${env.SUPABASE_URL}/rest/v1/integration_credentials?on_conflict=site_id,provider`,{
    method:"POST",
    headers:{...supaHeaders(env,true),Prefer:"resolution=merge-duplicates,return=representation"},
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await r.text());
  return (await r.json())[0];
}

async function getCredential(env,siteId,provider="gsc"){
  const r=await fetch(
    `${env.SUPABASE_URL}/rest/v1/integration_credentials?site_id=eq.${siteId}&provider=eq.${encodeURIComponent(provider)}&select=*`,
    {headers:supaHeaders(env,true)}
  );
  if(!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}

async function validCredential(env,siteId,provider="gsc"){
  let cred=await getCredential(env,siteId,provider);
  if(!cred) throw new Error(provider==="ga4"?"Google Analytics is not connected.":"Search Console is not connected.");

  const expires=cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if(cred.access_token && expires>Date.now()+60000) return cred;
  if(!cred.refresh_token) throw new Error(`Google refresh token missing. Reconnect ${provider==="ga4"?"Analytics":"Search Console"}.`);

  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      refresh_token:cred.refresh_token,
      grant_type:"refresh_token"
    })
  });
  const t=await r.json();
  if(!r.ok) throw new Error(t.error_description || t.error || "Google token refresh failed.");
  return saveCredential(env,siteId,t,cred.refresh_token,provider);
}

function cookie(request,name){
  const raw=request.headers.get("Cookie") || "";
  const match=raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function mediaGenerate(request,env){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env,["owner","admin","editor"]);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const body=await request.json();
    const result=await generateArticleImage(env,{...body,site_id:cms.site_id});
    return Response.json(result);
  }catch(e){
    return Response.json({error:e.message},{status:400});
  }
}

async function ga4Status(request,env){
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({ok:false,error:"Unauthorized"},{status:401});
  const [credRes,intRes]=await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/integration_credentials?site_id=eq.${cms.site_id}&provider=eq.ga4&select=id,expires_at&limit=1`,{headers:supaHeaders(env,true)}),
    fetch(`${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&provider=eq.ga4&select=status,external_property_id,config,last_sync_at,last_error&limit=1`,{headers:supaHeaders(env,true)})
  ]);
  const cred=credRes.ok?(await credRes.json())[0]||null:null;
  const integration=intRes.ok?(await intRes.json())[0]||{}:{};
  return Response.json({
    ok:true,
    configured:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),
    connected:!!cred,
    property_id:integration.external_property_id||null,
    measurement_id:integration.config?.measurement_id||null,
    status:integration.status||"disconnected",
    last_sync_at:integration.last_sync_at||null,
    last_error:integration.last_error||null
  });
}

async function ga4Connect(request,env,url){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET){
    return Response.json({error:"GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured."},{status:500});
  }
  const state=crypto.randomUUID();
  const redirect=`${url.origin}/api/ga4/callback`;
  const google=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search=new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,
    redirect_uri:redirect,
    response_type:"code",
    scope:GA4_SCOPE,
    access_type:"offline",
    prompt:"consent",
    state
  }).toString();
  const res=Response.json({url:google.toString()});
  res.headers.append("Set-Cookie",`rvf_ga4_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.headers.append("Set-Cookie",`rvf_ga4_site=${cms.site_id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return res;
}

async function ga4Callback(request,env,url){
  const code=url.searchParams.get("code");
  const state=url.searchParams.get("state");
  const savedState=cookie(request,"rvf_ga4_state");
  const siteId=cookie(request,"rvf_ga4_site");
  if(!code || !state || state!==savedState || !siteId){
    return new Response("Invalid Google Analytics OAuth state.",{status:400});
  }
  const redirect=`${url.origin}/api/ga4/callback`;
  const tr=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type:"authorization_code",
      redirect_uri:redirect
    })
  });
  const token=await tr.json();
  if(!tr.ok) return new Response(token.error_description || "Google token exchange failed.",{status:400});
  await saveCredential(env,siteId,token,null,"ga4");
  await updateIntegration(env,siteId,{status:"connected",last_error:null},"ga4");
  return Response.redirect(`${url.origin}/sb-control-8n4k/ga4?ga4_connected=1`,302);
}

async function ga4Properties(request,env){
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const cred=await validCredential(env,cms.site_id,"ga4");
    const r=await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",{
      headers:{Authorization:`Bearer ${cred.access_token}`}
    });
    const data=await r.json();
    if(!r.ok) throw new Error(data.error?.message||"Could not list Google Analytics properties.");
    const properties=[];
    for(const account of data.accountSummaries||[]){
      for(const p of account.propertySummaries||[]){
        properties.push({
          property:p.property||"",
          property_id:String(p.property||"").replace(/^properties\//,""),
          display_name:p.displayName||p.property||"",
          account_name:account.displayName||account.account||""
        });
      }
    }
    const ir=await fetch(
      `${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&provider=eq.ga4&select=external_property_id,config&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    const current=ir.ok?((await ir.json())[0]||{}):{};
    return Response.json({properties,current:current.external_property_id||null,measurement_id:current.config?.measurement_id||null});
  }catch(e){
    return Response.json({error:e.message},{status:500});
  }
}

async function ga4SelectProperty(request,env){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const body=await request.json();
    const propertyId=String(body.property_id||"").replace(/^properties\//,"").trim();
    const measurementId=String(body.measurement_id||"").trim();
    if(!/^\d+$/.test(propertyId)) throw new Error("A valid GA4 property ID is required.");
    await updateIntegration(env,cms.site_id,{
      status:"connected",
      external_property_id:propertyId,
      config:{measurement_id:measurementId||null},
      last_error:null
    },"ga4");
    return Response.json({ok:true,property_id:propertyId,measurement_id:measurementId||null});
  }catch(e){
    return Response.json({error:e.message},{status:400});
  }
}

async function ga4Sync(request,env){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const cred=await validCredential(env,cms.site_id,"ga4");
    const ir=await fetch(
      `${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&provider=eq.ga4&select=external_property_id,config&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    const integration=ir.ok?((await ir.json())[0]||{}):{};
    const property=String(integration.external_property_id||"").replace(/^properties\//,"");
    if(!property) throw new Error("Choose a GA4 property before syncing.");

    const rr=await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`,{
      method:"POST",
      headers:{Authorization:`Bearer ${cred.access_token}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        dateRanges:[{startDate:"28daysAgo",endDate:"yesterday"}],
        dimensions:[{name:"date"},{name:"landingPagePlusQueryString"}],
        metrics:[
          {name:"sessions"},
          {name:"activeUsers"},
          {name:"engagedSessions"},
          {name:"engagementRate"},
          {name:"screenPageViews"}
        ],
        limit:"100000"
      })
    });
    const data=await rr.json();
    if(!rr.ok) throw new Error(data.error?.message||"Google Analytics report request failed.");
    const rows=(data.rows||[]).map(row=>{
      const d=row.dimensionValues||[],m=row.metricValues||[];
      const rawDate=d[0]?.value||"";
      const date=/^\d{8}$/.test(rawDate)?`${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`:rawDate;
      return {
        site_id:cms.site_id,
        date,
        landing_page:d[1]?.value||"",
        sessions:Number(m[0]?.value||0),
        active_users:Number(m[1]?.value||0),
        engaged_sessions:Number(m[2]?.value||0),
        engagement_rate:Number(m[3]?.value||0),
        views:Number(m[4]?.value||0)
      };
    }).filter(x=>x.date);

    for(let i=0;i<rows.length;i+=500){
      const chunk=rows.slice(i,i+500);
      const ur=await fetch(
        `${env.SUPABASE_URL}/rest/v1/ga4_daily?on_conflict=site_id,date,landing_page`,
        {
          method:"POST",
          headers:{...supaHeaders(env,true),Prefer:"resolution=merge-duplicates"},
          body:JSON.stringify(chunk)
        }
      );
      if(!ur.ok) throw new Error(await ur.text());
    }
    await updateIntegration(env,cms.site_id,{
      status:"connected",
      external_property_id:property,
      config:integration.config||{},
      last_sync_at:new Date().toISOString(),
      last_error:null
    },"ga4");
    return Response.json({ok:true,rows:rows.length,property});
  }catch(e){
    try{await updateIntegration(env,cms.site_id,{status:"error",last_error:e.message},"ga4")}catch{}
    return Response.json({error:e.message},{status:500});
  }
}

async function gscConnect(request,env,url){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET){
    return Response.json({error:"GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured."},{status:500});
  }

  const state=crypto.randomUUID();
  const redirect=`${url.origin}/api/gsc/callback`;
  const google=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search=new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,
    redirect_uri:redirect,
    response_type:"code",
    scope:GSC_SCOPE,
    access_type:"offline",
    prompt:"consent",
    state
  }).toString();

  const res=Response.json({url:google.toString()});
  res.headers.append("Set-Cookie",`rvf_gsc_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.headers.append("Set-Cookie",`rvf_gsc_site=${cms.site_id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return res;
}

async function gscCallback(request,env,url){
  const code=url.searchParams.get("code");
  const state=url.searchParams.get("state");
  const savedState=cookie(request,"rvf_gsc_state");
  const siteId=cookie(request,"rvf_gsc_site");

  if(!code || !state || state!==savedState || !siteId){
    return new Response("Invalid Google OAuth state.",{status:400});
  }

  const redirect=`${url.origin}/api/gsc/callback`;
  const tr=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type:"authorization_code",
      redirect_uri:redirect
    })
  });
  const token=await tr.json();
  if(!tr.ok) return new Response(token.error_description || "Google token exchange failed.",{status:400});

  await saveCredential(env,siteId,token);

  // OAuth connection is account-level. Property selection is intentionally
  // left to the admin UI so multi-site accounts never bind to the wrong site.
  await updateIntegration(env,siteId,{
    status:"connected",
    last_error:null
  });

  return Response.redirect(`${url.origin}/sb-control-8n4k/gsc?connected=1`,302);
}

async function gscSync(request,env){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});

  try{
    const cred=await validCredential(env,cms.site_id);
    const ir=await fetch(
      `${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&provider=eq.gsc&select=external_property_id&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    const integration=(await ir.json())[0] || {};
    let property=integration.external_property_id;

    if(!property){
      throw new Error("Choose a Search Console property in the admin panel before syncing.");
    }

    const end=new Date();
    end.setDate(end.getDate()-1);
    const start=new Date(end);
    start.setDate(start.getDate()-27);

    const qr=await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method:"POST",
        headers:{Authorization:`Bearer ${cred.access_token}`,"Content-Type":"application/json"},
        body:JSON.stringify({
          startDate:start.toISOString().slice(0,10),
          endDate:end.toISOString().slice(0,10),
          dimensions:["date","page","query","country","device"],
          rowLimit:25000,
          dataState:"final"
        })
      }
    );
    const qd=await qr.json();
    if(!qr.ok) throw new Error(qd.error?.message || "Search Analytics query failed.");

    const rows=(qd.rows || []).map(x=>({
      site_id:cms.site_id,
      date:x.keys?.[0] || "",
      page:x.keys?.[1] || "",
      query:x.keys?.[2] || "",
      country:x.keys?.[3] || "",
      device:x.keys?.[4] || "",
      clicks:x.clicks || 0,
      impressions:x.impressions || 0,
      ctr:x.ctr || 0,
      position:x.position || 0
    }));

    for(let i=0;i<rows.length;i+=500){
      const chunk=rows.slice(i,i+500);
      const ur=await fetch(
        `${env.SUPABASE_URL}/rest/v1/gsc_daily?on_conflict=site_id,date,page,query,country,device`,
        {
          method:"POST",
          headers:{...supaHeaders(env,true),Prefer:"resolution=merge-duplicates"},
          body:JSON.stringify(chunk)
        }
      );
      if(!ur.ok) throw new Error(await ur.text());
    }

    await updateIntegration(env,cms.site_id,{
      status:"connected",
      external_property_id:property,
      last_sync_at:new Date().toISOString(),
      last_error:null
    });

    return Response.json({ok:true,rows:rows.length,property});
  }catch(e){
    try{await updateIntegration(env,cms.site_id,{status:"error",last_error:e.message})}catch{}
    return Response.json({error:e.message},{status:500});
  }
}



async function gscProperties(request,env){
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const cred=await validCredential(env,cms.site_id);
    const r=await fetch("https://www.googleapis.com/webmasters/v3/sites",{
      headers:{Authorization:`Bearer ${cred.access_token}`}
    });
    const data=await r.json();
    if(!r.ok) throw new Error(data.error?.message || "Could not list Search Console properties.");

    const ir=await fetch(
      `${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&provider=eq.gsc&select=external_property_id&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    const current=((await ir.json())[0]||{}).external_property_id || null;

    return Response.json({
      current,
      properties:(data.siteEntry||[]).map(x=>({
        siteUrl:x.siteUrl,
        permissionLevel:x.permissionLevel
      }))
    });
  }catch(e){
    return Response.json({error:e.message},{status:500});
  }
}

async function gscSelectProperty(request,env){
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({error:"Unauthorized"},{status:401});

  try{
    const body=await request.json();
    const siteUrl=String(body.siteUrl||"").trim();
    if(!siteUrl) throw new Error("Property is required.");

    const cred=await validCredential(env,cms.site_id);
    const r=await fetch("https://www.googleapis.com/webmasters/v3/sites",{
      headers:{Authorization:`Bearer ${cred.access_token}`}
    });
    const data=await r.json();
    if(!r.ok) throw new Error(data.error?.message || "Could not validate Search Console property.");

    const found=(data.siteEntry||[]).find(x=>x.siteUrl===siteUrl);
    if(!found) throw new Error("This property is not available to the connected Google account.");

    await updateIntegration(env,cms.site_id,{
      status:"connected",
      external_property_id:siteUrl,
      last_error:null
    });

    return Response.json({
      ok:true,
      siteUrl,
      permissionLevel:found.permissionLevel
    });
  }catch(e){
    return Response.json({error:e.message},{status:400});
  }
}

async function gscStatus(request,env){
  const cms=await requireCmsAdmin(request,env);
  if(!cms) return Response.json({ok:false,error:"Unauthorized"},{status:401});

  const result={
    ok:true,
    google_client_id:!!env.GOOGLE_CLIENT_ID,
    google_client_secret:!!env.GOOGLE_CLIENT_SECRET,
    supabase_url:!!env.SUPABASE_URL,
    supabase_anon_key:!!env.SUPABASE_ANON_KEY,
    supabase_server_key:!!env.SUPABASE_SERVICE_ROLE_KEY,
    server_key_type:String(env.SUPABASE_SERVICE_ROLE_KEY||"").startsWith("sb_secret_")
      ?"sb_secret"
      :(String(env.SUPABASE_SERVICE_ROLE_KEY||"").startsWith("eyJ")?"legacy_jwt":"missing_or_unknown"),
    database_access:false
  };

  if(result.supabase_server_key){
    try{
      const r=await fetch(
        `${env.SUPABASE_URL}/rest/v1/integrations?site_id=eq.${cms.site_id}&select=provider&limit=1`,
        {headers:supaHeaders(env,true)}
      );
      result.database_access=r.ok;
      if(!r.ok) result.database_error=await r.text();
    }catch(e){
      result.database_error=e.message;
    }
  }

  result.ready=
    result.google_client_id &&
    result.google_client_secret &&
    result.supabase_url &&
    result.supabase_anon_key &&
    result.supabase_server_key &&
    result.database_access;

  return Response.json(result,{status:result.ready?200:503});
}


function normalizeGoogleVerificationToken(value){
  const raw=String(value||"").trim();
  if(!raw)return null;
  const full=raw.match(/<meta[^>]+name=["']google-site-verification["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const token=(full?full[1]:raw).trim();
  if(!token || token.length>500 || /[<>\s]/.test(token))return null;
  return token;
}

function escapeHtml(value){
  return String(value??"").replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function inlineMd(value){
  let x=escapeHtml(value);
  x=x.replace(/`([^`]+)`/g,"<code>$1</code>");
  x=x.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  x=x.replace(/\*([^*]+)\*/g,"<em>$1</em>");
  x=x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g,'<a href="$2">$1</a>');
  return x;
}


function articleAnchor(value="section"){
  return String(value||"section")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/<[^>]*>/g,"")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,80)||"section";
}

function articleHeadings(markdown=""){
  const seen=new Map();
  return String(markdown||"").replace(/\r/g,"").split("\n").flatMap(line=>{
    const m=line.match(/^(##|###)\s+(.+)/);
    if(!m)return [];
    const level=m[1].length;
    const label=m[2].replace(/[*_`]/g,"").trim();
    const base=articleAnchor(label);
    const count=(seen.get(base)||0)+1;
    seen.set(base,count);
    return [{level,label,id:count===1?base:`${base}-${count}`}];
  });
}

function articleTocHtml(markdown=""){
  const headings=articleHeadings(markdown).filter(x=>x.level===2).slice(0,12);
  if(!headings.length)return "";
  return `<nav class="rvf-article-toc" aria-label="On this page">
    <div class="rvf-toc-title">ON THIS PAGE</div>
    ${headings.map(h=>`<a href="#${escapeHtml(h.id)}">${escapeHtml(h.label)}</a>`).join("")}
  </nav>`;
}

function injectArticleAssets(html,a){
  let out=String(html||"");
  const faqHeading=/<h2 id="([^"]*(?:faq|frequently-asked-questions)[^"]*)">([^<]*(?:FAQ|Frequently Asked Questions)[^<]*)<\/h2>/i;
  const hit=out.match(faqHeading);
  if(!hit)return out;

  const start=hit.index;
  const afterHeading=start+hit[0].length;
  const nextH2=out.indexOf("<h2 ",afterHeading);
  const end=nextH2>=0?nextH2:out.length;
  const body=out.slice(afterHeading,end);
  const questionRe=/<h3 id="([^"]+)">([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3 id="|$)/gi;
  const items=[];
  let m;
  while((m=questionRe.exec(body))){
    const answer=String(m[3]||"").trim();
    if(!answer)continue;
    items.push({
      id:m[1],
      question:m[2],
      answer
    });
  }
  if(!items.length)return out;

  const faq=`<section class="rvf-faq" aria-labelledby="${escapeHtml(hit[1])}">
    <div class="rvf-faq-head">
      <span>COMMON QUESTIONS</span>
      <div>
        <h2 id="${escapeHtml(hit[1])}">${hit[2]}</h2>
        <p>Quick answers to the questions homeowners usually ask after working through this guide.</p>
      </div>
    </div>
    <div class="rvf-faq-list">
      ${items.map((item,index)=>`<details class="rvf-faq-item">
        <summary>
          <span class="rvf-faq-number">${String(index+1).padStart(2,"0")}</span>
          <span class="rvf-faq-question">${item.question}</span>
          <span class="rvf-faq-toggle" aria-hidden="true"></span>
        </summary>
        <div class="rvf-faq-answer">${item.answer}</div>
      </details>`).join("")}
    </div>
  </section>`;

  return out.slice(0,start)+faq+out.slice(end);
}

function renderMarkdown(markdown=""){
  const lines=String(markdown||"").replace(/\r/g,"").split("\n");
  const out=[];
  let list=null,items=[];
  const seen=new Map();
  const flush=()=>{
    if(!list)return;
    out.push(`<${list}>${items.map(i=>`<li>${inlineMd(i)}</li>`).join("")}</${list}>`);
    list=null;items=[];
  };
  const cells=line=>line.trim().replace(/^\||\|$/g,"").split("|").map(x=>x.trim());
  const headingId=label=>{
    const base=articleAnchor(label.replace(/[*_`]/g,""));
    const count=(seen.get(base)||0)+1;
    seen.set(base,count);
    return count===1?base:`${base}-${count}`;
  };

  for(let i=0;i<lines.length;i++){
    const line=lines[i].trimEnd();
    if(!line.trim()){flush();continue}
    let m;

    if((m=line.match(/^:::cta\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/))){
      flush();
      const href=m[4].trim();
      if(/^\/|^https?:\/\//i.test(href)){
        out.push(`<aside class="article-cta"><div><span class="eyebrow">NEXT STEP</span><h3>${inlineMd(m[1].trim())}</h3><p>${inlineMd(m[2].trim())}</p></div><a class="btn lime" href="${escapeHtml(href)}">${inlineMd(m[3].trim())}</a></aside>`);
      }
      continue;
    }

    if(line.trim().startsWith("|") && i+1<lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
      flush();
      const heads=cells(line);
      i+=2;
      const rows=[];
      while(i<lines.length && lines[i].trim().startsWith("|")){rows.push(cells(lines[i]));i++}
      i--;
      out.push(`<div class="article-table-wrap"><table class="article-table"><thead><tr>${heads.map(h=>`<th>${inlineMd(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${heads.map((_,j)=>`<td>${inlineMd(r[j]||"")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if((m=line.match(/^###\s+(.+)/))){flush();const id=headingId(m[1]);out.push(`<h3 id="${escapeHtml(id)}">${inlineMd(m[1])}</h3>`);continue}
    if((m=line.match(/^##\s+(.+)/))){flush();const id=headingId(m[1]);out.push(`<h2 id="${escapeHtml(id)}">${inlineMd(m[1])}</h2>`);continue}
    if((m=line.match(/^#\s+(.+)/))){flush();out.push(`<h1>${inlineMd(m[1])}</h1>`);continue}
    if((m=line.match(/^>\s?(.+)/))){flush();out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);continue}
    if((m=line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/))){
      flush();
      const alt=escapeHtml(m[1]||"");
      const src=escapeHtml(m[2]);
      const caption=m[3]?escapeHtml(m[3]):"";
      out.push(`<figure class="article-content-figure"><img src="${src}" alt="${alt}" loading="lazy" decoding="async">${caption?`<figcaption>${caption}</figcaption>`:""}</figure>`);
      continue;
    }
    if((m=line.match(/^[-*]\s+(.+)/))){if(list!=="ul"){flush();list="ul"}items.push(m[1]);continue}
    if((m=line.match(/^\d+\.\s+(.+)/))){if(list!=="ol"){flush();list="ol"}items.push(m[1]);continue}
    flush();out.push(`<p>${inlineMd(line)}</p>`);
  }
  flush();
  return out.join("");
}
async function publicApi(env,path){
  const useService=!!env.SUPABASE_SERVICE_ROLE_KEY;
  const r=await fetch(`${env.SUPABASE_URL}${path}`,{
    headers:supaHeaders(env,useService)
  });
  if(!r.ok)throw new Error(await r.text());
  return await r.json();
}

async function getPublicArticle(env,slug){
  const siteId=await sbSiteId(env);
  if(!siteId)return null;
  const rows=await publicApi(
    env,
    `/rest/v1/articles?site_id=eq.${siteId}&slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=id,category_id,title,slug,excerpt,content_markdown,published_at,updated_at,seo_title,meta_description,canonical_path,featured_image_url,featured_image_alt,categories(name,slug)&limit=2`
  );
  const article=rows[0]||null;
  if(!article)return null;
  article.related=await publicApi(
    env,
    `/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&slug=neq.${encodeURIComponent(slug)}&select=title,slug,excerpt,featured_image_url,featured_image_alt,published_at,categories(name,slug)&order=published_at.desc&limit=6`
  ).catch(()=>[]);
  return article;
}

async function getPublicCategory(env,slug){
  const siteId=await sbSiteId(env);
  if(!siteId)return null;
  const cats=await publicApi(
    env,
    `/rest/v1/categories?site_id=eq.${siteId}&slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,name,slug,description&limit=1`
  );
  if(!cats.length)return null;
  const category=cats[0];
  const articles=await publicApi(
    env,
    `/rest/v1/articles?category_id=eq.${category.id}&status=eq.published&select=title,slug,excerpt,content_type,published_at,featured_image_url,featured_image_alt&order=published_at.desc&limit=100`
  );
  return {category,articles:articles||[]};
}

function articleReadingMeta(markdown=""){
  const clean=String(markdown||"").replace(/!\[[^\]]*\]\([^)]*\)/g," ").replace(/\[[^\]]+\]\([^)]*\)/g," ").replace(/[>#*_\-|:]/g," ").replace(/\s+/g," ").trim();
  const words=clean?clean.split(" ").filter(Boolean).length:0;
  return {words:words,minutes:Math.max(1,Math.ceil(words/220))};
}

function articleAiToolsHtml(a){
  const prompt=escapeHtml('SepticBeacon: Please summarize this page in English. Focus on the main problem, the diagnostic sequence, safety warnings, likely causes, checks to perform before replacing parts, and the most useful next steps. Keep the summary practical and easy to scan.');
  const providers=[
    {id:"chatgpt",name:"ChatGPT",url:"https://chatgpt.com/",icon:"https://commons.wikimedia.org/wiki/Special:Redirect/file/ChatGPT-Logo.svg",fallback:"C"},
    {id:"gemini",name:"Gemini",url:"https://gemini.google.com/",icon:"https://cdn.simpleicons.org/googlegemini/4285F4",fallback:"G"},
    {id:"claude",name:"Claude",url:"https://claude.ai/new",icon:"https://cdn.simpleicons.org/claude/D97757",fallback:"C"},
    {id:"perplexity",name:"Perplexity",url:"https://www.perplexity.ai/",icon:"https://cdn.simpleicons.org/perplexity/20B8A6",fallback:"P"},
    {id:"grok",name:"Grok",url:"https://grok.com/",icon:"https://cdn.simpleicons.org/x/111111",fallback:"G"}
  ];
  const buttons=providers.map(function(item){
    return '<button type="button" class="rvf-ai-tool rvf-ai-'+item.id+'" data-ai-provider="'+item.id+'" data-ai-open="'+escapeHtml(item.url)+'" data-ai-prompt="'+prompt+'"><span class="rvf-ai-logo"><span class="rvf-ai-logo-fallback">'+item.fallback+'</span>'+(item.icon?'<img src="'+escapeHtml(item.icon)+'" alt="" width="20" height="20" loading="lazy">':'')+'</span><b>'+escapeHtml(item.name)+'</b><i aria-hidden="true">↗</i></button>';
  }).join("");
  return '<section class="rvf-ai-tools" aria-label="AI reading tools"><div class="rvf-ai-tools-copy"><span>AI READING TOOLS</span><strong>Ask an AI to summarize this SepticBeacon guide</strong><p>The current article URL is included automatically. If a provider does not support URL prompt prefill, the complete prompt is copied to your clipboard before it opens.</p></div><div class="rvf-ai-tools-actions">'+buttons+'</div><div class="rvf-ai-copy-status" aria-live="polite"></div></section>';
}

function articleRelatedSidebarHtml(a){
  const related=Array.isArray(a.related)?a.related.slice(0,3):[];
  if(!related.length)return "";
  const links=related.map(function(item){ return '<a href="/blog/'+escapeHtml(item.slug)+'"><b>'+escapeHtml(item.title)+'</b><small>'+escapeHtml((item.categories&&item.categories.name)||"Septic Guide")+'</small></a>'; }).join("");
  return '<div class="rvf-side-card rvf-side-related"><span>MORE SEPTICBEACON GUIDES</span><strong>Keep reading</strong><div class="rvf-side-related-list">'+links+'</div></div>';
}

function articleRelatedBottomHtml(a,category){
  const related=Array.isArray(a.related)?a.related.slice(0,3):[];
  if(!related.length)return '<div class="rvf-related-grid"><a href="/category/'+escapeHtml(category.slug||"guides")+'"><small>MORE IN THIS TOPIC</small><strong>'+escapeHtml(category.name||"Septic Guides")+'</strong><i>→</i></a><a href="/blog"><small>ALL GUIDES</small><strong>Browse the SepticBeacon library</strong><i>→</i></a></div>';
  const cards=related.map(function(item){ const media=item.featured_image_url?'<div class="rvf-related-article-media"><img src="'+escapeHtml(item.featured_image_url)+'" alt="'+escapeHtml(item.featured_image_alt||"")+'" loading="lazy"></div>':'<div class="rvf-related-article-media is-fallback"><span>'+escapeHtml((item.categories&&item.categories.name)||"Septic")+'</span></div>'; return '<a class="rvf-related-article" href="/blog/'+escapeHtml(item.slug)+'">'+media+'<div class="rvf-related-article-copy"><small>'+escapeHtml((item.categories&&item.categories.name)||"Septic Guide")+'</small><strong>'+escapeHtml(item.title)+'</strong><span>Read guide →</span></div></a>'; }).join("");
  return '<div class="rvf-related-articles">'+cards+'</div>';
}
function articleHtml(a){
  const category=a.categories||{};
  const published=a.published_at
    ? new Date(a.published_at).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})
    : "";
  const updated=a.updated_at
    ? new Date(a.updated_at).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"})
    : "";
  const rawBody=renderMarkdown(a.content_markdown);
  const bodyHtml=injectArticleAssets(rawBody,a);
  const toc=articleTocHtml(a.content_markdown);
  const reading=articleReadingMeta(a.content_markdown);

  return `<section class="rvf-blog-page">
    <section class="rvf-blog-feature">
      <div class="wrap">
        <div class="breadcrumb rvf-feature-breadcrumb"><a href="/">Home</a> / <a href="/guides">Blog</a> / <a href="/category/${escapeHtml(category.slug||"guides")}">${escapeHtml(category.name||"Guides")}</a></div>

        <div class="rvf-blog-feature-card ${a.featured_image_url?"has-image":"no-image"}">
          <div class="rvf-blog-feature-copy">
            <span class="badge">${escapeHtml(category.name||"Septic Guide")}</span>
            <h1>${escapeHtml(a.title)}</h1>
            ${a.excerpt?`<p class="rvf-blog-feature-deck">${escapeHtml(a.excerpt)}</p>`:""}
            <div class="rvf-blog-byline">
              <span class="rvf-author-mark">R</span>
              <span>
                <b>SepticBeacon Editorial Team</b>
                <small>${published?`Published ${escapeHtml(published)}`:""}${updated&&updated!==published?` · Updated ${escapeHtml(updated)}`:""}</small>
              </span>
              <span class="rvf-read-time"><b>${reading.minutes} min read</b><small>${reading.words.toLocaleString("en-US")} words</small></span>
            </div>
          </div>

          ${a.featured_image_url?`
          <figure class="rvf-blog-feature-media">
            <img src="${escapeHtml(a.featured_image_url)}" alt="${escapeHtml(a.featured_image_alt||a.title)}" loading="eager" decoding="async">
          </figure>`:""}
        </div>
      </div>
    </section>

    <div class="wrap rvf-blog-grid">
      <aside class="rvf-blog-left">
        ${toc}
      </aside>

      <main class="rvf-blog-main">
        ${(a.quick_answer||a.excerpt)?`<section class="rvf-quick-summary"><span>QUICK ANSWER</span><p>${escapeHtml(a.quick_answer||a.excerpt)}</p></section>`:""}

        <article class="rvf-prose">
          ${bodyHtml}

          <div class="article-end-note">
            <strong>SepticBeacon editorial note</strong>
            <p>This guide is educational. Never enter a septic tank. Use a qualified septic professional for sewage exposure, electrical pump work, excavation, confined-space hazards or site-specific diagnosis beyond normal homeowner checks.</p>
          </div>
        </article>

        <section class="rvf-related-block" aria-label="Related septic guides">
                  <div class="rvf-related-head"><span>KEEP READING</span><h2>Related septic guides</h2></div>
                  ${articleRelatedBottomHtml(a,category)}
                </section>

        <section class="rvf-blog-cta">
          <div><span>SEPTICBEACON</span><h2>Know what to check before the problem gets expensive.</h2><p>Browse practical maintenance, troubleshooting, cost and inspection guides for homeowners.</p></div>
          <a class="btn lime" href="/blog">Browse all guides</a>
        </section>
      </main>

      <aside class="rvf-blog-right">
        <div class="rvf-ad-reserved" hidden data-ad-placement="article-rail-1"></div>
        ${articleRelatedSidebarHtml(a)}
        <div class="rvf-side-card">
          <span>EXPLORE SEPTICBEACON</span>
          <strong>Browse by topic</strong>
          <p>Maintenance, problems, costs, inspections, system types and sizing.</p>
          <a href="/">Explore topics →</a>
        </div>
      </aside>
    </div>
  </section>`;
}
function categoryHtml(data){
  const c=data.category,articles=data.articles||[];
  const categoryArt=categoryImage(c.slug,c.name);
  return `<section class="category-hero"><div class="wrap">
    <div class="breadcrumb"><a href="/">Home</a> / Septic Topics / ${escapeHtml(c.name)}</div>
    <div class="category-hero-card">
      <div class="category-hero-copy">
        <div class="kicker"><span class="dot"></span> ${escapeHtml(c.name)}</div>
        <h1>${escapeHtml(c.name)} septic guides</h1>
        <p>${escapeHtml(c.description||"Practical troubleshooting and maintenance guidance for this septic system.")}</p>
        <div class="category-hero-actions"><a class="btn lime" href="/search.html?q=${encodeURIComponent(c.name)}">Search ${escapeHtml(c.name)}</a><a class="btn ghost-light" href="/guides">All guides</a></div>
      </div>
      <div class="category-hero-art"><img src="${categoryArt}" alt="" width="220" height="220"><div class="category-stat"><b>${articles.length}</b><span>Published guides</span></div></div>
    </div>
  </div></section>
  <section class="section category-guides-section"><div class="wrap">
    <div class="section-head compact"><div><div class="kicker" style="color:var(--pine)">Published guidance</div><h2>Start with the guide closest to your symptom.</h2></div></div>
    <div class="guide-grid">
      ${articles.length?articles.map(a=>{
        const img=a.featured_image_url||categoryArt;
        return `<a class="guide-card" href="/blog/${escapeHtml(a.slug)}">
          <div class="guide-card-media ${a.featured_image_url?"":"is-category-art"}"><img src="${escapeHtml(img)}" alt="${escapeHtml(a.featured_image_alt||"")}" loading="lazy" decoding="async"></div>
          <div class="article-copy">
            <div class="meta"><span class="badge">${escapeHtml(a.content_type||"Guide")}</span>${a.published_at?`<span>${escapeHtml(new Date(a.published_at).toLocaleDateString("en-US",{month:"short",year:"numeric"}))}</span>`:""}</div>
            <h3>${escapeHtml(a.title)}</h3>
            <p>${escapeHtml(a.excerpt||"Open this practical septic guide.")}</p>
            <span class="card-link">Read guide →</span>
          </div>
        </a>`;
      }).join(""):'<div class="empty-state">No published guides in this section yet.</div>'}
    </div>
  </div></section>`;
}
function isPublicReadyArticle(a){
  const title=String(a?.title||"").trim().toLowerCase();
  const slug=String(a?.slug||"").trim().toLowerCase();
  if(slug.includes("-demo")||slug.endsWith("demo"))return false;
  if(/^test(?:\d|test|\s|$)/i.test(title))return false;
  if(/^test(?:\d|test|-|$)/i.test(slug))return false;
  return true;
}
async function getHomeData(env){
  const siteId=await sbSiteId(env);
  if(!siteId)return {categories:[],articles:[]};
  const [categories,articles]=await Promise.all([
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=id,name,slug,description&order=sort_order&limit=12`),
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=title,slug,excerpt,content_type,published_at,featured_image_url,featured_image_alt,categories(name,slug)&order=published_at.desc&limit=12`)
  ]);
  return {categories,articles:articles||[]};
}

async function getGuidesData(env){
  const siteId=await sbSiteId(env);
  if(!siteId)return {articles:[],categories:[]};
  const results=await Promise.all([
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=title,slug,excerpt,content_type,published_at,updated_at,featured_image_url,featured_image_alt,categories(name,slug)&order=published_at.desc&limit=120`),
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=name,slug,description,sort_order&order=sort_order.asc.nullslast,name.asc`)
  ]);
  return {articles:results[0]||[],categories:results[1]||[]};
}

function categoryImage(slug,name){
  const key=String(slug||name||"guide").toLowerCase();
  const palettes={
    "septic-basics":["#dfeee6","#17493b","#b8df4d"],
    "maintenance":["#eef3dc","#245f4e","#b8df4d"],
    "problems-fixes":["#f4e9d9","#6b4f35","#d7b06a"],
    "costs-inspections":["#e8edf1","#34566c","#a9cad8"],
    "system-types":["#e5eee7","#315c4e","#8fc0a7"],
    "parts-sizing":["#f0eee7","#5a625d","#c2d48b"]
  };
  const p=palettes[key]||["#e9efe8","#17493b","#b8df4d"];
  const symbols={
    "septic-basics":"M34 28h52v38H34z M45 66v18 M75 66v18",
    "maintenance":"M31 61c9-24 22-34 39-34 17 0 30 10 39 34 M46 61h48 M70 38v46",
    "problems-fixes":"M70 25 105 82H35z M70 46v17 M70 72v2",
    "costs-inspections":"M42 30h48v55H42z M52 43h28 M52 55h28 M52 67h18 M96 68l12 12",
    "system-types":"M30 71c10-27 24-40 40-40s30 13 40 40 M42 71h56 M51 71v15 M89 71v15",
    "parts-sizing":"M39 34h62v47H39z M49 45h42 M49 57h30 M49 69h36"
  };
  const d=symbols[key]||symbols["septic-basics"];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 110"><rect width="140" height="110" rx="24" fill="${p[0]}"/><circle cx="112" cy="18" r="22" fill="${p[2]}" opacity=".42"/><path d="${d}" fill="none" stroke="${p[1]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return "data:image/svg+xml;charset=UTF-8,"+encodeURIComponent(svg);
}

function homeCategoriesHtml(categories){
  if(!categories.length)return '<div class="empty-state">System libraries will appear here as they are published.</div>';
  return categories.map(c=>`<a class="topic topic-vector" href="/category/${escapeHtml(c.slug)}">
    <div class="topic-icon-image"><img src="${categoryImage(c.slug,c.name)}" alt="" loading="lazy" width="72" height="72"></div>
    <div class="topic-copy"><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.description||"septic maintenance and troubleshooting guidance.")}</p></div>
    <span class="topic-arrow" aria-hidden="true">→</span>
  </a>`).join("");
}

function homeArticlesHtml(articles){
  if(!articles.length)return '<div class="empty-state">Published guides will appear here.</div>';
  return articles.slice(0,6).map((a,i)=>{
    const fallback=categoryImage(a.categories?.slug,a.categories?.name);
    const img=a.featured_image_url||fallback;
    return `<a class="article-card home-guide-card ${i===0?"is-featured":""}" href="/blog/${escapeHtml(a.slug)}">
      <div class="home-guide-media ${a.featured_image_url?"":"is-category-art"}"><img src="${escapeHtml(img)}" alt="${escapeHtml(a.featured_image_alt||"")}" loading="lazy" decoding="async"></div>
      <div class="article-copy">
        <div class="meta"><span class="badge">${escapeHtml(a.categories?.name||a.content_type||"Guide")}</span>${a.published_at?`<span>${escapeHtml(new Date(a.published_at).toLocaleDateString("en-US",{month:"short",year:"numeric"}))}</span>`:""}</div>
        <h3>${escapeHtml(a.title)}</h3>
        <p>${escapeHtml(a.excerpt||"Open this practical septic guide.")}</p>
        <span class="card-link">Read guide →</span>
      </div>
    </a>`;
  }).join("");
}

function guidesHtml(data){
  const articles=data.articles||[];
  const categories=data.categories||[];
  if(!articles.length)return `<div class='blog-index-empty'><h2>Fresh septic guides are on the way.</h2><p>Use the system library while new articles are being published.</p><a class='btn primary' href='/'>Browse septic systems</a></div>`;

  const featured=articles[0];
  const latest=articles.slice(1);
  const featureFallback=categoryImage(featured.categories?.slug,featured.categories?.name);
  const featureImage=featured.featured_image_url||featureFallback;
  const featureDate=featured.published_at?new Date(featured.published_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}):'';

  const categoryLinks=categories.map(c=>`<a class='blog-system-pill' href='/category/${escapeHtml(c.slug)}'>
    <span class='blog-system-pill-art'><img src='${categoryImage(c.slug,c.name)}' alt='' width='34' height='34' loading='lazy'></span>
    <span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.description||'septic maintenance and troubleshooting')}</small></span>
    <i aria-hidden='true'>→</i>
  </a>`).join('');

  const cards=latest.map(a=>{
    const fallback=categoryImage(a.categories?.slug,a.categories?.name);
    const img=a.featured_image_url||fallback;
    const date=a.published_at?new Date(a.published_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
    return `<article class='blog-index-card'>
      <a class='blog-index-card-media ${a.featured_image_url?'':'is-fallback'}' href='/blog/${escapeHtml(a.slug)}'>
        <img src='${escapeHtml(img)}' alt='${escapeHtml(a.featured_image_alt||'')}' loading='lazy' decoding='async'>
      </a>
      <div class='blog-index-card-copy'>
        <div class='blog-index-card-meta'><a href='/category/${escapeHtml(a.categories?.slug||'guides')}'>${escapeHtml(a.categories?.name||'Septic Guide')}</a>${date?`<span>${escapeHtml(date)}</span>`:''}</div>
        <h2><a href='/blog/${escapeHtml(a.slug)}'>${escapeHtml(a.title)}</a></h2>
        <p>${escapeHtml(a.excerpt||'Practical septic maintenance and troubleshooting guidance for homeowners.')}</p>
        <a class='blog-index-read' href='/blog/${escapeHtml(a.slug)}'>Read guide <span>→</span></a>
      </div>
    </article>`;
  }).join('');

  return `<div class='blog-index-rendered'>
    <section class='blog-index-featured'>
      <a class='blog-index-feature-media ${featured.featured_image_url?'':'is-fallback'}' href='/blog/${escapeHtml(featured.slug)}'>
        <img src='${escapeHtml(featureImage)}' alt='${escapeHtml(featured.featured_image_alt||'')}' decoding='async'>
      </a>
      <div class='blog-index-feature-copy'>
        <div class='blog-index-feature-meta'><a href='/category/${escapeHtml(featured.categories?.slug||'guides')}'>${escapeHtml(featured.categories?.name||'Septic Guide')}</a>${featureDate?`<span>${escapeHtml(featureDate)}</span>`:''}</div>
        <span class='blog-index-feature-label'>LATEST GUIDE</span>
        <h2><a href='/blog/${escapeHtml(featured.slug)}'>${escapeHtml(featured.title)}</a></h2>
        <p>${escapeHtml(featured.excerpt||'Open the latest SepticBeacon guide.')}</p>
        <a class='btn lime' href='/blog/${escapeHtml(featured.slug)}'>Read the latest guide</a>
      </div>
    </section>

    ${categoryLinks?`<section class='blog-index-systems'>
      <div class='blog-index-section-head'><div><span>BROWSE BY SYSTEM</span><h2>Start with the part of your septic system you need help with.</h2></div><a href='/#systems'>View all systems →</a></div>
      <div class='blog-system-pills'>${categoryLinks}</div>
    </section>`:''}

    <section class='blog-index-latest'>
      <div class='blog-index-section-head'><div><span>LATEST FROM SEPTICBEACON</span><h2>Practical troubleshooting, maintenance and ownership guides.</h2></div><a href='/search.html'>Search the library →</a></div>
      <div class='blog-index-grid'>${cards||`<div class='empty-state'>More guides are being prepared.</div>`}</div>
    </section>

    <section class='blog-index-search-cta'>
      <div><span>NOT SURE WHERE TO START?</span><h2>Search by the symptom you are seeing.</h2><p>Use plain language such as “septic smell outside” or “how often should I pump my tank.”</p></div>
      <a class='btn lime' href='/search.html'>Search SepticBeacon</a>
    </section>
  </div>`;
}
function homePopularHtml(articles){
  if(!articles.length){
    return `<a class="check" href="/search.html"><i>1</i><span>Search the SepticBeacon guide library</span></a>
      <a class="check" href="/#systems"><i>2</i><span>Browse by septic system</span></a>`;
  }
  return articles.slice(0,4).map((a,i)=>`<a class="check" href="/blog/${escapeHtml(a.slug)}">
    <i>${i+1}</i><span>${escapeHtml(a.title)}</span>
  </a>`).join("");
}


function embeddedDemoMedia(name){
  const uri=categoryImage(name,name);
  const base64=String(uri).split(",")[1]||"";
  if(!base64)return new Response("Not found",{status:404});
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  return new Response(bytes,{headers:{"Content-Type":"image/webp","Cache-Control":"public, max-age=31536000, immutable"}});
}

function isTrustedOrigin(request){
  const origin=request.headers.get("Origin");
  if(!origin)return true;
  try{
    const u=new URL(origin);
    return u.protocol==="https:" && ["septicbeacon.com","septicbeacon.enessboz2.workers.dev"].includes(u.hostname);
  }catch{return false}
}

function isValidWebP(bytes){
  if(!bytes || bytes.byteLength<12)return false;
  const b=new Uint8Array(bytes,0,12);
  return b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46 &&
    b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50;
}

function validUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||""));
}

function safeMediaName(value="image"){
  return String(value||"image")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\.[^.]+$/,"")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,72)||"image";
}

async function mediaList(request,env){
  const cms=await requireCmsAdmin(request,env,["owner","admin","editor"]);
  if(!cms)return Response.json({error:"Unauthorized"},{status:401});
  const r=await fetch(
    `${env.SUPABASE_URL}/rest/v1/media?site_id=eq.${cms.site_id}&select=id,article_id,storage_key,public_url,alt_text,caption,width,height,bytes,original_name,mime_type,created_at&order=created_at.desc&limit=200`,
    {headers:supaHeaders(env,true)}
  );
  const text=await r.text();
  if(!r.ok)return Response.json({error:text||"Could not load media."},{status:r.status});
  return new Response(text,{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
}

async function mediaUpload(request,env,url){
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env,["owner","admin","editor"]);
  if(!cms)return Response.json({error:"Unauthorized"},{status:401});
  if(!env.MEDIA_BUCKET)return Response.json({error:"MEDIA_BUCKET R2 binding is not configured."},{status:503});

  const type=request.headers.get("content-type")||"";
  if(type!=="image/webp")return Response.json({error:"Only optimized image/webp uploads are accepted."},{status:415});

  const contentLength=Number(request.headers.get("content-length")||0);
  if(contentLength>5*1024*1024)return Response.json({error:"Optimized image is still larger than 5 MB."},{status:413});

  const bytes=await request.arrayBuffer();
  if(!bytes.byteLength)return Response.json({error:"Empty upload."},{status:400});
  if(bytes.byteLength>5*1024*1024)return Response.json({error:"Optimized image is still larger than 5 MB."},{status:413});
  if(!isValidWebP(bytes))return Response.json({error:"Upload body is not a valid WebP image."},{status:415});

  const name=safeMediaName(url.searchParams.get("name")||"septic-image");
  const alt=String(url.searchParams.get("alt")||"").slice(0,500);
  const caption=String(url.searchParams.get("caption")||"").slice(0,1200);
  const rawWidth=Number(url.searchParams.get("width")||0);
  const rawHeight=Number(url.searchParams.get("height")||0);
  const width=Number.isFinite(rawWidth)&&rawWidth>0&&rawWidth<=20000?Math.round(rawWidth):null;
  const height=Number.isFinite(rawHeight)&&rawHeight>0&&rawHeight<=20000?Math.round(rawHeight):null;
  const articleId=url.searchParams.get("article_id")||null;
  const originalName=String(url.searchParams.get("original_name")||"").slice(0,255)||null;

  if(articleId){
    if(!validUuid(articleId))return Response.json({error:"Invalid article_id."},{status:400});
    const articleRes=await fetch(
      `${env.SUPABASE_URL}/rest/v1/articles?id=eq.${encodeURIComponent(articleId)}&site_id=eq.${cms.site_id}&select=id&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    if(!articleRes.ok)return Response.json({error:"Could not validate article ownership."},{status:502});
    if(!(await articleRes.json()).length)return Response.json({error:"Article does not belong to this site."},{status:403});
  }

  const now=new Date();
  const key=`${cms.site_id}/${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,"0")}/${name}-${Date.now().toString(36)}.webp`;

  await env.MEDIA_BUCKET.put(key,bytes,{
    httpMetadata:{contentType:"image/webp",cacheControl:"public, max-age=31536000, immutable"},
    customMetadata:{site_id:cms.site_id,alt_text:alt.slice(0,500)}
  });

  const publicUrl=`/media/${key}`;
  const payload={
    site_id:cms.site_id,
    article_id:articleId||null,
    storage_key:key,
    public_url:publicUrl,
    media_type:"image",
    alt_text:alt||null,
    caption:caption||null,
    original_name:originalName||null,
    mime_type:"image/webp",
    width,
    height,
    bytes:bytes.byteLength
  };

  const r=await fetch(`${env.SUPABASE_URL}/rest/v1/media?select=*`,{
    method:"POST",
    headers:{...supaHeaders(env,true),Prefer:"return=representation"},
    body:JSON.stringify(payload)
  });
  const text=await r.text();
  if(!r.ok){
    await env.MEDIA_BUCKET.delete(key).catch(()=>{});
    return Response.json({error:text||"Media database record could not be created."},{status:r.status});
  }
  const row=JSON.parse(text)?.[0];
  return Response.json({ok:true,media:row});
}

async function mediaDelete(request,env,url){
  if(request.method!=="DELETE"&&request.method!=="POST")return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env,["owner","admin","editor"]);
  if(!cms)return Response.json({error:"Unauthorized"},{status:401});
  const id=url.searchParams.get("id");
  if(!id)return Response.json({error:"Media id is required."},{status:400});

  const r=await fetch(
    `${env.SUPABASE_URL}/rest/v1/media?id=eq.${encodeURIComponent(id)}&site_id=eq.${cms.site_id}&select=id,storage_key,public_url&limit=1`,
    {headers:supaHeaders(env,true)}
  );
  const rows=await r.json();
  const row=rows?.[0];
  if(!row)return Response.json({error:"Media not found."},{status:404});

  if(env.MEDIA_BUCKET)await env.MEDIA_BUCKET.delete(row.storage_key).catch(()=>{});
  await fetch(`${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${cms.site_id}&featured_image_url=eq.${encodeURIComponent(row.public_url)}`,{
    method:"PATCH",headers:supaHeaders(env,true),body:JSON.stringify({featured_image_url:null,featured_image_alt:null})
  }).catch(()=>{});
  await fetch(`${env.SUPABASE_URL}/rest/v1/media?id=eq.${id}&site_id=eq.${cms.site_id}`,{
    method:"DELETE",headers:supaHeaders(env,true)
  });
  return Response.json({ok:true});
}

async function mediaMeta(request,env,url){
  if(request.method!=="PATCH")return new Response("Method not allowed",{status:405});
  const cms=await requireCmsAdmin(request,env,["owner","admin","editor"]);
  if(!cms)return Response.json({error:"Unauthorized"},{status:401});
  const id=url.searchParams.get("id");
  if(!id)return Response.json({error:"Media id is required."},{status:400});
  const body=await request.json();
  const patch={
    alt_text:String(body.alt_text||"").trim().slice(0,500)||null,
    caption:String(body.caption||"").trim().slice(0,1200)||null
  };
  const r=await fetch(`${env.SUPABASE_URL}/rest/v1/media?id=eq.${encodeURIComponent(id)}&site_id=eq.${cms.site_id}&select=*`,{
    method:"PATCH",
    headers:{...supaHeaders(env,true),Prefer:"return=representation"},
    body:JSON.stringify(patch)
  });
  const text=await r.text();
  if(!r.ok)return Response.json({error:text||"Media metadata update failed."},{status:r.status});
  return new Response(text,{headers:{"Content-Type":"application/json"}});
}

async function serveMedia(env,key){
  if(!env.MEDIA_BUCKET)return new Response("Media storage unavailable",{status:503});
  const object=await env.MEDIA_BUCKET.get(key);
  if(!object)return new Response("Not found",{status:404});
  const headers=new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag",object.httpEtag);
  headers.set("Cache-Control","public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options","nosniff");
  return new Response(object.body,{headers});
}

async function findRedirect(env,path){
  if(!env.SUPABASE_SERVICE_ROLE_KEY)return null;
  try{
    const siteId=await sbSiteId(env);
    if(!siteId)return null;
    const rows=await fetch(
      `${env.SUPABASE_URL}/rest/v1/redirects?site_id=eq.${siteId}&source_path=eq.${encodeURIComponent(path)}&is_active=eq.true&select=destination_path,status_code&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    if(!rows.ok)return null;
    return (await rows.json())[0]||null;
  }catch{return null}
}

function xmlEscape(v){
  return String(v??"").replace(/[<>&'"]/g,c=>({
    "<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"
  }[c]));
}

const DEFAULT_SEO_SETTINGS={
  site_name:"SepticBeacon",
  default_meta_description:"Practical septic maintenance, troubleshooting, cost and inspection guidance for homeowners.",
  sitemap_enabled:true,
  sitemap_include_categories:true,
  sitemap_include_static:true,
  robots_enabled:true,
  allow_oai_searchbot:true,
  extra_robots:""
};

async function getSeoSettings(env,siteId=null){
  try{
    const id=siteId||await sbSiteId(env);
    if(!id)return {...DEFAULT_SEO_SETTINGS};
    const r=await fetch(`${env.SUPABASE_URL}/rest/v1/site_identity_items?site_id=eq.${id}&provider=eq.seo&key_name=eq.seo_core&select=id,value,updated_at&order=updated_at.desc&limit=1`,{headers:supaHeaders(env,true)});
    if(!r.ok)return {...DEFAULT_SEO_SETTINGS};
    const row=(await r.json())[0];
    if(!row?.value)return {...DEFAULT_SEO_SETTINGS};
    return {...DEFAULT_SEO_SETTINGS,...JSON.parse(row.value)};
  }catch{return {...DEFAULT_SEO_SETTINGS}}
}

async function seoSettingsApi(request,env){
  const cms=await requireCmsAdmin(request,env,request.method==="GET"?["owner","admin","editor","reviewer","viewer"]:["owner","admin"]);
  if(!cms)return Response.json({error:"Unauthorized"},{status:401});
  if(request.method==="GET"){
    const settings=await getSeoSettings(env,cms.site_id);
    return Response.json({settings,sitemap_url:new URL("/sitemap.xml",request.url).href,robots_url:new URL("/robots.txt",request.url).href});
  }
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  let body={};
  try{body=await request.json()}catch{return Response.json({error:"Invalid JSON"},{status:400})}
  const settings={
    site_name:String(body.site_name||DEFAULT_SEO_SETTINGS.site_name).trim().slice(0,120),
    default_meta_description:String(body.default_meta_description||DEFAULT_SEO_SETTINGS.default_meta_description).trim().slice(0,320),
    sitemap_enabled:body.sitemap_enabled!==false,
    sitemap_include_categories:body.sitemap_include_categories!==false,
    sitemap_include_static:body.sitemap_include_static!==false,
    robots_enabled:body.robots_enabled!==false,
    allow_oai_searchbot:body.allow_oai_searchbot!==false,
    extra_robots:String(body.extra_robots||"").replace(/\r/g,"").slice(0,6000)
  };
  const find=await fetch(`${env.SUPABASE_URL}/rest/v1/site_identity_items?site_id=eq.${cms.site_id}&provider=eq.seo&key_name=eq.seo_core&select=id&order=updated_at.desc&limit=1`,{headers:supaHeaders(env,true)});
  const existing=find.ok?(await find.json())[0]:null;
  const payload={site_id:cms.site_id,provider:"seo",item_type:"other",label:"SEO Core Settings",key_name:"seo_core",value:JSON.stringify(settings),enabled:true};
  const save=existing
    ? await fetch(`${env.SUPABASE_URL}/rest/v1/site_identity_items?id=eq.${existing.id}`,{method:"PATCH",headers:supaHeaders(env,true),body:JSON.stringify(payload)})
    : await fetch(`${env.SUPABASE_URL}/rest/v1/site_identity_items`,{method:"POST",headers:supaHeaders(env,true),body:JSON.stringify(payload)});
  if(!save.ok)return Response.json({error:(await save.text())||"SEO settings could not be saved."},{status:save.status});
  return Response.json({ok:true,settings});
}
async function sitemapResponse(request,env){
  const origin=new URL(request.url).origin;
  const siteId=await sbSiteId(env);
  if(!siteId)throw new Error("SepticBeacon site record not found");
  const settings=await getSeoSettings(env,siteId);
  if(settings.sitemap_enabled===false)return new Response("Not found",{status:404});
  const results=await Promise.all([
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=slug&order=slug`),
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=slug,updated_at,published_at&order=updated_at.desc`)
  ]);
  const categories=results[0]||[],articles=results[1]||[];
  const staticUrls=settings.sitemap_include_static===false?[]:["/","/blog","/about.html","/contact.html","/privacy.html","/disclaimer.html","/editorial-policy.html","/how-we-review.html"];
  const urls=[
    ...staticUrls.map(path=>({loc:`${origin}${path}`})),
    ...(settings.sitemap_include_categories===false?[]:categories.map(c=>({loc:`${origin}/category/${c.slug}`}))),
    ...articles.map(a=>({loc:`${origin}/blog/${a.slug}`,lastmod:(a.updated_at||a.published_at||"").slice(0,10)}))
  ];
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(x=>`  <url><loc>${xmlEscape(x.loc)}</loc>${x.lastmod?`<lastmod>${xmlEscape(x.lastmod)}</lastmod>`:""}</url>`).join("\n")}\n</urlset>`;
  return new Response(xml,{headers:{"Content-Type":"application/xml; charset=UTF-8","Cache-Control":"public, max-age=900"}});
}

async function robotsResponse(request,env){
  const origin=new URL(request.url).origin;
  const settings=await getSeoSettings(env);
  if(settings.robots_enabled===false)return new Response("Not found",{status:404});
  const blocks=["User-agent: *","Allow: /","Disallow: /api/"];
  if(settings.allow_oai_searchbot!==false)blocks.push("","User-agent: OAI-SearchBot","Allow: /","Disallow: /api/");
  if(settings.extra_robots?.trim())blocks.push("",settings.extra_robots.trim());
  if(settings.sitemap_enabled!==false)blocks.push("",`Sitemap: ${origin}/sitemap.xml`);
  return new Response(blocks.join("\n")+"\n",{headers:{"Content-Type":"text/plain; charset=UTF-8","Cache-Control":"public, max-age=3600"}});
}

function withSecurityHeaders(response,{admin=false,html=false}={}){
  const h=new Headers(response.headers);
  h.set("Strict-Transport-Security","max-age=31536000; includeSubDomains; preload");
  h.set("X-Content-Type-Options","nosniff");
  h.set("Referrer-Policy","strict-origin-when-cross-origin");
  h.set("X-Frame-Options","DENY");
  h.set("Cross-Origin-Opener-Policy","same-origin");
  h.set("X-DNS-Prefetch-Control","off");
  h.set("Permissions-Policy","camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; "+
    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "+
    "img-src 'self' data: blob: https:; font-src 'self' data:; "+
    "connect-src 'self' https://jyqngstekzvurbirangl.supabase.co https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com"
  );
  if(admin){
    h.set("Cache-Control","no-store, max-age=0");
    h.set("Pragma","no-cache");
    h.set("X-Robots-Tag","noindex, nofollow, noarchive, nosnippet");
  }else if(html&&!h.has("Cache-Control")){
    h.set("Cache-Control","public, max-age=120, stale-while-revalidate=600");
  }
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}

async function processScheduledArticles(env){
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)return {published:0,skipped:0};
  const siteId=await sbSiteId(env);
  if(!siteId)return {published:0,skipped:0};

  const now=new Date().toISOString();
  const dueRes=await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${siteId}&status=eq.scheduled&scheduled_at=not.is.null&scheduled_at=lte.${encodeURIComponent(now)}&select=id,scheduled_at,first_published_at&order=scheduled_at.asc&limit=50`,
    {headers:supaHeaders(env,true)}
  );
  if(!dueRes.ok)throw new Error(await dueRes.text());
  const due=await dueRes.json();
  let published=0,skipped=0;

  for(const article of due){
    const gateRes=await fetch(
      `${env.SUPABASE_URL}/rest/v1/article_publish_gate?id=eq.${article.id}&select=can_publish&limit=1`,
      {headers:supaHeaders(env,true)}
    );
    if(!gateRes.ok){skipped++;continue}
    const gate=(await gateRes.json())[0];
    if(!gate?.can_publish){skipped++;continue}

    const publishedAt=new Date().toISOString();
    const patch={
      status:"published",
      published_at:publishedAt,
      first_published_at:article.first_published_at||publishedAt,
      scheduled_at:null
    };
    const updateRes=await fetch(
      `${env.SUPABASE_URL}/rest/v1/articles?id=eq.${article.id}&site_id=eq.${siteId}&status=eq.scheduled`,
      {
        method:"PATCH",
        headers:{...supaHeaders(env,true),Prefer:"return=minimal"},
        body:JSON.stringify(patch)
      }
    );
    if(!updateRes.ok){skipped++;continue}

    published++;
    await fetch(`${env.SUPABASE_URL}/rest/v1/jobs`,{
      method:"POST",
      headers:{...supaHeaders(env,true),Prefer:"return=minimal"},
      body:JSON.stringify({
        site_id:siteId,
        article_id:article.id,
        job_type:"post_publish",
        input:{actions:["revalidate","sitemap","link_check"],source:"scheduled_publish"}
      })
    }).catch(()=>{});
  }
  return {published,skipped};
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);

    // Force a single public origin for users and search engines.
    if(url.hostname==="www.septicbeacon.com"){
      const canonical=new URL(url);
      canonical.protocol="https:";
      canonical.hostname="septicbeacon.com";
      canonical.port="";
      return Response.redirect(canonical.toString(),301);
    }

    const clean=url.pathname.replace(/\/+$/,"")||"/";

    // Remote Model Context Protocol endpoint for SepticBeacon CMS.
    if(clean==="/mcp")return handleMcp(request,env);
    if(clean.startsWith("/oauth/")||clean.startsWith("/.well-known/oauth-"))return handleOAuth(request,env,clean);

    const adminBase="/sb-control-8n4k";
    const isPrivateAdmin=clean===adminBase || clean.startsWith(adminBase+"/");
    const isLegacyAdmin=
      clean==="/admin" || clean.startsWith("/admin/") ||
      clean.startsWith("/admin-") || /^\/admin[^/]*\.html$/i.test(clean);

    if(isLegacyAdmin){
      return new Response("Not found",{status:404,headers:{
        "Cache-Control":"no-store",
        "X-Robots-Tag":"noindex, nofollow, noarchive"
      }});
    }

    // Reject unexpected hosts and cross-site state-changing API requests.
    if(!["septicbeacon.com","www.septicbeacon.com","septicbeacon.enessboz2.workers.dev"].includes(url.hostname)){
      return new Response("Bad Request",{status:400});
    }
    if(
      clean.startsWith("/api/") &&
      !["GET","HEAD","OPTIONS"].includes(request.method) &&
      !isTrustedOrigin(request)
    ){
      return Response.json({error:"Cross-site request blocked."},{status:403});
    }

    // Keep one URL version for crawl efficiency and canonical consistency.
    if(url.pathname!=="/"&&url.pathname.endsWith("/")){
      const target=new URL(url);
      target.pathname=clean;
      return Response.redirect(target.toString(),301);
    }
    if(clean==="/index.html")return Response.redirect(new URL("/",url.origin).toString(),301);
    if(clean==="/article.html"||clean==="/category.html")return Response.redirect(new URL("/blog",url.origin).toString(),301);

    // API routes.
    if(clean==="/api/gsc/status")return gscStatus(request,env);
    if(clean==="/api/gsc/properties")return gscProperties(request,env);
    if(clean==="/api/gsc/property")return gscSelectProperty(request,env);
    if(clean==="/api/gsc/connect")return gscConnect(request,env,url);
    if(clean==="/api/gsc/callback")return gscCallback(request,env,url);
    if(clean==="/api/gsc/sync")return gscSync(request,env);
    if(clean==="/api/ga4/status")return ga4Status(request,env);
    if(clean==="/api/ga4/connect")return ga4Connect(request,env,url);
    if(clean==="/api/ga4/callback")return ga4Callback(request,env,url);
    if(clean==="/api/ga4/properties")return ga4Properties(request,env);
    if(clean==="/api/ga4/property")return ga4SelectProperty(request,env);
    if(clean==="/api/ga4/sync")return ga4Sync(request,env);
    if(clean==="/api/media/generate")return mediaGenerate(request,env);
    if(clean==="/api/media/list")return mediaList(request,env);
    if(clean==="/api/media/upload")return mediaUpload(request,env,url);
    if(clean==="/api/media/delete")return mediaDelete(request,env,url);
    if(clean==="/api/media/meta")return mediaMeta(request,env,url);
    if(clean==="/api/seo/settings")return seoSettingsApi(request,env);

    if(clean.startsWith("/demo-media/")){
      return embeddedDemoMedia(clean.slice("/demo-media/".length));
    }

    if(clean.startsWith("/media/")){
      const key=decodeURIComponent(clean.slice("/media/".length));
      return serveMedia(env,key);
    }

    // SEO infrastructure.
    if(clean==="/robots.txt")return await robotsResponse(request,env);
    if(clean==="/sitemap.xml"){
      try{return await sitemapResponse(request,env)}
      catch(e){return new Response("Sitemap unavailable",{status:503})}
    }

    const [verification,identityItems]=await Promise.all([
      getVerification(env),
      getIdentityItems(env)
    ]);

    // Verification files.
    if(
      verification?.html_filename &&
      clean===`/${String(verification.html_filename).replace(/^\/+/,"")}`
    ){
      return new Response(verification.html_content||"",{
        headers:{"Content-Type":"text/html; charset=UTF-8","Cache-Control":"public, max-age=300"}
      });
    }
    const identityFile=(identityItems||[]).find(x=>
      x.item_type==="html_file" &&
      x.key_name &&
      clean===`/${String(x.key_name).replace(/^\/+/,"")}`
    );
    if(identityFile){
      return new Response(identityFile.value||"",{
        headers:{"Content-Type":"text/html; charset=UTF-8","Cache-Control":"public, max-age=300"}
      });
    }

    const protectedAdmin=isPrivateAdmin;

    // Database-backed redirects now actually work.
    if(
      request.method==="GET" &&
      !protectedAdmin &&
      !clean.startsWith("/api/") &&
      !/\.[a-zA-Z0-9]{2,6}$/.test(clean)
    ){
      const redirect=await findRedirect(env,clean);
      if(redirect?.destination_path){
        const code=[301,302,307,308].includes(Number(redirect.status_code))?Number(redirect.status_code):301;
        return Response.redirect(new URL(redirect.destination_path,url.origin).toString(),code);
      }
    }

    if(clean==="/guides"||clean==="/guides.html"||clean==="/blog.html"){
      return Response.redirect(new URL("/blog",url.origin).toString(),301);
    }

    const routes={
      "/":"/index.html",
      [adminBase]:"/admin.html",
      [adminBase+"/login"]:"/admin-login.html",
      [adminBase+"/articles"]:"/admin-articles.html",
      [adminBase+"/quick-entry"]:"/admin-editor.html",
      [adminBase+"/media"]:"/admin-media.html",
      [adminBase+"/topic-map"]:"/admin-topic-map.html",
      [adminBase+"/calendar"]:"/admin-calendar.html",
      [adminBase+"/refresh"]:"/admin-refresh.html",
      [adminBase+"/seo"]:"/admin-seo.html",
      [adminBase+"/gsc"]:"/admin-gsc.html",
      [adminBase+"/ga4"]:"/admin-ga4.html",
      [adminBase+"/opportunities"]:"/admin-opportunities.html",
      [adminBase+"/internal-links"]:"/admin-internal-links.html",
      [adminBase+"/crawl"]:"/admin-crawl.html",
      [adminBase+"/site-health"]:"/admin-site-health.html",
      [adminBase+"/redirects"]:"/admin-redirects.html",
      [adminBase+"/analytics"]:"/admin-analytics.html",
      [adminBase+"/integrations"]:"/admin-integrations.html",
      [adminBase+"/alerts"]:"/admin-alerts.html",
      [adminBase+"/ai-jobs"]:"/admin-ai-jobs.html",
      [adminBase+"/ai-content"]:"/admin-ai-content.html",
      [adminBase+"/work-flow"]:"/admin-work-flow.html",
      "/blog":"/guides.html"
    };

    let response=null;
    let routeType="static";
    let routeData=null;

    if(routes[clean]){
      response=await env.ASSETS.fetch(new Request(new URL(routes[clean],url),request));
      if(clean==="/"){
        routeType="home";
        try{routeData=await getHomeData(env)}catch{}
      }else if(clean==="/blog"){
        routeType="guides";
        try{routeData=await getGuidesData(env)}catch{}
      }
    }

    const categoryMatch=clean.match(/^\/category\/([^/]+)$/);
    if(!response && categoryMatch){
      routeType="category";
      try{routeData=await getPublicCategory(env,decodeURIComponent(categoryMatch[1]))}catch{}
      if(!routeData){
        const notFound=await env.ASSETS.fetch(new Request(new URL("/404.html",url),request));
        response=new Response(notFound.body,{status:404,headers:notFound.headers});
        routeType="404";
      }else{
        response=await env.ASSETS.fetch(new Request(new URL("/category.html",url),request));
      }
    }

    // Canonical article route: /blog/article-slug
    const blogArticleMatch=clean.match(/^\/blog\/([^/]+)$/);
    if(!response && blogArticleMatch){
      const slug=decodeURIComponent(blogArticleMatch[1]);
      routeType="article";
      try{routeData=await getPublicArticle(env,slug)}catch{}
      if(!routeData){
        const notFound=await env.ASSETS.fetch(new Request(new URL("/404.html",url),request));
        response=new Response(notFound.body,{status:404,headers:notFound.headers});
        routeType="404";
      }else{
        response=await env.ASSETS.fetch(new Request(new URL("/article.html",url),request));
      }
    }

    // Legacy /category-slug/article-slug -> /blog/article-slug
    const oldArticleMatch=clean.match(/^\/([^/]+)\/([^/]+)$/);
    if(!response && oldArticleMatch && oldArticleMatch[1]!=="blog" && !clean.startsWith("/admin/") && !clean.startsWith("/category/")){
      const oldSlug=decodeURIComponent(oldArticleMatch[2]);
      let oldArticle=null;
      try{oldArticle=await getPublicArticle(env,oldSlug)}catch{}
      if(oldArticle){
        return Response.redirect(new URL(`/blog/${encodeURIComponent(oldSlug)}`,url.origin).toString(),301);
      }
    }

    // Legacy root /article-slug -> /blog/article-slug
    const rootArticleMatch=clean.match(/^\/([^/]+)$/);
    const reservedSingle=new Set(["admin","guides","blog","robots.txt","sitemap.xml"]);
    if(!response && rootArticleMatch && !reservedSingle.has(rootArticleMatch[1]) && !clean.includes(".")){
      const slug=decodeURIComponent(rootArticleMatch[1]);
      let rootArticle=null;
      try{rootArticle=await getPublicArticle(env,slug)}catch{}
      if(rootArticle){
        return Response.redirect(new URL(`/blog/${encodeURIComponent(slug)}`,url.origin).toString(),301);
      }
    }

    // Static assets/pages.
    if(!response){
      const knownStatic=/\.(?:html|css|js|png|jpg|jpeg|webp|svg|ico|txt|xml)$/i.test(clean);
      if(knownStatic){
        response=await env.ASSETS.fetch(request);
      }else{
        const notFound=await env.ASSETS.fetch(new Request(new URL("/404.html",url),request));
        response=new Response(notFound.body,{status:404,headers:notFound.headers});
        routeType="404";
      }
    }

    const isHtml=response.headers.get("content-type")?.includes("text/html");
    if(!isHtml)return withSecurityHeaders(response,{admin:protectedAdmin,html:false});

    const rw=new HTMLRewriter();

    rw.on("head",{
      element(el){
        const added=new Set();

        const gscToken=normalizeGoogleVerificationToken(verification?.meta_token);
        if(gscToken){
          const safe=escapeHtml(gscToken);
          el.append(`<meta name="google-site-verification" content="${safe}">`,{html:true});
          added.add("google-site-verification");
        }

        for(const item of (identityItems||[])){
          if(item.item_type!=="meta"||!item.key_name||!item.value)continue;
          const name=String(item.key_name);
          if(added.has(name))continue;
          el.append(`<meta name="${escapeHtml(name)}" content="${escapeHtml(item.value)}">`,{html:true});
          added.add(name);
        }

        if(protectedAdmin){
          el.append('<meta name="robots" content="noindex,nofollow"><style>html{visibility:hidden}</style>',{html:true});
        }else if(
          clean==="/search.html" ||
          clean==="/article.html" ||
          clean==="/category.html" ||
          routeType==="404"
        ){
          el.append('<meta name="robots" content="noindex,follow">',{html:true});
        }

        if(routeType==="article"&&routeData){
          const canonical=new URL(`/blog/${routeData.slug}`,url.origin).href;
          const description=routeData.meta_description||routeData.excerpt||"";
          const ogImage=routeData.featured_image_url?new URL(routeData.featured_image_url,url.origin).href:null;
          const categoryName=routeData.categories?.name||"Septic Guides";
          const categorySlug=routeData.categories?.slug||"guides";
          const jsonLd={
            "@context":"https://schema.org",
            "@graph":[
              {
                "@type":"BlogPosting",
                "@id":canonical+"#article",
                headline:routeData.title,
                description,
                url:canonical,
                mainEntityOfPage:{"@type":"WebPage","@id":canonical},
                datePublished:routeData.published_at||undefined,
                dateModified:routeData.updated_at||routeData.published_at||undefined,
                articleSection:categoryName,
                ...(ogImage?{image:[ogImage]}:{}),
                author:{"@type":"Organization","name":"SepticBeacon Editorial Team","url":url.origin+"/how-we-review.html"},
                publisher:{"@type":"Organization","name":"SepticBeacon","url":url.origin}
              },
              {
                "@type":"BreadcrumbList",
                "@id":canonical+"#breadcrumb",
                itemListElement:[
                  {"@type":"ListItem","position":1,"name":"Home","item":url.origin+"/"},
                  {"@type":"ListItem","position":2,"name":"Blog","item":url.origin+"/blog"},
                  {"@type":"ListItem","position":3,"name":categoryName,"item":url.origin+"/category/"+categorySlug},
                  {"@type":"ListItem","position":4,"name":routeData.title,"item":canonical}
                ]
              }
            ]
          };
          el.append(
            `<meta property="og:type" content="article">`+
            `<meta property="og:title" content="${escapeHtml(routeData.seo_title||routeData.title)}">`+
            `<meta property="og:description" content="${escapeHtml(description)}">`+
            `<meta property="og:url" content="${escapeHtml(canonical)}">`+
            `${ogImage?`<meta property="og:image" content="${escapeHtml(ogImage)}">`:""}`+
            `<meta name="twitter:card" content="${routeData.featured_image_url?"summary_large_image":"summary"}">`+
            `${isPublicReadyArticle(routeData)?`<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">`:`<meta name="robots" content="noindex,follow">`}`+
            `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,"\\u003c")}</script>`,
            {html:true}
          );
        }
      }
    });

    if(routeType==="article"&&routeData){
      const title=`${routeData.seo_title||routeData.title} | SepticBeacon`;
      const description=routeData.meta_description||routeData.excerpt||"Practical septic maintenance and troubleshooting guidance for homeowners.";
      const canonical=new URL(`/blog/${routeData.slug}`,url.origin).href;

      rw.on("title",{element(el){el.setInnerContent(title)}});
      rw.on('meta[name="description"]',{element(el){el.setAttribute("content",description)}});
      rw.on('link[rel="canonical"]',{element(el){el.setAttribute("href",canonical)}});
      rw.on("main",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(articleHtml(routeData),{html:true})}});
    }

    if(routeType==="category"&&routeData){
      const c=routeData.category;
      const description=c.description||`Practical ${c.name} septic maintenance and troubleshooting guides.`;
      const canonical=new URL(clean,url.origin).href;
      rw.on("title",{element(el){el.setInnerContent(`${c.name} Septic Guides | SepticBeacon`)}});
      rw.on('meta[name="description"]',{element(el){el.setAttribute("content",description)}});
      rw.on('link[rel="canonical"]',{element(el){el.setAttribute("href",canonical)}});
      rw.on("head",{element(el){
        const schema={"@context":"https://schema.org","@graph":[
          {"@type":"CollectionPage","name":c.name+" Septic Guides","description":description,"url":canonical},
          {"@type":"BreadcrumbList","itemListElement":[
            {"@type":"ListItem","position":1,"name":"Home","item":url.origin+"/"},
            {"@type":"ListItem","position":2,"name":"Septic Topics","item":url.origin+"/#systems"},
            {"@type":"ListItem","position":3,"name":c.name,"item":canonical}
          ]}
        ]};
        el.append(
          `<link rel="canonical" href="${escapeHtml(canonical)}">`+
          `<meta property="og:type" content="website">`+
          `<meta property="og:title" content="${escapeHtml(c.name)} Septic Guides | SepticBeacon">`+
          `<meta property="og:description" content="${escapeHtml(description)}">`+
          `<meta property="og:url" content="${escapeHtml(canonical)}">`+
          `<meta name="twitter:card" content="summary">`+
          `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">`+
          `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,"\\u003c")}</script>`,
          {html:true}
        );
      }});
      rw.on("main",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(categoryHtml(routeData),{html:true})}});
    }

    if(routeType==="home"&&routeData){
      rw.on("#live-home-categories",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(homeCategoriesHtml(routeData.categories||[]),{html:true})}});
      rw.on("#live-home-articles",{element(el){el.setInnerContent(homeArticlesHtml(routeData.articles||[]),{html:true})}});
      rw.on("#live-home-popular",{element(el){el.setInnerContent(homePopularHtml(routeData.articles||[]),{html:true})}});
      rw.on("head",{element(el){
        const canonical=new URL("/",url.origin).href;
        const homeSchema={"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"SepticBeacon","url":canonical},{"@type":"Organization","name":"SepticBeacon","url":canonical}]};
        el.append(`<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary"><meta name="robots" content="index,follow,max-image-preview:large"><script type="application/ld+json">${JSON.stringify(homeSchema).replace(/</g,"\\u003c")}</script>`,{html:true});
      }});
    }else if(routeType==="guides"&&routeData){
      rw.on("#blog-index-live",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(guidesHtml(routeData),{html:true})}});
      rw.on('meta[name="robots"]',{element(el){el.setAttribute("content","index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1")}});
      rw.on("head",{element(el){
        const canonical=new URL("/blog",url.origin).href;
        const list=(routeData.articles||[]).slice(0,20).map((a,i)=>({"@type":"ListItem","position":i+1,"url":new URL("/blog/"+a.slug,url.origin).href,"name":a.title}));
        const schema={"@context":"https://schema.org","@graph":[
          {"@type":"Blog","@id":canonical+"#blog","name":"SepticBeacon Blog","description":"Practical septic maintenance, troubleshooting, cost and inspection guides for homeowners.","url":canonical,"publisher":{"@type":"Organization","name":"SepticBeacon","url":url.origin}},
          {"@type":"ItemList","@id":canonical+"#articles","itemListElement":list}
        ]};
        el.append(
          `<link rel="canonical" href="${escapeHtml(canonical)}">`+
          `<meta property="og:type" content="website"><meta property="og:title" content="SepticBeacon Blog | Septic Maintenance & Homeowner Guides"><meta property="og:description" content="Practical septic maintenance, troubleshooting, cost and inspection guides built around real homeowner questions."><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary">`+
          `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,"\\u003c")}</script>`,
          {html:true}
        );
      }});
    }else if(["/about.html","/contact.html","/privacy.html","/disclaimer.html","/editorial-policy.html","/how-we-review.html"].includes(clean)){
      rw.on("head",{element(el){el.append(`<link rel="canonical" href="${escapeHtml(new URL(clean,url.origin).href)}">`,{html:true})}});
    }

    rw.on('a[href="/guides"]',{element(el){el.setAttribute("href","/blog")}});
    rw.on('a[href="/guides.html"]',{element(el){el.setAttribute("href","/blog")}});
    const transformed=rw.transform(response);
    return withSecurityHeaders(transformed,{admin:protectedAdmin,html:true});
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil(processScheduledArticles(env));
  }
};
