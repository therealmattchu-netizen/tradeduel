import { useEffect, useRef, useState } from "react";
import { getMyProfile, updateMyProfile } from "@/lib/api/arena.functions";

function shortWallet(wallet: string) { return wallet ? wallet.slice(0, 4) + "…" + wallet.slice(-4) : "Wallet"; }

export function PlayerProfileMenu() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [wallet, setWallet] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refreshSession = () => {
      const nextToken = window.sessionStorage.getItem("td_session_token") || "";
      setToken(nextToken);
      setWallet(window.sessionStorage.getItem("td_session_wallet") || "");
      if (nextToken) void getMyProfile({ data: { token: nextToken } }).then((profile) => {
        setDisplayName(profile.displayName || "");
        setAvatar(profile.avatarDataUrl || null);
      }).catch(() => {});
    };
    refreshSession();
    window.addEventListener("storage", refreshSession);
    window.addEventListener("tradeduel:wallet-session", refreshSession);
    return () => {
      window.removeEventListener("storage", refreshSession);
      window.removeEventListener("tradeduel:wallet-session", refreshSession);
    };
  }, []);

  const resizeAvatar = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
    if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
    const source = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 256 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not process the image.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close();
    let quality = 0.82;
    let dataUrl = canvas.toDataURL("image/webp", quality);
    while (dataUrl.length > 170_000 && quality > 0.35) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/webp", quality);
    }
    if (dataUrl.length > 180_000) throw new Error("This image could not be compressed enough. Try a simpler image.");
    return dataUrl;
  };

  const save = async (nextAvatar: string | null = avatar) => {
    if (!token) return;
    setBusy(true); setNotice("");
    try {
      const result = await updateMyProfile({ data: { token, displayName, avatarDataUrl: nextAvatar } });
      setDisplayName(result.displayName);
      setAvatar(result.avatarDataUrl);
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save profile.");
    } finally { setBusy(false); }
  };

  const chooseImage = async (file?: File) => {
    if (!file) return;
    setBusy(true); setNotice("");
    try {
      const dataUrl = await resizeAvatar(file);
      const result = await updateMyProfile({ data: { token, displayName, avatarDataUrl: dataUrl } });
      setAvatar(result.avatarDataUrl); setDisplayName(result.displayName); setNotice("Profile picture updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update profile picture.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return <div className="td-profile-wrap">
    <button className="td-profile-trigger" type="button" aria-label={token ? "Open player profile" : "Wallet not connected"} onClick={() => setOpen(value => !value)}>
      <span className="td-avatar">{avatar ? <img src={avatar} alt="" /> : <span>{wallet ? wallet.slice(0, 1).toUpperCase() : "?"}</span>}</span>
      <span className="td-profile-trigger-copy"><strong>{displayName || (wallet ? shortWallet(wallet) : "Guest")}</strong><small>{wallet ? "PLAYER PROFILE" : "CONNECT WALLET"}</small></span>
      <span className="td-profile-chevron">⌄</span>
    </button>
    {open && <div className="td-profile-popover">
      <div className="td-profile-popover-head"><span className="td-mini-label">PLAYER IDENTITY</span><button type="button" aria-label="Close profile" onClick={() => setOpen(false)}>×</button></div>
      {!token ? <p className="td-profile-help">Connect and verify your Solana wallet in the arena to customize your profile.</p> : <>
        <div className="td-profile-editor">
          <span className="td-avatar td-avatar-large">{avatar ? <img src={avatar} alt="Your profile picture" /> : <span>{wallet.slice(0, 1).toUpperCase()}</span>}</span>
          <div><strong>{displayName || "Anonymous player"}</strong><small>{shortWallet(wallet)}</small></div>
        </div>
        <button type="button" className="td-profile-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Saving…" : avatar ? "Change profile picture" : "Upload profile picture"}</button>
        <label className="td-profile-label">DISPLAY NAME<input value={displayName} maxLength={24} onChange={event => setDisplayName(event.target.value)} placeholder="Choose a player name" /></label>
        <button type="button" className="td-profile-save" disabled={busy} onClick={() => void save(avatar)}>{busy ? "Saving…" : "Save profile"}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => void chooseImage(event.target.files?.[0])} />
        <p className="td-profile-help">PNG, JPEG or WebP · cropped to 256 px · max 8 MB upload. Your saved avatar is linked to your verified wallet.</p>
      </>}
      {notice && <p className="td-profile-notice" role="status">{notice}</p>}
    </div>}
  </div>;
}
