import { useCallback, useEffect, useState } from "react";
import { createCustomMatch, getCustomMatchChat, joinCustomMatch, listCustomMatches, sendCustomMatchChat } from "@/lib/api/arena.functions";

type CustomMatch = { id:string; creator_wallet:string; mode:string; visibility:string; max_players:number; duration_seconds:number; status:string; created_at:string; players_count:number };
type ChatMessage = { id:number; wallet:string; channel:string; message:string; created_at:string; team_number:number };
const short = (wallet:string) => wallet.length > 12 ? wallet.slice(0,5)+"…"+wallet.slice(-4) : wallet;
const modeName = (mode:string) => mode === "head_to_head" ? "1v1 Duel" : mode === "duo" ? "Duo 2v2" : "Group Team Battle";

export function CustomMatchBrowser() {
  const [matches,setMatches] = useState<CustomMatch[]>([]);
  const [mode,setMode] = useState<"head_to_head"|"duo"|"group">("duo");
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

  const create = async () => {
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!token){setNotice("Connect and verify your wallet before creating a match.");return;}
    setBusy(true);setNotice("");
    try {
      const cap=mode==="head_to_head"?2:mode==="duo"?4:maxPlayers;
      const result=await createCustomMatch({data:{token,mode,visibility,maxPlayers:cap,durationSeconds:duration,password:visibility==="private"?password:undefined}});
      await refresh();
      const found=matches.find(m=>m.id===result.matchId);
      setSelected({id:result.matchId,creator_wallet:"",mode,visibility,max_players:cap,duration_seconds:duration,status:"open",created_at:new Date().toISOString(),players_count:1,...found});
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

  const cardStyle:React.CSSProperties={border:"1px solid var(--td-border)",background:"var(--td-panel)",borderRadius:10,padding:16};
  const buttonStyle:React.CSSProperties={border:"1px solid var(--td-border)",background:"var(--td-accent-soft)",color:"var(--td-text)",borderRadius:6,padding:"9px 12px",cursor:"pointer"};
  const fieldStyle:React.CSSProperties={width:"100%",background:"var(--td-bg)",color:"var(--td-text)",border:"1px solid var(--td-border)",borderRadius:6,padding:10};
  return <section style={{marginTop:24,display:"grid",gap:16}}>
    <div style={cardStyle}>
      <p className="td-overline">MATCHMAKING MODES</p><h2 style={{marginTop:4}}>Choose how you want to play</h2><p>Select a game type, create a password-protected private lobby, or browse public rooms.</p>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}><button type="button" style={{...buttonStyle,opacity:activePanel==="modes"?1:.65}} onClick={()=>{setActivePanel("modes");setVisibility("public")}}>Game modes</button><button type="button" style={{...buttonStyle,opacity:activePanel==="private"?1:.65}} onClick={()=>{setActivePanel("private");setVisibility("private")}}>Create private lobby</button><button type="button" style={{...buttonStyle,opacity:activePanel==="browse"?1:.65}} onClick={()=>setActivePanel("browse")}>Browse public lobbies</button></div>
    </div>
    {activePanel==="modes"&&<div style={cardStyle}>
      <p className="td-overline">GAME TYPE</p><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>{([{id:"head_to_head",title:"1v1 Duel",desc:"One player against one player"},{id:"duo",title:"Team Duos 2v2",desc:"Pair up and compete as a team"},{id:"group",title:"Team Battle",desc:"3v3 or 4v4 lobby"}] as const).map(item=><button type="button" key={item.id} style={{...buttonStyle,textAlign:"left",padding:14,borderColor:mode===item.id?"var(--td-accent)":"var(--td-border)"}} onClick={()=>{setMode(item.id);if(item.id==="head_to_head")setMaxPlayers(2);else if(item.id==="duo")setMaxPlayers(4);else if(maxPlayers<6)setMaxPlayers(6)}}><strong style={{display:"block"}}>{item.title}</strong><small>{item.desc}</small></button>)}</div><button type="button" style={{...buttonStyle,marginTop:14}} disabled={busy} onClick={()=>{setVisibility("public");void create()}}>{busy?"Creating…":"Create public match"}</button>
    </div>}
    {activePanel==="private"&&<div style={cardStyle}>
      <p className="td-overline">PRIVATE LOBBY</p><h2>Create a password-protected room</h2><p>Choose the format, create a room, then share its room ID and password with invited players. Passwords are stored as hashes.</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}><label>GAME TYPE<select style={fieldStyle} value={mode} onChange={e=>{const next=e.target.value as typeof mode;setMode(next);if(next==="head_to_head")setMaxPlayers(2);else if(next==="duo")setMaxPlayers(4);else if(maxPlayers<6)setMaxPlayers(6)}}><option value="head_to_head">1v1 Duel</option><option value="duo">Team Duos 2v2</option><option value="group">Team Battle</option></select></label>{mode==="group"&&<label>PLAYER LIMIT<select style={fieldStyle} value={maxPlayers} onChange={e=>setMaxPlayers(Number(e.target.value))}><option value={6}>6 players · 3v3</option><option value={8}>8 players · 4v4</option></select></label>}<label>DURATION<select style={fieldStyle} value={duration} onChange={e=>setDuration(Number(e.target.value))}><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={86400}>1 day</option></select></label><label>LOBBY PASSWORD<input style={fieldStyle} type="password" minLength={4} maxLength={80} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 4 characters"/></label></div>
      <button type="button" style={{...buttonStyle,marginTop:14}} disabled={busy||password.trim().length<4} onClick={()=>{setVisibility("private");void create()}}>{busy?"Creating…":"Create private lobby"}</button>
      <div style={{marginTop:18,paddingTop:16,borderTop:"1px solid var(--td-border)"}}><h3>Join a private lobby</h3><p>Enter the room ID shared by the host and the matching password.</p><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}><label>ROOM ID<input style={fieldStyle} value={privateRoomId} onChange={e=>setPrivateRoomId(e.target.value.trim())} placeholder="Paste private room ID"/></label><label>ROOM PASSWORD<input style={fieldStyle} type="password" value={privateJoinPassword} onChange={e=>setPrivateJoinPassword(e.target.value)} placeholder="Lobby password"/></label></div><button type="button" style={{...buttonStyle,marginTop:12}} disabled={busy||!privateRoomId.trim()||!privateJoinPassword} onClick={async()=>{const token=window.sessionStorage.getItem("td_session_token")||"";if(!token){setNotice("Connect and verify your wallet before joining a private lobby.");return;}setBusy(true);setNotice("");try{const result=await joinCustomMatch({data:{token,matchId:privateRoomId.trim(),password:privateJoinPassword}});const listed=await listCustomMatches();const found=(listed.matches as CustomMatch[]).find(m=>m.id===privateRoomId.trim());const fallback:CustomMatch={id:privateRoomId.trim(),creator_wallet:"",mode:(result.mode??"duo") as CustomMatch["mode"],visibility:"private",max_players:result.maxPlayers??4,duration_seconds:result.durationSeconds??duration,status:result.status??"open",created_at:new Date().toISOString(),players_count:1};setSelected(found??fallback);setTeam(result.team);setChannel("all");setMessages([]);setLatestId(0);setNotice(result.message);setPrivateJoinPassword("");await refresh();}catch(error){setNotice(error instanceof Error?error.message:"Could not join this private lobby.");}finally{setBusy(false);}}}>Join private lobby</button></div>
    </div>}
    {activePanel==="browse"&&<div style={cardStyle}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><p className="td-overline">PUBLIC LOBBIES</p><h2>Find an open match</h2></div><button style={buttonStyle} onClick={()=>void refresh()}>Refresh</button></div>
      <p>Choose an open public room and join when a slot is available. Private rooms are not listed publicly; use the room ID and password in the private lobby panel.</p>
      <div style={{display:"grid",gap:10}}>{matches.length===0?<p>No public rooms open yet. Create one from Game modes.</p>:matches.map(match=><div key={match.id} style={{border:"1px solid var(--td-border)",borderRadius:8,padding:12,display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:12,alignItems:"center"}}><div><strong>{modeName(match.mode)}</strong><div style={{fontSize:12,color:"var(--td-muted)",marginTop:4}}>{match.players_count}/{match.max_players} players · {Math.round(match.duration_seconds/60)} min · {match.status}</div><div style={{fontSize:11,color:"var(--td-muted)",marginTop:4}}>Room {match.id.slice(0,8).toUpperCase()}</div></div><button style={buttonStyle} disabled={busy||match.players_count>=match.max_players||match.status!=="open"} onClick={()=>void join(match)}>{match.players_count>=match.max_players?"Full":match.status==="active"?"In progress":"Join"}</button></div>)}</div>
    </div>}
    {selected&&<div style={cardStyle}>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center"}}><div><p className="td-overline">ROOM {selected.id.slice(0,8).toUpperCase()}</p><h2>{modeName(selected.mode)} · Team {team??"—"}</h2></div><button style={buttonStyle} onClick={()=>setSelected(null)}>Close chat</button></div>
      <div style={{display:"flex",gap:8,margin:"12px 0"}}><button style={{...buttonStyle,opacity:channel==="all"?1:.65}} onClick={()=>{setChannel("all");setMessages([]);setLatestId(0)}}>All chat</button><button style={{...buttonStyle,opacity:channel==="team"?1:.65}} onClick={()=>{setChannel("team");setMessages([]);setLatestId(0)}}>Team chat</button></div>
      <div style={{maxHeight:260,overflowY:"auto",display:"grid",gap:8,padding:10,border:"1px solid var(--td-border)",borderRadius:8}}>{messages.map(m=><div key={m.id}><strong>{short(m.wallet)} · Team {m.team_number}</strong><div>{m.message}</div><small style={{color:"var(--td-muted)"}}>{new Date(m.created_at+"Z").toLocaleTimeString()}</small></div>)}{messages.length===0&&<p>No messages yet. Say hello to your match.</p>}</div>
      <form onSubmit={e=>{e.preventDefault();void send()}} style={{display:"flex",gap:8,marginTop:10}}><input style={fieldStyle} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={500} placeholder={channel==="all"?"Message everyone…":"Message your team…"} /><button style={buttonStyle} type="submit" disabled={!draft.trim()}>Send</button></form>
    </div>}
    {notice&&<p role="status" style={{color:"var(--td-muted)"}}>{notice}</p>}
    <p style={{fontSize:12,color:"var(--td-muted)"}}>Custom rooms and chat are in testing. This room browser does not yet launch these rooms into the existing on-chain activity tracking/settlement match engine.</p>
  </section>;
}
