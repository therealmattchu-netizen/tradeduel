import { useCallback, useEffect, useState } from "react";
import { createCustomMatch, getCustomMatchChat, getCustomMatchStatus, getMyRating, getWalletPortfolioEstimate, joinCustomMatch, listCustomMatches, sendCustomMatchChat, syncMatchActivity, reconcileCustomMatchSettlement } from "@/lib/api/arena.functions";

type CustomMatch = { id:string; creator_wallet:string; mode:string; visibility:string; max_players:number; duration_seconds:number; status:string; created_at:string; players_count:number };
type ChatMessage = { id:number; wallet:string; channel:string; message:string; created_at:string; team_number:number };
const short = (wallet:string) => wallet.length > 12 ? wallet.slice(0,5)+"…"+wallet.slice(-4) : wallet;
const modeName = (_mode:string) => "Classic · Percentage Duel · 1v1";

export function CustomMatchBrowser() {
  const [matches,setMatches] = useState<CustomMatch[]>([]);
  const mode = "head_to_head" as const;
  const [activePanel,setActivePanel] = useState<"modes"|"private"|"browse">("modes");
  const [privateRoomId,setPrivateRoomId] = useState("");
  const [privateJoinPassword,setPrivateJoinPassword] = useState("");
  const [visibility,setVisibility] = useState<"public"|"private">("public");
  const [maxPlayers,setMaxPlayers] = useState(6);
  const [duration,setDuration] = useState(900);
  const [password,setPassword] = useState("");
  const [notice,setNotice] = useState("");
  const [busy,setBusy] = useState(false);
  const [selected,setSelected] = useState<CustomMatch|null>(null);
  const [channel,setChannel] = useState<"all"|"team">("all");
  const [messages,setMessages] = useState<ChatMessage[]>([]);
  const [draft,setDraft] = useState("");
  const [team,setTeam] = useState<number|null>(null);
  const [latestId,setLatestId] = useState(0);
  const [liveActivity,setLiveActivity] = useState<any>(null);
  const [verifiedSettlement,setVerifiedSettlement] = useState<any>(null);
  const [clockNow,setClockNow] = useState(Date.now());
  const [walletMatchBand,setWalletMatchBand] = useState(20);

  const refresh = useCallback(async () => {
    try { const result = await listCustomMatches(); setMatches(result.matches as CustomMatch[]); }
    catch { setNotice("Couldn't load match rooms. Check that the latest database migration is deployed."); }
  }, []);

  useEffect(() => { void refresh(); const timer=window.setInterval(()=>void refresh(),10000); return()=>window.clearInterval(timer); },[refresh]);


  useEffect(() => {
    if (!selected) return;
    let alive=true;
    const poll=async()=>{
      const token=window.sessionStorage.getItem("td_session_token")||"";
      if(!token)return;
      try {
        const result=await getCustomMatchChat({data:{token,matchId:selected.id,channel,afterId:latestId}});
        if(!alive)return;
        const incoming=result.messages as ChatMessage[];
        if(incoming.length){setMessages(previous=>{const byId=new Map(previous.map(m=>[m.id,m]));incoming.forEach(m=>byId.set(m.id,m));return [...byId.values()].sort((a,b)=>a.id-b.id)});setLatestId(Math.max(latestId,...incoming.map(m=>m.id)));setTeam(result.team);}
      } catch { /* A user who hasn't joined can't read this channel. */ }
    };
    void poll();const timer=window.setInterval(()=>void poll(),2500);
    return()=>{alive=false;window.clearInterval(timer)};
  },[selected,channel,latestId]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    let inFlight = false;
    const pollRoomStatus = async () => {
      if (inFlight) return;
      const token = window.sessionStorage.getItem("td_session_token") || "";
      if (!token) return;
      inFlight = true;
      try {
        const result = await getCustomMatchStatus({ data: { token, matchId: selected.id } }) as any;
        if (!alive) return;
        const room = result.customRoom;
        setLiveActivity((previous: any) => { const current=previous?.customRoom; const rank=(status:string)=>status==="completed"?3:status==="active"?2:status==="open"?1:0; const chosen=current&&rank(current.status)>rank(room.status)?current:room; return { ...(previous ?? {}), customRoom: chosen }; });
        setTeam(result.team);
        setSelected(previous => previous && previous.id === selected.id
          ? { ...previous, status: room.status, players_count: room.members?.length ?? previous.players_count }
          : previous);
        if (room.status === "active" && room.members?.length >= room.maxPlayers) {
          window.location.assign("/custom-match/" + encodeURIComponent(selected.id));
        }
      } catch {
        // Membership may briefly be unavailable during a join; retry on the next poll.
      } finally {
        inFlight = false;
      }
    };
    void pollRoomStatus();
    const timer = window.setInterval(() => void pollRoomStatus(), 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) { setLiveActivity(null); setVerifiedSettlement(null); return; }
    let alive=true;
    const pollActivity=async()=>{ const token=window.sessionStorage.getItem("td_session_token")||""; if(!token)return; try { const activity=await syncMatchActivity({data:{token,matchId:selected.id}}) as any; if(!alive)return; setLiveActivity((previous:any)=>{const incoming=activity.customRoom;const current=previous?.customRoom;const rank=(status:string)=>status==="completed"?3:status==="active"?2:status==="open"?1:0;const preferCurrent=current&&incoming&&rank(current.status)>rank(incoming.status)?current:incoming;return {...(previous??{}),...activity,customRoom:preferCurrent??current};}); if(activity.customRoom) setSelected(previous=>{if(!previous||previous.id!==selected.id)return previous;const currentStatus=previous.status;const incomingStatus=activity.customRoom.status;const rank=(status:string)=>status==="completed"?3:status==="active"?2:status==="open"?1:0;return {...previous,status:rank(currentStatus)>rank(incomingStatus)?currentStatus:incomingStatus,players_count:Math.max(previous.players_count??0,activity.customRoom.members?.length??0)};});
      if(activity.customRoom?.status === "active" && activity.customRoom.members?.length >= activity.customRoom.maxPlayers) {
        window.location.assign("/custom-match/" + encodeURIComponent(selected.id));
      } if(activity.customRoom?.status==="completed"){try{const settlement=await reconcileCustomMatchSettlement({data:{token,matchId:selected.id}}) as any;if(alive)setVerifiedSettlement(settlement);}catch(error){if(alive)setNotice(error instanceof Error?error.message:"Team PnL reconciliation is waiting for evidence.");}} } catch(error) { if(alive) setNotice(error instanceof Error?error.message:"Live match activity could not be synchronized."); } };
    void pollActivity(); const pollTimer=window.setInterval(()=>void pollActivity(),10000); const clockTimer=window.setInterval(()=>setClockNow(Date.now()),1000);
    return()=>{alive=false;window.clearInterval(pollTimer);window.clearInterval(clockTimer)};
  },[selected?.id]);

  const create = async () => {
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!token){setNotice("Connect and verify your wallet before creating a match.");return;}
    setBusy(true);setNotice("");
    try {
      const cap=2;
      const effectiveMode="head_to_head_percentage";
      const result=await createCustomMatch({data:{token,mode:effectiveMode as "head_to_head"|"head_to_head_percentage"|"duo"|"group",visibility,maxPlayers:cap,durationSeconds:duration,password:visibility==="private"?password:undefined}});
      await refresh();
      const found=matches.find(m=>m.id===result.matchId);
      setSelected({id:result.matchId,creator_wallet:"",mode:effectiveMode,visibility,max_players:cap,duration_seconds:duration,status:"open",created_at:new Date().toISOString(),players_count:1,...found});
      setTeam(1);setChannel("all");setMessages([]);setLatestId(0);setNotice(result.message);
    } catch(error){setNotice(error instanceof Error?error.message:"Couldn't create the match.");}
    finally{setBusy(false);}
  };

  const join = async (match:CustomMatch) => {
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!token){setNotice("Connect and verify your wallet before joining a match.");return;}
    let supplied="";
    if(match.visibility==="private"){supplied=window.prompt("Enter the password for this private match:")||"";if(!supplied)return;}
    setBusy(true);setNotice("");
    try {
      const result=await joinCustomMatch({data:{token,matchId:match.id,password:supplied||undefined}});
      setSelected(match);setTeam(result.team);setChannel("all");setMessages([]);setLatestId(0);setNotice(result.message);await refresh();
    } catch(error){setNotice(error instanceof Error?error.message:"Couldn't join this match.");}
    finally{setBusy(false);}
  };

  const findWalletMatchedOpponent = async () => {
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!token){setNotice("Connect and verify your wallet before using wallet-value matchmaking.");return;}
    if(mode!=="head_to_head"){setNotice("Wallet-value matchmaking is currently available for 1v1 duels only.");return;}
    setBusy(true);setNotice("Estimating wallet values and searching for a compatible opponent…");
    try {
      const me=await getMyRating({data:{token}});
      const mine=await getWalletPortfolioEstimate({data:{wallet:me.wallet}}) as any;
      if(!mine.complete||typeof mine.portfolioValueUsd!=="number"||mine.portfolioValueUsd<=0){
        setNotice("Your portfolio estimate is incomplete because one or more holdings could not be priced. Try again later or use standard matchmaking.");return;
      }
      const effectiveMode="head_to_head_percentage";
      const candidates=matches.filter(match=>match.visibility==="public"&&match.status==="open"&&match.players_count===1&&match.max_players===2&&match.duration_seconds===duration&&match.mode===effectiveMode&&match.creator_wallet&&match.creator_wallet!==me.wallet);
      if(!candidates.length){setNotice("No compatible public 1v1 rooms are waiting. Create a public duel, or try standard matchmaking.");return;}
      const estimates=await Promise.all(candidates.map(async match=>{
        try {
          const estimate=await getWalletPortfolioEstimate({data:{wallet:match.creator_wallet}}) as any;
          if(!estimate.complete||typeof estimate.portfolioValueUsd!=="number"||estimate.portfolioValueUsd<=0)return null;
          const differencePct=Math.abs(estimate.portfolioValueUsd-mine.portfolioValueUsd)/mine.portfolioValueUsd*100;
          return {match,estimate,differencePct};
        } catch {return null;}
      }));
      const best=estimates.filter((item):item is NonNullable<typeof item>=>item!==null&&item.differencePct<=walletMatchBand).sort((x,y)=>x.differencePct-y.differencePct)[0];
      if(!best){setNotice("No waiting wallet is within "+walletMatchBand+"% of your estimated portfolio value. Leave this search open and refresh, or widen the balance range.");return;}
      setNotice("Closest wallet found: estimated portfolio values differ by "+best.differencePct.toFixed(1)+"%. Joining room…");
      await join(best.match);
    } catch(error){setNotice(error instanceof Error?error.message:"Wallet-value matchmaking couldn't estimate portfolios. Try again.");}
    finally{setBusy(false);}
  };

  const send = async () => {
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!selected||!draft.trim()||!token)return;
    try {
      await sendCustomMatchChat({data:{token,matchId:selected.id,channel,message:draft.trim()}});
      setDraft("");
      const result=await getCustomMatchChat({data:{token,matchId:selected.id,channel,afterId:latestId}});
      const incoming=result.messages as ChatMessage[];
      if(incoming.length){setMessages(previous=>[...previous,...incoming.filter(m=>!previous.some(p=>p.id===m.id))]);setLatestId(Math.max(latestId,...incoming.map(m=>m.id)));}
    } catch(error){setNotice(error instanceof Error?error.message:"Message could not be sent.");}
  };

  const cardStyle:React.CSSProperties={border:"1px solid var(--td-border)",background:"var(--td-panel)",borderRadius:14,padding:20,boxShadow:"0 12px 34px rgba(0,0,0,.28)"};
  const buttonStyle:React.CSSProperties={border:"1px solid var(--td-border)",background:"linear-gradient(135deg,rgba(145,76,255,.19),rgba(94,52,168,.08))",color:"var(--td-text)",borderRadius:9,padding:"10px 14px",cursor:"pointer",transition:"border-color .15s ease,background .15s ease"};
  const fieldStyle:React.CSSProperties={width:"100%",background:"#080615",color:"var(--td-text)",border:"1px solid var(--td-border)",borderRadius:9,padding:11,marginTop:6};
  return <section style={{marginTop:24,display:"grid",gap:16,"--td-accent":"#a56bff","--td-border":"#302052","--td-panel":"linear-gradient(145deg,#0d0a1c 0%,#090816 100%)","--td-text":"#f4efff","--td-accent-soft":"rgba(151,76,255,.16)","--td-bg":"#070612","--td-muted":"#b2a4d0",color:"#f4efff",fontFamily:"Inter,ui-sans-serif,system-ui,sans-serif"} as React.CSSProperties}>
    <div style={cardStyle}>
      <p className="td-overline" style={{color:"#b58aff",letterSpacing:2}}>MATCHMAKING / ARENA</p><h2 style={{marginTop:4,fontSize:28,letterSpacing:-.6}}>Choose your game</h2><p>Select a game type, create a password-protected private lobby, or browse public rooms.</p>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}><button type="button" style={{...buttonStyle,opacity:activePanel==="modes"?1:.65,borderColor:activePanel==="modes"?"#a56bff":"var(--td-border)",boxShadow:activePanel==="modes"?"0 0 0 1px rgba(165,107,255,.18)":"none"}} onClick={()=>{setActivePanel("modes");setVisibility("public")}}>Classic mode</button><button type="button" style={{...buttonStyle,opacity:activePanel==="private"?1:.65}} onClick={()=>{setActivePanel("private");setVisibility("private")}}>Create private lobby</button><button type="button" style={{...buttonStyle,opacity:activePanel==="browse"?1:.65}} onClick={()=>setActivePanel("browse")}>Browse public lobbies</button></div>
    </div>
    {activePanel==="modes"&&<div style={cardStyle}>
       <p className="td-overline">ONLY AVAILABLE MODE</p><div style={{border:"1px solid #a56bff",borderRadius:12,padding:16,background:"linear-gradient(135deg,rgba(145,76,255,.24),rgba(94,52,168,.08))"}}><strong style={{display:"block",fontSize:18}}>Classic · Percentage Duel · 1v1</strong><small>Winner is the player with the highest percentage portfolio return from match start to match end. Pre-match gains do not count.</small></div><div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:14}}><button type="button" style={{...buttonStyle,background:"linear-gradient(135deg,#8b45f6,#5b2cbd)",borderColor:"#ad83ff",fontWeight:750}} disabled={busy} onClick={()=>{setVisibility("public");void create()}}>{busy?"Creating…":"Create public Classic match"}</button><button type="button" style={buttonStyle} onClick={()=>{setActivePanel("private");setVisibility("private")}}>Create private lobby ↗</button></div>
    </div>}
    {activePanel==="private"&&<div style={cardStyle}>
       <p className="td-overline">PRIVATE CLASSIC LOBBY</p><h2>Create a password-protected Classic room</h2><p>Classic is a 1v1 percentage-return duel. Only portfolio performance after the match starts counts.</p>
       <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}><label>DURATION<select style={fieldStyle} value={duration} onChange={e=>setDuration(Number(e.target.value))}><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={86400}>1 day</option></select></label><label>LOBBY PASSWORD<input style={fieldStyle} type="password" minLength={4} maxLength={80} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 4 characters"/></label></div>
      <button type="button" style={{...buttonStyle,marginTop:14}} disabled={busy||password.trim().length<4} onClick={()=>{setVisibility("private");void create()}}>{busy?"Creating…":"Create private lobby"}</button>
      <div style={{marginTop:18,paddingTop:16,borderTop:"1px solid var(--td-border)"}}><h3>Join a private lobby</h3><p>Enter the room ID shared by the host and the matching password.</p><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}><label>ROOM ID<input style={fieldStyle} value={privateRoomId} onChange={e=>setPrivateRoomId(e.target.value.trim())} placeholder="Paste private room ID"/></label><label>ROOM PASSWORD<input style={fieldStyle} type="password" value={privateJoinPassword} onChange={e=>setPrivateJoinPassword(e.target.value)} placeholder="Lobby password"/></label></div><button type="button" style={{...buttonStyle,marginTop:12}} disabled={busy||!privateRoomId.trim()||!privateJoinPassword} onClick={async()=>{const token=window.sessionStorage.getItem("td_session_token")||"";if(!token){setNotice("Connect and verify your wallet before joining a private lobby.");return;}setBusy(true);setNotice("");try{const result=await joinCustomMatch({data:{token,matchId:privateRoomId.trim(),password:privateJoinPassword}});const listed=await listCustomMatches();const found=(listed.matches as CustomMatch[]).find(m=>m.id===privateRoomId.trim());const fallback:CustomMatch={id:privateRoomId.trim(),creator_wallet:"",mode:(result.mode??"head_to_head_percentage") as CustomMatch["mode"],visibility:"private",max_players:result.maxPlayers??4,duration_seconds:result.durationSeconds??duration,status:result.status??"open",created_at:new Date().toISOString(),players_count:1};setSelected(found??fallback);setTeam(result.team);setChannel("all");setMessages([]);setLatestId(0);setNotice(result.message);setPrivateJoinPassword("");await refresh();}catch(error){setNotice(error instanceof Error?error.message:"Could not join this private lobby.");}finally{setBusy(false);}}}>Join private lobby</button></div>
    </div>}
    {activePanel==="browse"&&<div style={cardStyle}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><p className="td-overline">PUBLIC LOBBIES</p><h2>Find an open match</h2></div><button style={buttonStyle} onClick={()=>void refresh()}>Refresh</button></div>
      <p>Choose an open public room and join when a slot is available. Private rooms are not listed publicly; use the room ID and password in the private lobby panel.</p><div style={{...cardStyle,marginBottom:14}}><p className="td-overline">BALANCED WALLET MATCHMAKING · BETA</p><h3 style={{margin:"4px 0 8px"}}>Find a similarly sized portfolio</h3><p>Compares current SOL plus priced token holdings and picks the closest waiting public 1v1 opponent within your selected range. Wallet estimates are approximate and any unpriced holdings make a wallet ineligible.</p><div style={{display:"flex",gap:10,alignItems:"end",flexWrap:"wrap"}}><label style={{minWidth:180}}>MAX PORTFOLIO DIFFERENCE<select style={fieldStyle} value={walletMatchBand} onChange={e=>setWalletMatchBand(Number(e.target.value))}><option value={10}>Within 10%</option><option value={20}>Within 20%</option><option value={30}>Within 30%</option><option value={50}>Within 50%</option></select></label><button type="button" style={{...buttonStyle,background:"linear-gradient(135deg,#8b45f6,#5b2cbd)",borderColor:"#ad83ff",fontWeight:750}} disabled={busy||mode!=="head_to_head"} onClick={()=>void findWalletMatchedOpponent()}>{busy?"Searching…":"Find closest wallet"}</button></div>{mode!=="head_to_head"&&<small>Switch to 1v1 Duel to use balance-based matchmaking.</small>}</div>
      <div style={{display:"grid",gap:10}}>{matches.filter(match=>match.visibility==="public"&&match.status==="open"&&match.mode==="head_to_head_percentage"&&match.max_players===2&&match.players_count<match.max_players).length===0?<p>No public rooms open yet. Create one from Game modes.</p>:matches.filter(match=>match.visibility==="public"&&match.status==="open"&&match.mode==="head_to_head_percentage"&&match.max_players===2&&match.players_count<match.max_players).map(match=><div key={match.id} style={{border:"1px solid var(--td-border)",borderRadius:8,padding:12,display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:12,alignItems:"center"}}><div><strong>{modeName(match.mode)}</strong><div style={{fontSize:12,color:"var(--td-muted)",marginTop:4}}>{match.players_count}/{match.max_players} players · {Math.round(match.duration_seconds/60)} min · {match.status}</div><div style={{fontSize:11,color:"var(--td-muted)",marginTop:4}}>Room {match.id.slice(0,8).toUpperCase()}</div></div><button style={buttonStyle} disabled={busy||match.players_count>=match.max_players||match.status!=="open"} onClick={()=>void join(match)}>{match.players_count>=match.max_players?"Full":match.status==="active"?"In progress":"Join"}</button></div>)}</div>
    </div>}
    {selected&&<div style={cardStyle}>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}><div><p className="td-overline">ROOM {selected.id.slice(0,8).toUpperCase()}</p><h2>{modeName(selected.mode)} · Team {team??"—"}</h2><small style={{overflowWrap:"anywhere"}}>Room ID: {selected.id}</small><button type="button" style={{...buttonStyle,marginTop:8}} onClick={()=>{void navigator.clipboard.writeText(selected.id);setNotice("Room ID copied. Share it with invited players along with the lobby password.")}}>Copy room ID</button></div><button style={buttonStyle} onClick={()=>setSelected(null)}>Close room panel</button></div>
      {liveActivity?.customRoom&&<div style={{marginTop:14,padding:12,border:"1px solid var(--td-border)",borderRadius:8}}><p className="td-overline">LIVE ROOM STATUS</p><strong>{liveActivity.customRoom.status==="open"?"WAITING FOR PLAYERS":liveActivity.customRoom.status==="active"?"MATCH LIVE":liveActivity.customRoom.status==="completed"?"TIME EXPIRED · REVIEW REQUIRED":liveActivity.customRoom.status.toUpperCase()}</strong><p>{liveActivity.customRoom.members.length}/{liveActivity.customRoom.maxPlayers} players · {liveActivity.customRoom.mode==="head_to_head"?"1v1":liveActivity.customRoom.mode==="duo"?"2v2 team duel":"team battle"}</p>{liveActivity.customRoom.members.map((member:any)=><div key={member.wallet} style={{display:"flex",justifyContent:"space-between",gap:10,padding:"5px 0"}}><span>{short(member.wallet)}</span><span>TEAM {member.team_number}</span></div>)}{liveActivity.customRoom.endsAt&&liveActivity.customRoom.status==="active"&&<p>Time remaining: {Math.max(0,Math.ceil((new Date(liveActivity.customRoom.endsAt).getTime()-clockNow)/1000/60))} min</p>}</div>}
      {liveActivity?.customRoom?.status==="completed"&&<div style={{marginTop:14,padding:12,border:"1px solid var(--td-border)",borderRadius:8}}><p className="td-overline">{verifiedSettlement?.status==="verified"?"VERIFIED PORTFOLIO PnL":"PENDING VERIFICATION"}</p><p>{verifiedSettlement?.message??"Historical portfolio pricing and full transaction reconciliation are being checked. Estimates are not official results."}</p><div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,margin:"10px 0"}}>{[1,2].map(teamNumber=>{const score=teamNumber===1?verifiedSettlement?.teamOneReturnPct:verifiedSettlement?.teamTwoReturnPct;return <div key={teamNumber} style={{padding:12,border:"1px solid var(--td-border)",borderRadius:8}}><small>TEAM {teamNumber} · HISTORICAL RETURN</small><h3 style={{margin:"6px 0"}}>{typeof score==="number"?(score>=0?"+":"")+score.toFixed(2)+"%":"Pending"}</h3></div>})}</div>{verifiedSettlement?.members?.map((member:any)=><div key={member.wallet} style={{display:"flex",justifyContent:"space-between",gap:12,padding:"6px 0",borderBottom:"1px solid var(--td-border)"}}><span>{short(member.wallet)} · Team {member.team}</span><strong>{typeof member.returnPct==="number"?(member.returnPct>=0?"+":"")+member.returnPct.toFixed(2)+"%":"Unverified"}</strong></div>)}{verifiedSettlement?.blockers?.length>0&&<div style={{marginTop:10}}><strong>Verification blockers</strong><ul>{verifiedSettlement.blockers.slice(0,12).map((item:string)=><li key={item}>{item.replaceAll("_"," ")}</li>)}</ul></div>}<small>Portfolio mark-to-market PnL uses historical price evidence. No ELO is applied by this reconciliation.</small></div>}
      {selected.mode !== "head_to_head" && <div style={{display:"flex",gap:8,margin:"12px 0"}}><button style={{...buttonStyle,opacity:channel==="all"?1:.65}} onClick={()=>{setChannel("all");setMessages([]);setLatestId(0)}}>All chat</button><button style={{...buttonStyle,opacity:channel==="team"?1:.65}} onClick={()=>{setChannel("team");setMessages([]);setLatestId(0)}}>Team chat</button></div>}
      <div style={{maxHeight:260,overflowY:"auto",display:"grid",gap:8,padding:10,border:"1px solid var(--td-border)",borderRadius:8}}>{messages.map(m=><div key={m.id}><strong>{short(m.wallet)} · Team {m.team_number}</strong><div>{m.message}</div><small style={{color:"var(--td-muted)"}}>{new Date(m.created_at+"Z").toLocaleTimeString()}</small></div>)}{messages.length===0&&<p>No messages yet. Say hello to your match.</p>}</div>
      {liveActivity?.customRoom?.status==="active"&&<div style={{marginTop:14,padding:12,border:"1px solid var(--td-border)",borderRadius:8}}><p className="td-overline">LIVE ESTIMATED SCORING</p><p>Team score is the average percentage return of members with complete observations. These standings are provisional estimates, not verified fills or official results; no winner or ELO is awarded.</p><div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,margin:"10px 0"}}>{[1,2].map(teamNumber=>{const returns=(liveActivity.customRoom.members as Array<{wallet:string;team_number:number}>).filter(member=>member.team_number===teamNumber).map(member=>{const samples=(liveActivity.valuationObservations??[]).filter((o:any)=>o.wallet===member.wallet&&o.complete&&o.portfolio_usd!==null).sort((a:any,b:any)=>a.observed_at-b.observed_at);const first=samples[0],latest=samples[samples.length-1];return first&&latest&&first.portfolio_usd>0?((latest.portfolio_usd-first.portfolio_usd)/first.portfolio_usd)*100:null;}).filter((value):value is number=>value!==null);const score=returns.length?returns.reduce((sum,value)=>sum+value,0)/returns.length:null;return <div key={teamNumber} style={{padding:12,border:"1px solid var(--td-border)",borderRadius:8}}><small>TEAM {teamNumber} · {returns.length} scored</small><h3 style={{margin:"6px 0"}}>{score===null?"Pending":(score>=0?"+":"")+score.toFixed(2)+"%"}</h3><small>Average observed return</small></div>})}</div>{(liveActivity.customRoom.members as Array<{wallet:string;team_number:number}>).map(member=>{const samples=(liveActivity.valuationObservations??[]).filter((o:any)=>o.wallet===member.wallet&&o.complete&&o.portfolio_usd!==null).sort((a:any,b:any)=>a.observed_at-b.observed_at);const first=samples[0],latest=samples[samples.length-1];const pct=first&&latest&&first.portfolio_usd>0?((latest.portfolio_usd-first.portfolio_usd)/first.portfolio_usd)*100:null;return <div key={member.wallet} style={{display:"flex",justifyContent:"space-between",gap:12,padding:"7px 0",borderBottom:"1px solid var(--td-border)"}}><span>{short(member.wallet)} · Team {member.team_number}</span><strong>{pct===null?"Collecting evidence":(pct>=0?"+":"")+pct.toFixed(2)+"%"}</strong></div>})}<p style={{marginTop:12}}><strong>Transaction ledger · {(liveActivity.accountingLedger??[]).length} indexed entries</strong></p>{(liveActivity.accountingLedger??[]).slice(0,8).map((row:any)=><div key={row.wallet+row.signature} style={{padding:"7px 0",borderBottom:"1px solid var(--td-border)"}}><a href={"https://explorer.solana.com/tx/"+row.signature} target="_blank" rel="noreferrer">{row.signature.slice(0,10)}…{row.signature.slice(-6)} ↗</a><small style={{display:"block"}}>{short(row.wallet)} · Fee {(row.fee_lamports/1e9).toFixed(9)} SOL · {row.protocols?.join(", ")||"Unknown protocol"}</small><small style={{display:"block"}}>{row.blockers?.length?row.blockers.map((b:string)=>b.replaceAll("_"," ")).join("; "):"No stored blockers"}</small></div>)}</div>}
      <form onSubmit={e=>{e.preventDefault();void send()}} style={{display:"flex",gap:8,marginTop:10}}><input style={fieldStyle} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={500} placeholder={channel==="all"?"Message everyone…":"Message your team…"} /><button style={buttonStyle} type="submit" disabled={!draft.trim()}>Send</button></form>
    </div>}
    {notice&&<p role="status" style={{color:"var(--td-muted)"}}>{notice}</p>}
    <p style={{fontSize:12,color:"var(--td-muted)"}}>Custom-room PnL reconciliation is in testing. Scores stay provisional until historical prices, complete transaction indexing, external transfers, and token-account lifecycle effects are reconciled.</p>
  </section>;
}
