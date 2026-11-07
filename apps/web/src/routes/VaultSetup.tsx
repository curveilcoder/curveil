import { Link } from "@tanstack/react-router";
/**
 * Vault account setup, recovery and unlock. Keys are generated here, in the browser, and are
 * independent of any wallet. The recovery phrase must be confirmed before the account is
 * saved, so no deposit can happen before the backup check (PRD FR-15).
 */
import { useMemo, useState } from "react";
import { entropyToPhrase, isPhraseWord, newEntropy, phraseToEntropy } from "@curveil/vault-core";
import { createAccount, forgetDevice, readBackupFile, unlock } from "../lib/vault/store";
import { useT } from "../lib/i18n";

const MIN_PASSPHRASE = 10;

/** A password input with a show or hide toggle, so long passphrases can be checked before saving. */
function PasswordInput({ value, onChange, autoComplete, invalid, autoFocus, id }: { value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; autoFocus?: boolean; id?: string }) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <span className="pass-wrap">
      <input id={id} className="text-input" type={show ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} />
      <button type="button" className="pass-toggle" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? t("Hide passphrase", "隐藏密码") : t("Show passphrase", "显示密码")}>{show ? t("Hide", "隐藏") : t("Show", "显示")}</button>
    </span>
  );
}

function PassphraseFields({ value, confirm, onValue, onConfirm }: { value: string; confirm: string; onValue: (v: string) => void; onConfirm: (v: string) => void }) {
  const t = useT();
  const short = value.length > 0 && value.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== value;
  const strength = Math.min(1, value.length / 20);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <label className="field">
        <span className="field-top"><span className="field-label">{t("Passphrase for this browser", "本浏览器的密码")}</span><span className="field-count" data-over={short || undefined}>{t(`${value.length}/${MIN_PASSPHRASE} min`, `${value.length}/${MIN_PASSPHRASE} 最少`)}</span></span>
        <PasswordInput value={value} onChange={onValue} autoComplete="new-password" invalid={short} />
        {value.length > 0 && (
          <span className="strength" aria-hidden="true"><span style={{ width: `${strength * 100}%`, background: strength < 0.5 ? "var(--bad)" : strength < 0.8 ? "var(--warn)" : "var(--good)" }} /></span>
        )}
        {short ? <span className="field-error">{t(`Use at least ${MIN_PASSPHRASE} characters.`, `至少使用 ${MIN_PASSPHRASE} 个字符。`)}</span> : <span className="field-hint">{t("Encrypts the account on this device and protects backup files. It is not your recovery phrase and is never sent anywhere.", "用于在本设备上加密账户并保护备份文件。它不是你的恢复短语，也不会发送到任何地方。")}</span>}
      </label>
      <label className="field">
        <span className="field-label">{t("Type it again", "再输入一次")}</span>
        <PasswordInput value={confirm} onChange={onConfirm} autoComplete="new-password" invalid={mismatch} />
        {mismatch && <span className="field-error">{t("The two entries do not match.", "两次输入不一致。")}</span>}
        {!mismatch && confirm.length > 0 && confirm === value && !short && <span className="field-hint good-text">{t("Matches.", "一致。")}</span>}
      </label>
    </div>
  );
}

const passOk = (p: string, c: string) => p.length >= MIN_PASSPHRASE && p === c;

export function CreateVault({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const [entropy] = useState(() => newEntropy());
  const words = useMemo(() => entropyToPhrase(entropy).split(" "), [entropy]);
  const [step, setStep] = useState<"phrase" | "check" | "passphrase">("phrase");
  const [wrote, setWrote] = useState(false);
  // Three random positions to confirm.
  const [positions] = useState(() => {
    const set = new Set<number>();
    const r = new Uint32Array(8);
    crypto.getRandomValues(r);
    for (const x of r) {
      set.add(x % 24);
      if (set.size === 3) break;
    }
    while (set.size < 3) set.add(set.size * 7);
    return [...set].sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function check() {
    const ok = positions.every((p, i) => answers[i]!.trim().toLowerCase() === words[p]);
    if (!ok) {
      setCheckError(t("One or more words do not match. Check your written copy; nothing has been saved yet.", "有单词不匹配。请核对你写下的副本，目前还没有保存任何内容。"));
      return;
    }
    setCheckError(null);
    setStep("passphrase");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await createAccount(entropy, pass, { recovered: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Could not save the account.", "无法保存账户。"));
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="create-title">
      <div className="row-between">
        <h2 id="create-title" style={{ margin: 0 }}>{t("Create a vault account", "创建金库账户")}</h2>
        <ol className="mini-steps" aria-label={t("Setup steps", "设置步骤")}>
          {(["phrase", "check", "passphrase"] as const).map((s, i) => (
            <li key={s} data-state={s === step ? "active" : ["phrase", "check", "passphrase"].indexOf(step) > i ? "done" : "todo"}>
              {t(["Recovery phrase", "Check", "Passphrase"], ["恢复短语", "核对", "密码"])[i]}
            </li>
          ))}
        </ol>
      </div>

      {step === "phrase" && (
        <>
          <p className="notice warn" style={{ margin: 0 }}>
            {t(`These 24 words are the only way to recover this vault account. Your wallet cannot recover it. Write them down on paper, in order, and keep them offline. Anyone with
            them can spend your shielded funds. Curveil will never ask for them.`, "这 24 个单词是恢复此金库账户的唯一方式，你的钱包无法恢复它。请按顺序写在纸上并离线保存。任何拿到它们的人都能动用你的隐私资金。Curveil 永远不会向你索要它们。")}
          </p>
          <ol className="phrase-grid mono" aria-label={t("Recovery phrase", "恢复短语")}>
            {words.map((w, i) => (
              <li key={i}>
                <span className="muted">{i + 1}</span> {w}
              </li>
            ))}
          </ol>
          <label className="check">
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} />
            <span>{t("I wrote down all 24 words in order. I understand that losing them can mean losing my shielded funds for good.", "我已按顺序写下全部 24 个单词。我明白丢失它们可能意味着永久失去我的隐私资金。")}</span>
          </label>
          <div className="row-between">
            <button className="btn" onClick={onCancel}>{t("Cancel", "取消")}</button>
            <button className="btn btn-primary" disabled={!wrote} onClick={() => setStep("check")}>{t("Continue", "继续")}</button>
          </div>
        </>
      )}

      {step === "check" && (
        <>
          <p className="small muted" style={{ margin: 0 }}>{t("Enter these words from your written copy. The account is saved only after this check passes.", "请根据你写下的副本输入这些单词。只有核对通过后才会保存账户。")}</p>
          <div className="grid-3">
            {positions.map((p, i) => (
              <label className="field" key={p}>
                <span className="field-label">{t(`Word ${p + 1}`, `第 ${p + 1} 个单词`)}</span>
                <input
                  className="text-input mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={answers[i]}
                  aria-invalid={answers[i]!.length > 2 && !isPhraseWord(answers[i]!)}
                  onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                />
                {answers[i]!.length > 2 && !isPhraseWord(answers[i]!) && <span className="field-error">{t("Not a recovery word.", "不是恢复短语中的单词。")}</span>}
              </label>
            ))}
          </div>
          {checkError && <p className="notice bad" role="alert" style={{ margin: 0 }}>{checkError}</p>}
          <div className="row-between">
            <button className="btn" onClick={() => setStep("phrase")}>{t("Show the words again", "再次显示单词")}</button>
            <button className="btn btn-primary" disabled={answers.some((a) => !a.trim())} onClick={check}>{t("Check", "核对")}</button>
          </div>
        </>
      )}

      {step === "passphrase" && (
        <>
          <p className="notice good" style={{ margin: 0 }}>{t("Backup check passed.", "备份核对通过。")}</p>
          <PassphraseFields value={pass} confirm={confirm} onValue={setPass} onConfirm={setConfirm} />
          {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="row-between">
            <button className="btn" onClick={onCancel} disabled={busy}>{t("Cancel", "取消")}</button>
            <button className="btn btn-primary" disabled={!passOk(pass, confirm) || busy} onClick={save}>{busy ? t("Encrypting…", "正在加密…") : t("Save the account on this device", "在本设备上保存账户")}</button>
          </div>
        </>
      )}
    </section>
  );
}

export function RecoverVault({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<"phrase" | "file">("phrase");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePass, setFilePass] = useState("");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recover() {
    setBusy(true);
    setError(null);
    try {
      const entropy = mode === "phrase" ? phraseToEntropy(phrase) : await readBackupFile(file!, filePass);
      await createAccount(entropy, pass, { recovered: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Recovery failed.", "恢复失败。"));
      setBusy(false);
    }
  }

  const ready = passOk(pass, confirm) && (mode === "phrase" ? phrase.trim().split(/\s+/).length === 24 : Boolean(file && filePass));

  return (
    <section className="panel stack" aria-labelledby="recover-title">
      <h2 id="recover-title" style={{ margin: 0 }}>{t("Recover a vault account", "恢复金库账户")}</h2>
      <p className="small muted" style={{ margin: 0 }}>
        {t(`Recovery runs entirely in this browser. Your notes are rebuilt from the public encrypted events on-chain; nothing you type here is sent anywhere. This screen never asks for a
        wallet seed phrase.`, "恢复完全在本浏览器中进行。你的票据会根据链上公开的加密事件重建，你在这里输入的任何内容都不会发送出去。本页面永远不会索要钱包助记词。")}
      </p>
      <div className="choice-grid two" role="group" aria-label={t("Recover from", "恢复方式")}>
        <button type="button" className="choice" aria-pressed={mode === "phrase"} onClick={() => setMode("phrase")}><strong>{t("Recovery phrase", "恢复短语")}</strong><span>{t("The 24 words you wrote down.", "你写下的 24 个单词。")}</span></button>
        <button type="button" className="choice" aria-pressed={mode === "file"} onClick={() => setMode("file")}><strong>{t("Backup file", "备份文件")}</strong><span>{t("An encrypted .json file and its passphrase.", "加密的 .json 文件及其密码。")}</span></button>
      </div>
      {mode === "phrase" ? (
        <label className="field">
          <span className="field-top"><span className="field-label">{t("Your 24-word Curveil recovery phrase", "你的 24 个单词 Curveil 恢复短语")}</span><span className="field-count">{phrase.trim() ? phrase.trim().split(/\s+/).length : 0}/24 {t("words", "个单词")}</span></span>
          <textarea className="text-input mono" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
      ) : (
        <div className="stack">
          <label className="upload">
            <span className="upload-thumb">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
            </span>
            <span className="upload-text">
              <strong>{file ? file.name : t("Choose your backup file", "选择你的备份文件")}</strong>
              <span>{file ? t("Ready. Choose again to use a different file.", "已就绪。重新选择可换用其他文件。") : t("The encrypted .json file saved from the Backup tab.", "从“备份”页保存的加密 .json 文件。")}</span>
            </span>
            <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={t("Backup file", "备份文件")} />
          </label>
          <label className="field">
            <span className="field-label">{t("The passphrase that protected the backup file", "保护该备份文件的密码")}</span>
            <PasswordInput value={filePass} onChange={setFilePass} autoComplete="current-password" />
          </label>
        </div>
      )}
      <PassphraseFields value={pass} confirm={confirm} onValue={setPass} onConfirm={setConfirm} />
      {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="row-between">
        <button className="btn" onClick={onCancel} disabled={busy}>{t("Cancel", "取消")}</button>
        <button className="btn btn-primary" disabled={!ready || busy} onClick={recover}>{busy ? t("Recovering…", "正在恢复…") : t("Recover and scan", "恢复并扫描")}</button>
      </div>
    </section>
  );
}

/**
 * The vault unlock, sized for a trade form: one line on why, the passphrase and the button on one
 * row. Recovery lives on the Vault page, linked below.
 */
export function UnlockInline() {
  const t = useT();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(pass);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not unlock.", "无法解锁。"));
      setBusy(false);
    }
  }
  return (
    <form className="vx-unlock" onSubmit={go} aria-label={t("Unlock your vault", "解锁你的金库")}>
      <div className="vx-unlock-head">
        <span className="vx-lock" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3" /><rect x="4.5" y="11" width="15" height="10" rx="2" /></svg>
        </span>
        <span>
          <strong>{t("Vault locked", "金库已锁定")}</strong>
          <span>{t("Enter your passphrase to pay from your shielded balance.", "输入密码即可用你的隐私余额付款。")}</span>
        </span>
      </div>
      <div className="vx-unlock-row">
        <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" invalid={Boolean(error)} />
        <button className="btn btn-primary" disabled={!pass || busy}>{busy ? t("Unlocking…", "正在解锁…") : t("Unlock", "解锁")}</button>
      </div>
      {error && <p className="small bad-ink" role="alert" style={{ margin: 0 }}>{error}</p>}
      <Link className="small muted vx-forgot" to="/app/vault">{t("Forgot the passphrase?", "忘记密码？")}</Link>
    </form>
  );
}

export function UnlockVault() {
  const t = useT();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(pass);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not unlock.", "无法解锁。"));
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="unlock-title">
      <h2 id="unlock-title" style={{ margin: 0 }}>{t("Unlock your vault", "解锁你的金库")}</h2>
      <form className="stack" onSubmit={go}>
        <label className="field">
          <span className="small muted">{t("Vault passphrase", "金库密码")}</span>
          <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" disabled={!pass || busy}>{busy ? t("Unlocking…", "正在解锁…") : t("Unlock", "解锁")}</button>
      </form>
      <details>
        <summary className="small muted">{t("Forgot the passphrase?", "忘记密码？")}</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="small muted" style={{ margin: 0 }}>
            {t("Remove this browser's copy, then recover from your 24-word phrase and set a new passphrase. Without the phrase or a backup file, removing it loses the account.", "先删除本浏览器中的副本，然后用你的 24 个单词恢复短语恢复并设置新密码。如果没有恢复短语或备份文件，删除后账户将永久丢失。")}
          </p>
          <label className="check">
            <input type="checkbox" checked={forgetting} onChange={(e) => setForgetting(e.target.checked)} />
            <span>{t("I have my recovery phrase or a backup file.", "我有恢复短语或备份文件。")}</span>
          </label>
          <button className="btn" disabled={!forgetting} onClick={() => void forgetDevice()}>{t("Remove this browser's copy", "删除本浏览器中的副本")}</button>
        </div>
      </details>
    </section>
  );
}
