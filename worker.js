import { handleMcp, handleOAuth } from "./mcp.js";
import { generateArticleImage } from "./mcp-media.js";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const RVF_PUBLIC_ANON_KEY="sb_publishable_pXOcXb8-JQqUSBcC14hm7A_Qnl5KThq";
let RVF_SITE_ID_CACHE=null;

async function rvfSiteId(env){
  if(RVF_SITE_ID_CACHE)return RVF_SITE_ID_CACHE;
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)return null;
  const r=await fetch(`${env.SUPABASE_URL}/rest/v1/sites?domain=eq.rvfixwise.com&select=id&limit=1`,{
    headers:supaHeaders(env,true)
  });
  if(!r.ok)return null;
  const row=(await r.json())[0];
  RVF_SITE_ID_CACHE=row?.id||null;
  return RVF_SITE_ID_CACHE;
}

function supaHeaders(env, service=false, userToken=null){
  const key = service ? env.SUPABASE_SERVICE_ROLE_KEY : (env.SUPABASE_ANON_KEY||RVF_PUBLIC_ANON_KEY);
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
    const siteId=await rvfSiteId(env);
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
    const siteId=await rvfSiteId(env);
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

  const anon=env.SUPABASE_ANON_KEY||RVF_PUBLIC_ANON_KEY;
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
  const requestedSite=String(request.headers.get("X-RVF-Site-ID")||"").trim();
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
  return Response.redirect(`${url.origin}/rvf-control-8n4k/ga4?ga4_connected=1`,302);
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

  return Response.redirect(`${url.origin}/rvf-control-8n4k/gsc?connected=1`,302);
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
        <p>Quick answers to the questions RV owners usually ask after working through this guide.</p>
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
  const siteId=await rvfSiteId(env);
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
  const siteId=await rvfSiteId(env);
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
  const prompt=escapeHtml('RVFixWise: Please summarize this page in English. Focus on the main problem, the diagnostic sequence, safety warnings, likely causes, checks to perform before replacing parts, and the most useful next steps. Keep the summary practical and easy to scan.');
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
  return '<section class="rvf-ai-tools" aria-label="AI reading tools"><div class="rvf-ai-tools-copy"><span>AI READING TOOLS</span><strong>Ask an AI to summarize this RVFixWise guide</strong><p>The current article URL is included automatically. If a provider does not support URL prompt prefill, the complete prompt is copied to your clipboard before it opens.</p></div><div class="rvf-ai-tools-actions">'+buttons+'</div><div class="rvf-ai-copy-status" aria-live="polite"></div></section>';
}

function articleRelatedSidebarHtml(a){
  const related=Array.isArray(a.related)?a.related.slice(0,3):[];
  if(!related.length)return "";
  const links=related.map(function(item){ return '<a href="/blog/'+escapeHtml(item.slug)+'"><b>'+escapeHtml(item.title)+'</b><small>'+escapeHtml((item.categories&&item.categories.name)||"RV Guide")+'</small></a>'; }).join("");
  return '<div class="rvf-side-card rvf-side-related"><span>MORE RVFIXWISE GUIDES</span><strong>Keep reading</strong><div class="rvf-side-related-list">'+links+'</div></div>';
}

function articleRelatedBottomHtml(a,category){
  const related=Array.isArray(a.related)?a.related.slice(0,3):[];
  if(!related.length)return '<div class="rvf-related-grid"><a href="/category/'+escapeHtml(category.slug||"guides")+'"><small>MORE FROM THIS SYSTEM</small><strong>'+escapeHtml(category.name||"RV Guides")+'</strong><i>→</i></a><a href="/guides"><small>GUIDE LIBRARY</small><strong>Browse all RV guides</strong><i>→</i></a></div>';
  const cards=related.map(function(item){ const media=item.featured_image_url?'<div class="rvf-related-article-media"><img src="'+escapeHtml(item.featured_image_url)+'" alt="'+escapeHtml(item.featured_image_alt||"")+'" loading="lazy"></div>':'<div class="rvf-related-article-media is-fallback"><span>'+escapeHtml((item.categories&&item.categories.name)||"RV")+'</span></div>'; return '<a class="rvf-related-article" href="/blog/'+escapeHtml(item.slug)+'">'+media+'<div class="rvf-related-article-copy"><small>'+escapeHtml((item.categories&&item.categories.name)||"RV Guide")+'</small><strong>'+escapeHtml(item.title)+'</strong><span>Read guide →</span></div></a>'; }).join("");
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
            <span class="badge">${escapeHtml(category.name||"RV Guide")}</span>
            <h1>${escapeHtml(a.title)}</h1>
            ${a.excerpt?`<p class="rvf-blog-feature-deck">${escapeHtml(a.excerpt)}</p>`:""}
            <div class="rvf-blog-byline">
              <span class="rvf-author-mark">R</span>
              <span>
                <b>RVFixWise Editorial Team</b>
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
        ${a.excerpt?`<section class="rvf-quick-summary"><span>QUICK ANSWER</span><p>${escapeHtml(a.excerpt)}</p></section>`:""}

        ${articleAiToolsHtml(a)}

        <article class="rvf-prose">
          ${bodyHtml}

          <div class="article-end-note">
            <strong>RVFixWise editorial note</strong>
            <p>This guide is educational. Stop and use a qualified RV technician when a procedure involves unsafe electrical, propane, structural or pressurized-system work beyond your experience.</p>
          </div>
        </article>

        <section class="rvf-related-block" aria-label="Related RV guides">
                  <div class="rvf-related-head"><span>KEEP READING</span><h2>Related RV guides</h2></div>
                  ${articleRelatedBottomHtml(a,category)}
                </section>

        <section class="rvf-blog-cta">
          <div><span>RVFIXWISE</span><h2>Diagnose first. Replace parts second.</h2><p>Use the guide library to continue troubleshooting by symptom or RV system.</p></div>
          <a class="btn lime" href="/guides">Find the next guide</a>
        </section>
      </main>

      <aside class="rvf-blog-right">
        <div class="rvf-ad-reserved" hidden data-ad-placement="article-rail-1"></div>
        ${articleRelatedSidebarHtml(a)}
        <div class="rvf-side-card">
          <span>NEED ANOTHER PATH?</span>
          <strong>Browse by RV system</strong>
          <p>Jump to plumbing, electrical, HVAC, maintenance and more.</p>
          <a href="/">Explore systems →</a>
        </div>
      </aside>
    </div>
  </section>`;
}
function categoryHtml(data){
  const c=data.category,articles=data.articles||[];
  const categoryArt=categoryImage(c.slug,c.name);
  return `<section class="category-hero"><div class="wrap">
    <div class="breadcrumb"><a href="/">Home</a> / RV Systems / ${escapeHtml(c.name)}</div>
    <div class="category-hero-card">
      <div class="category-hero-copy">
        <div class="kicker"><span class="dot"></span> ${escapeHtml(c.name)}</div>
        <h1>${escapeHtml(c.name)} RV guides</h1>
        <p>${escapeHtml(c.description||"Practical troubleshooting and maintenance guidance for this RV system.")}</p>
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
            <p>${escapeHtml(a.excerpt||"Open this practical RV guide.")}</p>
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
  const siteId=await rvfSiteId(env);
  if(!siteId)return {categories:[],articles:[]};
  const [categories,articles]=await Promise.all([
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=id,name,slug,description&order=sort_order&limit=12`),
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=title,slug,excerpt,content_type,published_at,featured_image_url,featured_image_alt,categories(name,slug)&order=published_at.desc&limit=12`)
  ]);
  return {categories,articles:articles||[]};
}

async function getGuidesData(env){
  const siteId=await rvfSiteId(env);
  if(!siteId)return {articles:[],categories:[]};
  const results=await Promise.all([
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=title,slug,excerpt,content_type,published_at,updated_at,featured_image_url,featured_image_alt,categories(name,slug)&order=published_at.desc&limit=120`),
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=name,slug,description,sort_order&order=sort_order.asc.nullslast,name.asc`)
  ]);
  return {articles:results[0]||[],categories:results[1]||[]};
}

const RVF_CATEGORY_IMAGES={"electrical": "data:image/webp;base64,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", "plumbing": "data:image/webp;base64,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", "hvac": "data:image/webp;base64,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", "appliances": "data:image/webp;base64,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", "slide-outs": "data:image/webp;base64,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", "chassis-towing": "data:image/webp;base64,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", "maintenance": "data:image/webp;base64,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", "tools-parts": "data:image/webp;base64,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", "repair-guides": "data:image/webp;base64,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", "rv-systems": "data:image/webp;base64,UklGRrwjAABXRUJQVlA4WAoAAAAQAAAAAwEA2wAAQUxQSMQMAAABymDQtpGkhD/s2e30HgARMQH8uOtC1byz1MfAniFeI3NC2zXkqTO0uM3OMgOeage0CJ0gZ2GFgipO5uboPnGLChmQ3SPLER26KpHhcAmY807TRA/Ytpm1bWtb0lrmnMu2bdu2OYxl27Zt2+7u03bHtG3bSaXyHEdSSdNdtbzW8zwVEbJgW4kD6aFxQ4c4STeSjf6VJEmSYytX5FzcgB3LL9Dicv9bzke8KZGZwxJLsIiABEly22YMRZrgCXHvAIc3/0NA//cff1kj7fWzGFXFA1JnB4WD06ZREg9Jo4ajSdy2be/x1I3v/eov/zKlOjM7x1N/k7lFnp+pZZhfmOPpKMJRdGExSi1ElHmdE4fiVOR55cjMuqBzKsy1KCK1vI4UcUrnFmf+xrPCLMqRp/7462+8b9PjbtdzmoJQkaokzDd44gf+duw15Bldcthv3vbI6zkV3ucS5ju8YfYMEpHKFDlLN2lNA4RQV4IO6pZvNBosFbOUDuupv113s2b3Pc9t84K/XUoiMS9MtC2qJkRtmTsE79gFO6R0USVvWM/5yeMadl+hzDd6y6EkUkjN212jTK0dU/PKSogiJLLD81JPMz3mm3z4lIE1XDESgmNI0xKZY9N9aU0dUu96ZYm+/uQ6Z2zVHq+JYARav2VRkn2eVld6V/vIfUny0nacLR5S9x5bU5D87OZ+VSpv+9GrKTeW26j8p4bhxBcm3PMoPvBAsoVz1E0WUDa6mTE5yW9vmmS+rEeSDZfVvSBOPCfanY68rx+hx/xxqgqgnFfLrSsveE7S9yFe9w9k6toqTGQL4rckWQofb7A75XUuXFRaeVeSocdr70bXBCROs5SPYv+7KV933o2hCx9BzqZ9XhzUGq4hXgMcIn/JzYcvlNc8PlHYuLHOBxFs5Jw7gmqqfX7Q5WV0cyGsOuA6mkIyXfcIKkIZmXP6JmSV8jeCOELOITBTIfL0ONqiDCNaOhodem24qrS33SF1XY1wktBn4RLld0oe1sjWXH2fFGtASW9xnjUOgppMgSXKX6zT0MKW/AiokPItLqpKB4FNfg+loGX87rpPSHEK8FZX3R0ppNc6tjLMQUWRSQaUvkxMy24dVir59BsmqY8um6eiCjFZofUwSY/veEVVhhozMA0Zv7UeOcjgkq+4M0oQ3jGA5UWM/40gxTS5+UVUenGtMpZUvwdRz5SfTcaiI0fgicrx22F0zvjjkC1It3DvesdcPgijQXi6ZbeyiEDcW7bQqyAa0mSbo8XAztMFZH8uX4VAj+/U1kogp8kfQwsQhT4/qeZEhruxpRzRR2DMeLOjleD+2lTsCAFp2w1auOAWGHhvJ3xIQARJ1tiyMvdFKGZ5fcZg12OGB7ZgN5cla1jpKQjameaNPVmW9bCAKxhZvRQDb/2RjbxYJrSxHgN3FYch+uq8SOiil3cabxX+GgQh0kfAByeP3Y8jDDag4Nl1RZJoFrRsBilcldqjnatUDlsx8MEHz43EjIy2YOCjAYh2vJWzMfgbx66lfMM2WBcyFoR4CMo7nIE+2ZJLvI3T7bMOmv/hvYjcsKDgySwKVZa4mktl9JECpfwod47obr4MzOY9j9hRGiYERz+lbAmVPDTsLBP/0K7QJhS95IlUkIhmQetWfv35+ESCa1bVZU+1sL2Img0oeKaIByHZsVYnHq3Z348AGWSZQzKvT+gdO5x1yuPLk6EULSy5PcFImM6AsGOaEGodoQVa7Y5U8Ay1ldY0AuVmdCYM89iAOPJBymnypW7pHJDwqW3SphsYFNMO83Vd4mBYB1ajV9mEsflIYOx3YprshBfqLAlYstEDuwUy8FbSPZzEV+rZySdSlOqvW3YuW02q9hNifL8BSWZjzSj1HmeX/IldhQwE52Kejrf994w4POMzC8nXZwSGDMXnSF4Nr2cX70Vm2t+VbyXJOt22UWlUYzK00yfAgUaHYsGGxJUjUZCJv4pjy8Wc0hzP0VaB6bpGwdj1vPnIlsOtJHA4ulsHhPItTX8xdXiHpTABprDXlo7T7aCMVXrdLaBd1wDnXLsj4s5ds8DYbi6+70HstxmUzfsRlsPxlgWGnwJ7ndOGBNmzGea6xkxqhXIjDQALlgMIyzjm8G6Cs3MJ8QpDPg7e/vuPjRhHLgQ2FA4D2FrtU082wHDy1nn6MdOnX16e7Xe9wWySbj6wTdzisxjbvZKrYa9lcwDgaG6nCNDXtes+qK8XBHso4gCFPoUF6KfaxXCpAun/v02huDfUK4tyoMEexCmj5z+EHj9LEjrr/75gqEA2h/D0krCsxPu7ZWauHROPBcllQWpvsSPj4B/uBsnlXfF2EWGl1Nx7xcOM7W3U93a8EkQvCc9zlcUxHBS2/J0ANrlvbbVIz894CBC65BQ0A0ULm3x5diSIeWMbhWe/Wu7Tc9ZwZ7Qu+6IQ2oB7T+B8/yNWcT/dkqoc6LmJ/4RQSlrnEcfsv7f9OnzYsvw6om6YGHdL8n75CHGtd/0CpC9fl/luN1+ud5eUDYUDfg1U0yJ5Cg1myYwXGcM8phWI4S+43ogHwlwpHpPgiDZ2C2RMIDP6R1bLypEMXCtA9RIk246keeiNBbFzqK/vnkCa8himCwG0TjETPB0GenXEpNG5FocF6BkiKHV788TL3yl8tU1hsukv3zrbRc+78AZ6ixQFs2R8MlQKWE/vOLqZh9d2iBAkDtJ7mQoPL2zuhqqsAwiNlQJ0f+zY59LbKdkTmP6+vklAfIhgMFhDfJvF5/c2SuM1osEZQ6wzENSa3Z9OGjDH93s/JCARpqlxf0eQFsy9APN4tvfLLgw+l/WDIS4M79+ATWraTQ8jYA0G3o3x3Ogx/sUNQmxBLwNZs0upOhFjnEUyBYMj1/y9TMplmTaktaVti13p0XFw2ezBtR1aszh3JcKkOphlQ/FepvuXJwcHIrduFIHeVIhPxWHgZ2MCfsFQj7zEaa00XoqAjL9O+diwvyVcdkKMiJGnY+DDKCiH1r3KHmQhFT3VwzDwKilGOAeQqcpMxmQitHblPGm2IFPy1XdPegjVz6By9J8D9fS7JquW2hdzS1dxpMco590sSRH0knsXZMd6DozIAFFgcgQIR47sIyBNrncaxXH02DbOjiMy6CLZckHzTRkh7E5m1LmZNLfSROxPhhJCk8jl0xgfz4z83e4XcGw9U7Uy2VTN6SIClF6U9DHwainGd7wQVLpW3x2CVFZXgDhjIfzAQbpzC2K0/9sQQ0spJxjV2x1POux5Ah2QSFgJuXwJ5cPSkb8j+bBHA2KzQIOjmrB91k8tcymPQ3E5QPkpYiZ5RvAmsP2ELfruo7etCyjF46gcQkVO3JbrJLteCLkifWw/8uc6PhXnRWYi1u3fb3gwjvcNPb7XNZYHThfcNj0gy30xok9meN+0Y2SUb8Eg2a/HimXDoaJtw0RhfjqVuCiDGUYvHEQ+4To1N1CiK1WBegvQ4BQPQdJK35pkzEjJWikQfv+MAEWjSzwUJz3tBk0KlewPEJCoyhTRfEKhVyd9ZqzkEUbRvjNPlrmKVNCBeK5yKn+NCrTbmUocU2niY9BS5rR3/eMrw1A8ycDlg9qtgr4+TPSI6RYWF34TnaHjrgfpNGrGX6Q8mN4W1HWg3nylmu0FFYLDORX07iSiOjd3hzPJBPDbsWw5l1+184g8j7rcmuABTdxlO2APcjN+rrGlX1OJaG4H3zhJEwYOawpbwp9wBkePuE1jw4YOrwoyWAeN32Xr/O0aJvDwnMupmPCcTiJh4nZpB8a9b9pE+PCIU6jAQJaImmUZ6Y/Xa6IH4fa7UWksM08YRRLfte/Kx5KBPXwvmn2VJB85INF3UsW+rzOfn3jjVrUwP+d4MsXIz/Nc7WpWSP56+yTzylnkm3yfpDATnT/Or9cihynkjM1J1xiecPGTdycpxI51ueG7imHL3NLlX79V0hMP/YZes0JS5tHy5HLMGKqZKUj0Z3fvqPWrMk2ytXu6rkN3LMMngUld1Wvvoo3CJOd/78HNPHjrQDU/+vtnk4jtciF7+BlrZBr9ufpxPI7fNnY5FFVJRA58+62TAb2868QJ33TNz493XQnPmQsRUS1VNTqkI5AMEEKkayRpS+32G0bSTmfCr176zMObo6DnuVPtDfu1HvWBxZNz8o4uO+yXm+/maItpCDxrd34GXveez3rdJ77319322e+Apbh/PDDK6ko8WJZjXI0rS8r7K4sjzLKKCO9Xi7cShRsS3nuv/fbdI+6/D+9XC6EHiERdXj2gFk1EmFVVWHjfuKJLetDBB+6xy1++9+EtT7h9z6mRv+8u5jOrSoj+1ABVZk54GMvJELKkPEAKh5qRuqVMhxY8lZH/2IDQ/IfE86P8m4sCVlA4INIWAADwZACdASoEAdwAPok8mUklIyWhJ7G8oLARCU3caIxL+hA3rdV5d91+Hpf7da/yPNxfm/2vqY8wD7N/XQ9X3mL/a71oPTh/lPUA/zvUv+hR5eHsxf4P/zdQB//+AD8xf47td/2/cW+tf1n5jc397f8jfzPOnvN+XGoF+Qfzj/VekJ9V2iW1eYF7f/UvPUmWfYOoBwMNAD9R/9j1VM+D6D/tfYP/YbrcHrstNpwaH2778MsKXqLHFw01JmfCp3QRs15Ng/LfcIf1yBRMmU79s4LhScnTs1RaIa/3okSClyPsPwVy91qqMvYBP8q+r+dsSiKGtt3cmLfVU7u7fuc4rV7m1nUdhUod2ikfyxhbYQ5IluDPs17IInK+CMCoeILIrBJPhd1/jthrrt1Iw38aHr0oDV7ZBSx7HpKZlIfi6CJBxHnBLLZX4KRYGowqEXhai/1nlyUtjv96KGfm2dxnRuwEBukDjckPcF381yQ07IPrOjWpO5CyFEs2lG7rkXDOGhQo5sK+NmzbA1fnV8DIwVCnqrlN000dLmCk1vk1/LL54be4nhGDaWNPxQoTEH6XwUfWqq82Ut1NW6lcpcpu1zDWK+53YDsI2AavyqWrDsJf9rgB28Opdl0fbHCKpDvk4f29NvriyCcvgaSyslXV64+8wBd+UDrHwzoVHcMdnWqi2DWEA90O8ewn5Vwx9vei9ZFKTSfEJazKr55bahJBQ1V19FojEVAFxaDBaIxAudSh+TRIWtaRAIB/MWjLq1j8byrFCjao7Otxe77TRq10Kvw3N09wAJbyfnG+GF4SCciF9mF5/6Gr5Lu/410KExxnQwVNpXMxydhYYoTUu0piAlpqdFpdAfz43FgW30HAubuz6lRbTapxdAFd3Dd+sbyRcAjM10UHnRRgajhxNtS36LqidiQusd6jo1OFHGL8h1MZH+p1wdJICnaPATXMOxCcTgx0i1kuqG3jAzkwdfDE7gpV8kDNf+FTb4RHHNAYPLwpfydAU95qHQ9+OZGwKeePHU73A+/qpDCZOszAHWa9NJogFcA6xhuMKC7ek5Dc/+yO78FPOB1XNyc/PX4fib5YFAAA/vxc0AAAApHtU0XPsSQzh7VK7SMAYuAJtKwaxXV/CX+C0kyvayyG01nn96BmQ+ga9lcfTq7X+skviL71/VG5j5p1XehXygwmpyGsgI0LaZwXLP5JvFOX6XETkJGAqHXmwRw3V820/TwMqPazLPuTum20lIsYzgnuVAuGjEFTkcjFAU722CSgu7iZ7hrC6AmnCi4Unct14ySieO3Xjudq+g4yLxrjg5qVwmRy2zthNDjRMe2HpP9GbtZuB4X6GZ1K1YLdPukM7h1KgA0ClwcPn9IqwzDe+ZZ4Njkup7HmEjIf78S8eml2+/trWMxZm4rkYr8HdqW39Mj1/Eud3mxRJCuRfZk6tXnRHg1jgxjhSEvSwf4yOgmbHYggtQaKl4mOg1SJww/sOoEVr10o+7v56W5bc4nX4S/AQRduJX8bTYKif83BRxgthoq/YtfNDNP/MX/LTJPXBg/NFlfd07U2pBDdlQQGGLNX3xFGjWj6voFqZdr0G6AKU/9+X0Df2+2WywstTQDsLrHN6E8jfnm2S7HQoCaKnSiJ1AlJLyXcr25DctNhHIxZa/6Hhw0dSgX11QAHBqBkvQLRRtLg7zEQYRPrRI+BICnvqNWI301qdOtha3KgAHqz31VY2+sHJqsxRuEv5YSOLgRAaOVWo8SWoIrhoSex4+lYBguESk4ZMg2UH1nzYkFvTjmP8yGM7ruAhUIaUWbBiem2w1e9HbZ2wsqFzpvRVps4GnW5IWgVjY98sASX/wzZvwXqasytV7V7T10hTAkk6bmzapm3X0zpXiU0gKjP4QkN//yuZSZfOkNTWjcJVnAIpy0AjJd8JlbJ8I0D6fztTiQuzs+LQsEDacSuggjEttFsc8hcc1weh6/+duI03Q94p77ekil/w/KcPsVjjApdSweV2L73latRvPE6xeWJp3rcoYuOGu49lW27W/AqtYz3MOoxL4fYOPEE0G7UEps6uHWLKsnR+AyveFlqR8GtgHrgXJOyUyacyFPoJdBb3paxTP6pHJmfra6MdzARBMmv1bv7vR+QOUgJyZFtqUtXpA1//P57JvrpU4F4X3TYtevu/HL9cZpm8DV6b6ut/Ut3Mzy+hWC4xc6UCy1IfGcxGHokBYLCD7MN3MkTKJnRx0n4zNZ+PHsW8H+XhIl2Mk0sWTfAjlv6fKBY1c/as4Mnh+lhmYQoMn7i9fkLrGcHPVYefaPpx+Geqww7Lkat5M4kST0sIdsbEUHP3uUoF5go+tWJXsIMSqV9A5epvxEQKxlxo69EycnGbV5my2yt0ctfihSImb4Nf4UjswurRYaFPiBA8UC1LUDxa72Oc6In6SXUjqb7/6PbDV91J+WYzT4HNyn8FuuIIow74zdmQGDnf48zfPxyUB1oweEFHTc83aVK/cI6czg2GzENbSZdSZ6hYfUMNvkO6dY7RHb771GbQph6G8347p1gs0Yx5Ib7GwVyuiew6fhWi1s+9GZqsRdOe7GMT8ov7o7XLPbSx8cEU/kdnp0nDn5cWAuLHTN8B+valT+psHjq56Eo5xq3IXQkjVUBo6RZQcoFcSNq6Ls3cCh8al+v+AChOhRbxnYTIJeFaNszTtGLnOMsBW0C7/WLiLAojxnvaenfHlWy6k3O/Kz777B+ay+aRTqg/Pu/X1eJyU1hrXMvxrRNUyM3oj38ud6prlvpoJXE7AvZONBL+1GMxBD8EP4cxITVIAn5D7WZVEfJUJ2r7nlQ05ftvbSNQPlSlXZ+bCDK5cM0QmHmtEuC3EsfLzXII0sQbqc6T9Gz7nifKtk4zvet5honqVRPvjl/iCeteWyI5656pqY2fNmnJ6z6C+UMDT/eKhsjcemthaVA6WaVO7lxyEC6UiiMzLkw2zzOZzOxyEBmPfFHyV8qQgZLe4tquIcuF8xrJS07ptGJ3vh8wZGEIQFNTKWhsr5n7z71xUKckaWgzo7NudDeDH7ZTjDaMu3BSy3auDOvdk9+ydJPYuMV1LqhN6X2tO520qDuF/bvmVwU4DIb26uW+yBzMBwlFznRU1QF5v9griNxtu3xpBlukH3zT+z6CrIr0Ifl2aL6MgjkM0+xeMZQu1cx6d4ATpqv5b7qoyQE7AxRPNm9YZivWo+0cv8FBhUqPdHwLDRX89fU3fFTA9FYJzua7sy2g0JTZqeTzF7fHUfmdU/uP3id7+LjCTAqv3FFXJl11GPlCELFWNDYSYHEv4V21n7jXVf6LgGEZEsC4FQs93YOxK+sixUJP3/OSysSGTk216C+dchauh7nOMsU5NtPfJ8BjC34t1tevgF8Pm1GKtU4rXH9s3DAIx8UflN0M9TZ0UOk9ByQaMbdB1nBRNrCypX89M3INo4XMDILbuOy7cnvHODrC6n8U4f3BPU0QDI10ZVzI4O0VBzdZ7yiw4RK7ZgZTPdEQLQy+GJ3bslPoUpihGchm/zs2U2uZ7vHcKHfOUf/kYlUksaZFs26gvDdLPRYFrzHWKE15h7qkkHKPxHb5GEInJ3il95hUdu2e2t7AFGebIB62p5RHeaRTwBqD9EMIe3DqAVf1pvNEqf418NQVx5QWzSf9ZHSSRfg0jhAVytF4JnW0R1vX8HPnnCLCd3uqZfWgV4JFmc4/XsOx33M5NF1cyb+TK8fAy3eaRrAxt7Nl3QAR4HPsJPJO+/ddleOhlon3J+cl8mF8zxhUKNCMhodNWC4yADfPCzagc3ACwO7OGo6VlnVNJkoeN0XBXboKvwRXnPB+wsryZbACBLv+Qabuctfb/LcBj8hI5oVg6q3LhfLk12D8YL6slyCGsJLf8KicnIOniCqyjaw4osmkguXggjibrCpwf0G4jtFKNMcmcC2WUwKdOxBMccVw9wOuWrV+HmcB4gduz/I+GHbdDDWctIZ6sBpRMwhE9HRsT9v+ZNIochp5H86NTC5Wcz+w8K71XD+RNklAdtM2tlv3e2uuzg4k9J4QDY4K4Ji4xcLm5KQ4/jB9FvkxgyfCeg4h/WjfA9BMQs8BxxtofuJ1BMCqA1vHGz1/Eu/6CNAxsmvzteN5NSVwk/ZK2Pq38m1f8B0x7h4so76TOegQNq4AonoUbJr1mDEmSkHMXbR9G2a2E2Xxeq86spkqc+v/X7Olsp2SHJth13AJEn+PzWJI1RBbeH8ZJP9NI5MIqnQUH1QWOKt9FVpfB3QTJsSHSmRYS6xrG2kBFbrjbh/4OpdeGsj6GUAwOOAl1qy3VEn83itT63uonhN/ij9aQz8vpkLlnWiMm4kwC0Esg3GyMDv0A3SNpQLoJFbLIOe2ysDMdUoWYVDjP0dESt00uks9V0S7+hORSytbXiqkoW0pP1gEzFRmd9Bx8pqY3l3YtkKFxEHdJTOSuypN17WrbIR5PF8dm5GgEYG1rjjGW1R/3jbBGdvxEeL1cKLoKgQNP8QX9+z23Rw1HtNm0VOTmZGtLzl4Y1q/7MYD67INYVUZbAJZp00kmF1BkHWrPGdFHdY2W+2yyCf5KHmivZ4l2zPVCfnpA0sJoHll8Mf21Ml5YnVspRCnKlwJDo80Ms68GhBtuyyEk+K2Yhgclf/q3u3KVsM/TPqYeSuUgjJGV3kMzOUvCuzQvo0VqBVXsOj4C+Z1q82NrnBO5Kk9q79nTN7RWpRM83YwJG7ftT42Nz7gOtA1sfPT8h5i0+4L/KIlxR4wrl1kmdvjQDOF7Pzbjb/HJW/FoJ4sZr110u5hQFOtPg+V3eWXntLr46cA9842ciY+gFTeOzeWwU7nKa8F4sQ3LF3bC+vo1QbVVEKm4OQ7d6wJaSXwMF/Ofi/+P8aqTgUlbGebRloyDX3rnh54i++niX7OqfJJeUTiaT411B2qC98btPLDvL8ukXkmCvLnjX3fomA9XQm8ZlTkIIwKwfA4gOickToiQMMVsh10lV9xwehBASfkSJ5VghK+g2qx34F8Q+T7f7OmJmDpmbzT2mwWQT+CKGticiD9uO/yCYMhPEa6U7AGTRrqnqIEDmak28d6mempFVd8tnHdK8dAFeQoaZOCefJmJg3Rq/6tyXBwQ2NEiD4x9uED8vuTNt9/F/4tM0253Bd7m0oxN/3XgwegpdfnnWevMpe46wCZPO+T1JtX1w72wp/0lBt8hzQCs+TgRwysbnPM5leGeRimlYi6gzir4A8y/9frjehyh4iuL892Lovd8zgiM+xapuiHsFsua/Mk750lSgwJVtVXZVmrlieYv8k8LSGLQX0N09QyDolw8cCtdCshtzHTiv/w7A9PvPnppSIh6PJA2yeMo5diWsqnS5e10NNNi+ZhcJImP53E8FUrmA1/4poUaj75dWDPneM8rpefVgNpl1OLxokKI6e6l1L6hHe2ODaJAJhrS511TPe+N5GX58bk2ysZnnOIFmY11hUgqsBds8FyhCUl5sUawN+FHC1mriWlAgEpU/+vOTmRcsZrjNMckqzOCJf0ECDqsGNk2fpGX9q2tpNcZ/iFXLOceTaT8IBq58NbxD1kIE43aKm+Tduou/4ySCyXev2yGI6tg//4u5/sgAUvUfB3iyX3oPT81uJC20bTH8svw2D5KW7LBSjGAhwolzl9U3wz1+zwri8zQWtxf7WoQgizx3AsLcsvQAxcv7+v739uzJkEFg1WI7YrwUbu2bsGHZIvq/fu9Kpvef90NRlqXOVnDNp7t+5uGspf8FFjrtLF4J89AHF0AAH4w3bdbFgdT99fG6Xkmm+qtuE+EViJ7AS0Pu4ivQza5G2lGaL2Cra0ljCC4QObg1Oov3RhC6CmQNkVnVkL5EA596pC8n2ItO46gdFOCZvhgN8tVbpEaazlcLyHxVgvZXCK2OA+qTQVKcKxo6eXrsfDJpGHdoYEW0PVNdNfvgULpdhqJksUTLv65qkVi8bKGBeXw9UO+E192Jx1aQp0WVVC9UUwVEglqvnIgKfgYabyKZaO04jtbBaPhdiUYU7Rj1IJa8cJ2Nu/R0K/Wnl16reLQDpcRacpXJEt3DAmoEl1WJ8QNpL97St6z6wNfWtLYndaRB9yXpLU4o6NE85CLv44MlMWgwTmdUL+QieP4mTJRWagnt32gK6YTYHY0JMdPuTgT27B+7jtl432SE2gvh5NZQRGQtDUl6FC3dhbUeE6ZlJwpq8cz/89aOoRYveIrZxZpRCb06vwQttC8dgv2IH4AFobdJwYowIntDiWASePWgyWQgiqZnxdYNuZRZ/9rV5h9RF6COjADxHPQtSLC7QYhuy1IqSrf+pC8FaDlZkSDRLru4qXCT1LBcpwvItDLVUQHZTl1ZLoujkEZ3DQeebJmCCpKEGb6idxJG2or++X/08W7vjaZabLgBIntCW1KNjqomHmYSraJvlFFH2ylXgwL7VFXZVJs83xE4J6Hu4aRs+qYpUB0pxUMOjvM9vg6lt90h3MfHbX0skiM6QAjRk3nKtEha/kbKAfaz2L10d6/R3Cxyo9imO3om361ASXBS3sTIEr48NSgrUxxpPfRPLSnZWHia0SDPzM1gBuBKYGExm7xJNetXHFK/Jm1eiz7NgVYu5hppZkII73sG767S17cnCze59dx4SkvgqrP1Bf2/KWFO1dQKwUAs7RZArAK0MZg/DPaIKinit1cl/GlSMl8kD9bX2XpWLbLA3QODndOiRn8I4l2wA7tY+D5UjByBzthWE7WeTpc+vlDyJmhjcRpM5r3+n/BK8iIwUxzrrucc//3ZDAXU+ExIZaB6JvuokWp4gm4iDCFmltzFUDtSbSPMQM5gPEMkvR8PArcHg0l8p1uMhn8oFHehYCVoLSwLZa3ElIBD37gL2zeUeu4PWgM6lJ/2M7cWBOLCScMFaBj2Ne6DBWMuPdXl9t1Je4po5dlCbTJIlxyWl9BzykTBWnECTf7z5hOknIEl2J+G2pfe9mlzdEQ6l9HjMyvOiJgL3vTXcnEbSYERJQl+J+pQww7j9ks+1z13wsRGplbdV9yW9AF5+HgbLswgaRVOYeoBiDnJSEnVMBja2f/ttgmURWae6ATzAVfEFMnzeBaZ52LpGKofxNEiGv6eYIQyP/0wwY2OQumO6Khy3wVFAPmBnEU3aDevRRSrk9QW4KM5g67GNEhuwtzS0nMGGbzDR5CnoAGvnQxFSB4ZcJ34FGrVVBOwMhvufa0PPUPYVuLDQeMNWGhiEPKaAApxIewLX4dVNv5rekt0f/9Xp2LfbujoDywxcPfhp1PygMjBfOuPk5cf1DkYYlBMuR2dbAFlal5gR26hGgqA46M6JvfuzqXHQRHAviOL9rcsfqismzmFOlM/5QtR/4NT/DYaQogQnUdGJ9cfNPcyXGe99tIRdbU+3oonT/PS/WnW87cgoLrjHXr7lRgpcVHuKzQO6Dm0KWMJ6UAaPrLHPvr08Lbmd8ifD1gVtHaB4dxoNM1JiwumJDPeWzjDrCjhsADqoDQdmxIqHFE8L3/NyUZPR1sMjZ/JQ8K7tLZLaxLfVWG2sxe5wNgw0K/YYE7EurMwj09MsEUAACnkrTrYmz7Rpa65Tz2ExRtD8xP8v9j+D/M2zYrG8m9Zd3vNmds0n2ygDIzQz+TEZuv8Z1nIks8bWnCYbLJiHGQ8UdmAepwoBqCCVfmrqf0lk7sSCnzqGY6MGMc65F3hWjpcWwOIu6Hz6op+hxloSHV045s5+twRvuXu0iy75gOA4uhs3Ggmr+oLDVyO3PDBOALzyo6h4SM/EOHbFERfbEA/HFH7cxRyAAAAA"};
function categoryImage(slug,name){
  const s=String(slug||"").toLowerCase();
  const n=String(name||"").toLowerCase();
  let key="repair-guides";
  if(s.includes("elect")||n.includes("elect"))key="electrical";
  else if(s.includes("plumb")||n.includes("plumb"))key="plumbing";
  else if(s.includes("hvac")||n.includes("heating")||n.includes("cooling"))key="hvac";
  else if(s.includes("appliance")||n.includes("appliance"))key="appliances";
  else if(s.includes("slide")||n.includes("slide"))key="slide-outs";
  else if(s.includes("chassis")||s.includes("tow")||n.includes("chassis")||n.includes("tow"))key="chassis-towing";
  else if(s.includes("maint")||n.includes("maint"))key="maintenance";
  else if(s.includes("tool")||s.includes("part")||n.includes("tool")||n.includes("part"))key="tools-parts";
  else if(s.includes("system")||n.includes("system"))key="rv-systems";
  return RVF_CATEGORY_IMAGES[key]||RVF_CATEGORY_IMAGES["repair-guides"];
}

function homeCategoriesHtml(categories){
  if(!categories.length)return '<div class="empty-state">System libraries will appear here as they are published.</div>';
  return categories.map(c=>`<a class="topic topic-vector" href="/category/${escapeHtml(c.slug)}">
    <div class="topic-icon-image"><img src="${categoryImage(c.slug,c.name)}" alt="" loading="lazy" width="72" height="72"></div>
    <div class="topic-copy"><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.description||"RV troubleshooting and maintenance guidance.")}</p></div>
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
        <p>${escapeHtml(a.excerpt||"Open this practical RV guide.")}</p>
        <span class="card-link">Read guide →</span>
      </div>
    </a>`;
  }).join("");
}

function guidesHtml(data){
  const articles=data.articles||[];
  const categories=data.categories||[];
  if(!articles.length)return `<div class='blog-index-empty'><h2>Fresh RV guides are on the way.</h2><p>Use the system library while new articles are being published.</p><a class='btn primary' href='/'>Browse RV systems</a></div>`;

  const featured=articles[0];
  const latest=articles.slice(1);
  const featureFallback=categoryImage(featured.categories?.slug,featured.categories?.name);
  const featureImage=featured.featured_image_url||featureFallback;
  const featureDate=featured.published_at?new Date(featured.published_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}):'';

  const categoryLinks=categories.map(c=>`<a class='blog-system-pill' href='/category/${escapeHtml(c.slug)}'>
    <span class='blog-system-pill-art'><img src='${categoryImage(c.slug,c.name)}' alt='' width='34' height='34' loading='lazy'></span>
    <span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.description||'RV troubleshooting and maintenance')}</small></span>
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
        <div class='blog-index-card-meta'><a href='/category/${escapeHtml(a.categories?.slug||'guides')}'>${escapeHtml(a.categories?.name||'RV Guide')}</a>${date?`<span>${escapeHtml(date)}</span>`:''}</div>
        <h2><a href='/blog/${escapeHtml(a.slug)}'>${escapeHtml(a.title)}</a></h2>
        <p>${escapeHtml(a.excerpt||'Practical RV troubleshooting and maintenance guidance.')}</p>
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
        <div class='blog-index-feature-meta'><a href='/category/${escapeHtml(featured.categories?.slug||'guides')}'>${escapeHtml(featured.categories?.name||'RV Guide')}</a>${featureDate?`<span>${escapeHtml(featureDate)}</span>`:''}</div>
        <span class='blog-index-feature-label'>LATEST GUIDE</span>
        <h2><a href='/blog/${escapeHtml(featured.slug)}'>${escapeHtml(featured.title)}</a></h2>
        <p>${escapeHtml(featured.excerpt||'Open the latest RVFixWise guide.')}</p>
        <a class='btn lime' href='/blog/${escapeHtml(featured.slug)}'>Read the latest guide</a>
      </div>
    </section>

    ${categoryLinks?`<section class='blog-index-systems'>
      <div class='blog-index-section-head'><div><span>BROWSE BY SYSTEM</span><h2>Start with the part of your RV you are working on.</h2></div><a href='/#systems'>View all systems →</a></div>
      <div class='blog-system-pills'>${categoryLinks}</div>
    </section>`:''}

    <section class='blog-index-latest'>
      <div class='blog-index-section-head'><div><span>LATEST FROM RVFIXWISE</span><h2>Practical troubleshooting, maintenance and ownership guides.</h2></div><a href='/search.html'>Search the library →</a></div>
      <div class='blog-index-grid'>${cards||`<div class='empty-state'>More guides are being prepared.</div>`}</div>
    </section>

    <section class='blog-index-search-cta'>
      <div><span>NOT SURE WHERE TO START?</span><h2>Search by the symptom you are seeing.</h2><p>Use plain language such as “water pump runs but no water” or “RV AC not cooling.”</p></div>
      <a class='btn lime' href='/search.html'>Search RVFixWise</a>
    </section>
  </div>`;
}
function homePopularHtml(articles){
  if(!articles.length){
    return `<a class="check" href="/search.html"><i>1</i><span>Search the RVFixWise guide library</span></a>
      <a class="check" href="/#systems"><i>2</i><span>Browse by RV system</span></a>`;
  }
  return articles.slice(0,4).map((a,i)=>`<a class="check" href="/blog/${escapeHtml(a.slug)}">
    <i>${i+1}</i><span>${escapeHtml(a.title)}</span>
  </a>`).join("");
}


function embeddedDemoMedia(name){
  const key=name.includes("electrical")?"electrical":name.includes("maintenance")?"maintenance":"plumbing";
  const uri=categoryImage(key,key);
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
    return u.protocol==="https:" && u.hostname==="rvfixwise.com";
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

  const name=safeMediaName(url.searchParams.get("name")||"rv-image");
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
    const siteId=await rvfSiteId(env);
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
  site_name:"RVFixWise",
  default_meta_description:"Practical RV troubleshooting, maintenance and ownership guidance.",
  sitemap_enabled:true,
  sitemap_include_categories:true,
  sitemap_include_static:true,
  robots_enabled:true,
  allow_oai_searchbot:true,
  extra_robots:""
};

async function getSeoSettings(env,siteId=null){
  try{
    const id=siteId||await rvfSiteId(env);
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
  const siteId=await rvfSiteId(env);
  if(!siteId)throw new Error("RVFixWise site record not found");
  const settings=await getSeoSettings(env,siteId);
  if(settings.sitemap_enabled===false)return new Response("Not found",{status:404});
  const results=await Promise.all([
    publicApi(env,`/rest/v1/categories?site_id=eq.${siteId}&is_active=eq.true&select=slug&order=slug`),
    publicApi(env,`/rest/v1/articles?site_id=eq.${siteId}&status=eq.published&select=slug,updated_at,published_at&order=updated_at.desc`)
  ]);
  const categories=results[0]||[],articles=results[1]||[];
  const staticUrls=settings.sitemap_include_static===false?[]:["/","/blog","/about.html","/editorial-policy.html","/how-we-review.html"];
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
  const siteId=await rvfSiteId(env);
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
    if(url.hostname==="www.rvfixwise.com" || url.hostname==="rvfixwise.enessboz2.workers.dev"){
      const canonical=new URL(url);
      canonical.protocol="https:";
      canonical.hostname="rvfixwise.com";
      canonical.port="";
      return Response.redirect(canonical.toString(),301);
    }

    const clean=url.pathname.replace(/\/+$/,"")||"/";

    // Remote Model Context Protocol endpoint for RVFixWise CMS.
    if(clean==="/mcp")return handleMcp(request,env);
    if(clean.startsWith("/oauth/")||clean.startsWith("/.well-known/oauth-"))return handleOAuth(request,env,clean);

    const adminBase="/rvf-control-8n4k";
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
    if(!["rvfixwise.com","www.rvfixwise.com","rvfixwise.enessboz2.workers.dev"].includes(url.hostname)){
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
          const categoryName=routeData.categories?.name||"RV Guides";
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
                author:{"@type":"Organization","name":"RVFixWise Editorial Team","url":url.origin+"/how-we-review.html"},
                publisher:{"@type":"Organization","name":"RVFixWise","url":url.origin}
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
      const title=`${routeData.seo_title||routeData.title} | RVFixWise`;
      const description=routeData.meta_description||routeData.excerpt||"Practical RV troubleshooting and maintenance guidance.";
      const canonical=new URL(`/blog/${routeData.slug}`,url.origin).href;

      rw.on("title",{element(el){el.setInnerContent(title)}});
      rw.on('meta[name="description"]',{element(el){el.setAttribute("content",description)}});
      rw.on('link[rel="canonical"]',{element(el){el.setAttribute("href",canonical)}});
      rw.on("main",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(articleHtml(routeData),{html:true})}});
    }

    if(routeType==="category"&&routeData){
      const c=routeData.category;
      const description=c.description||`Practical ${c.name} RV troubleshooting and maintenance guides.`;
      const canonical=new URL(clean,url.origin).href;
      rw.on("title",{element(el){el.setInnerContent(`${c.name} RV Guides | RVFixWise`)}});
      rw.on('meta[name="description"]',{element(el){el.setAttribute("content",description)}});
      rw.on('link[rel="canonical"]',{element(el){el.setAttribute("href",canonical)}});
      rw.on("head",{element(el){
        const schema={"@context":"https://schema.org","@graph":[
          {"@type":"CollectionPage","name":c.name+" RV Guides","description":description,"url":canonical},
          {"@type":"BreadcrumbList","itemListElement":[
            {"@type":"ListItem","position":1,"name":"Home","item":url.origin+"/"},
            {"@type":"ListItem","position":2,"name":"RV Systems","item":url.origin+"/#systems"},
            {"@type":"ListItem","position":3,"name":c.name,"item":canonical}
          ]}
        ]};
        el.append(
          `<link rel="canonical" href="${escapeHtml(canonical)}">`+
          `<meta property="og:type" content="website">`+
          `<meta property="og:title" content="${escapeHtml(c.name)} RV Guides | RVFixWise">`+
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
        const homeSchema={"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"RVFixWise","url":canonical},{"@type":"Organization","name":"RVFixWise","url":canonical}]};
        el.append(`<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary"><meta name="robots" content="index,follow,max-image-preview:large"><script type="application/ld+json">${JSON.stringify(homeSchema).replace(/</g,"\\u003c")}</script>`,{html:true});
      }});
    }else if(routeType==="guides"&&routeData){
      rw.on("#blog-index-live",{element(el){el.setAttribute("data-server-rendered","1");el.setInnerContent(guidesHtml(routeData),{html:true})}});
      rw.on('meta[name="robots"]',{element(el){el.setAttribute("content","index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1")}});
      rw.on("head",{element(el){
        const canonical=new URL("/blog",url.origin).href;
        const list=(routeData.articles||[]).slice(0,20).map((a,i)=>({"@type":"ListItem","position":i+1,"url":new URL("/blog/"+a.slug,url.origin).href,"name":a.title}));
        const schema={"@context":"https://schema.org","@graph":[
          {"@type":"Blog","@id":canonical+"#blog","name":"RVFixWise Blog","description":"Practical RV troubleshooting, maintenance and ownership guides.","url":canonical,"publisher":{"@type":"Organization","name":"RVFixWise","url":url.origin}},
          {"@type":"ItemList","@id":canonical+"#articles","itemListElement":list}
        ]};
        el.append(
          `<link rel="canonical" href="${escapeHtml(canonical)}">`+
          `<meta property="og:type" content="website"><meta property="og:title" content="RVFixWise Blog | RV Repair & Maintenance Guides"><meta property="og:description" content="Practical RV troubleshooting, maintenance and ownership guides built around real symptoms and RV systems."><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary">`+
          `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,"\\u003c")}</script>`,
          {html:true}
        );
      }});
    }else if(["/about.html","/editorial-policy.html","/how-we-review.html"].includes(clean)){
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
