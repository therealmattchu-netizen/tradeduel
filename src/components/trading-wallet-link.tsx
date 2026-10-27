import { useEffect, useState } from "react";
import { createTradingWalletChallenge, getMyTradingWallet, verifyTradingWallet } from "@/lib/api/arena.functions";

type Provider = {
  publicKey?: { toString(): string };
  connect: () => Promise<{ publicKey?: { toString(): string } } | void>;
  signMessage: (message: Uint8Array, display?: "utf8") => Promise<{ signature: Uint8Array } | Uint8Array>;
};
declare global {
  interface Window {
    phantom?: { solana?: Provider };
    solflare?: Provider;
    backpack?: Provider | { solana?: Provider };
  }
}
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const b64 = (bytes: Uint8Array) => { let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s); };
const short = (value: string) => value.length > 14 ? value.slice(0,6)+"…"+value.slice(-5) : value;

function providerChoices(): Array<{name:string;provider:Provider}> {
  if(typeof window==="undefined") return [];
  const backpack = window.backpack && "solana" in window.backpack ? window.backpack.solana : window.backpack as Provider|undefined;
  const choices = [
    {name:"Phantom",provider:window.phantom?.solana},
    {name:"Solflare",provider:window.solflare},
    {name:"Backpack",provider:backpack},
  ];
  return choices.filter((item):item is {name:string;provider:Provider}=>Boolean(item.provider?.connect&&item.provider?.signMessage));
}

export function TradingWalletLink() {
  const [address,setAddress]=useState("");
  const [saved,setSaved]=useState<string|null>(null);
  const [providerName,setProviderName]=useState("Phantom");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [providers,setProviders]=useState<Array<{name:string;provider:Provider}>>([]);
  useEffect(()=>{setProviders(providerChoices());const token=window.sessionStorage.getItem("td_session_token");if(token)void getMyTradingWallet({data:{token}}).then(r=>{setSaved(r.tradingWallet);setAddress(r.tradingWallet??"")}).catch(()=>{});},[]);
  const verify=async()=>{
    const normalized=address.trim();
    if(!WALLET_RE.test(normalized)){setNotice("Enter a valid Solana public address.");return;}
    const choice=providers.find(p=>p.name===providerName);
    if(!choice){setNotice(providerName+" was not detected. Install/enable it and reload.");return;}
    const token=window.sessionStorage.getItem("td_session_token")||"";
    if(!token){setNotice("Reconnect your TradeDuel account wallet first.");return;}
    setBusy(true);setNotice("Connect the trading wallet and approve a message signature…");
    try{
      const connected=await choice.provider.connect();
      const connectedAddress=(connected&&typeof connected==="object"&&"publicKey" in connected?connected.publicKey:undefined)?.toString()??choice.provider.publicKey?.toString()??"";
      if(connectedAddress!==normalized)throw new Error("The connected "+choice.name+" address does not match the pasted trading address. Connect the wallet that owns the pump.fun address.");
      const challenge=await createTradingWalletChallenge({data:{token,tradingWallet:normalized}});
      const signed=await choice.provider.signMessage(new TextEncoder().encode(challenge.message),"utf8");
      const signature=signed instanceof Uint8Array?signed:signed.signature;
      const result=await verifyTradingWallet({data:{token,tradingWallet:normalized,nonce:challenge.nonce,signature:b64(signature)}});
      setSaved(result.tradingWallet);setNotice(result.message+" Note: live match scoring integration is not active until the tracker is switched to this verified address.");
    }catch(error){setNotice(error instanceof Error?error.message:"Could not verify trading wallet.");}
    finally{setBusy(false);}
  };
  const disconnect=()=>{setSaved(null);setAddress("");setNotice("Removing a trading-wallet link is not enabled here yet. Contact support before changing wallets.");};
  return <section className="td-trading-wallet-link" style={{marginTop:18,padding:16,border:"1px solid rgba(167,139,250,.28)",borderRadius:12,background:"rgba(124,58,237,.07)"}}>
    <div className="td-mini-label">TRADE TRACKING WALLET</div>
    <h3 style={{margin:"8px 0"}}>Link your pump.fun trading wallet</h3>
    <p style={{fontSize:13,lineHeight:1.55,opacity:.82}}>Your connected wallet remains your TradeDuel login. Add the public address you use to ape into new coins, then sign a one-time message from that exact wallet to prove ownership. Never paste a seed phrase or private key.</p>
    {saved&&<p role="status" style={{fontSize:13}}>Verified address: <strong>{short(saved)}</strong></p>}
    <label style={{display:"block",fontSize:12,marginBottom:6}} htmlFor="td-trading-wallet-address">Pump.fun wallet public address</label>
    <input id="td-trading-wallet-address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="Paste Solana public address" autoComplete="off" spellCheck={false} style={{width:"100%",boxSizing:"border-box",padding:"11px 12px",borderRadius:8,border:"1px solid rgba(167,139,250,.35)",background:"#0c0b14",color:"#f7f5ff"}}/>
    <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
      <select aria-label="Wallet used to sign verification" value={providerName} onChange={e=>setProviderName(e.target.value)} style={{flex:"1 1 120px",padding:"10px",borderRadius:8,background:"#171324",color:"#f7f5ff",border:"1px solid rgba(167,139,250,.35)"}}>
        {["Phantom","Solflare","Backpack"].map(name=><option key={name} value={name}>{name}</option>)}
      </select>
      <button type="button" className="td-primary-action" onClick={()=>void verify()} disabled={busy}>{busy?"Verifying…":"Verify trading wallet"}</button>
    </div>
    {notice&&<p role="status" aria-live="polite" style={{fontSize:12,lineHeight:1.5,marginBottom:0}}>{notice}</p>}
    <small style={{display:"block",marginTop:10,opacity:.65}}>Verification is message-signature only; no transaction is sent.</small>
  </section>;
}
