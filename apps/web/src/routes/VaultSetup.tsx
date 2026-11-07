import { Link } from "@tanstack/react-router";
/**
 * Vault account setup, recovery and unlock. Keys are generated here, in the browser, and are
 * independent of any wallet. The recovery phrase must be confirmed before the account is
 * saved, so no deposit can happen before the backup check (PRD FR-15).
 */
import { useMemo, useState } from "react";
import { entropyToPhrase, isPhraseWord, newEntropy, phraseToEntropy } from "@curveil/vault-core";
import { createAccount, forgetDevice, readBackupFile, unlock } from "../lib/vault/store";

const MIN_PASSPHRASE = 10;

/** A password input with a show or hide toggle, so long passphrases can be checked before saving. */
function PasswordInput({ value, onChange, autoComplete, invalid, autoFocus, id }: { value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; autoFocus?: boolean; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="pass-wrap">
      <input id={id} className="text-input" type={show ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} />
      <button type="button" className="pass-toggle" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? "Hide passphrase" : "Show passphrase"}>{show ? "Hide" : "Show"}</button>
    </span>
  );
}

function PassphraseFields({ value, confirm, onValue, onConfirm }: { value: string; confirm: string; onValue: (v: string) => void; onConfirm: (v: string) => void }) {
  const short = value.length > 0 && value.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== value;
  const strength = Math.min(1, value.length / 20);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <label className="field">
        <span className="field-top"><span className="field-label">Passphrase for this browser</span><span className="field-count" data-over={short || undefined}>{value.length}/{MIN_PASSPHRASE} min</span></span>
        <PasswordInput value={value} onChange={onValue} autoComplete="new-password" invalid={short} />
        {value.length > 0 && (
          <span className="strength" aria-hidden="true"><span style={{ width: `${strength * 100}%`, background: strength < 0.5 ? "var(--bad)" : strength < 0.8 ? "var(--warn)" : "var(--good)" }} /></span>
        )}
        {short ? <span className="field-error">Use at least {MIN_PASSPHRASE} characters.</span> : <span className="field-hint">Encrypts the account on this device and protects backup files. It is not your recovery phrase and is never sent anywhere.</span>}
      </label>
      <label className="field">
        <span className="field-label">Type it again</span>
        <PasswordInput value={confirm} onChange={onConfirm} autoComplete="new-password" invalid={mismatch} />
        {mismatch && <span className="field-error">The two entries do not match.</span>}
        {!mismatch && confirm.length > 0 && confirm === value && !short && <span className="field-hint good-text">Matches.</span>}
      </label>
    </div>
  );
}

const passOk = (p: string, c: string) => p.length >= MIN_PASSPHRASE && p === c;

export function CreateVault({ onCancel }: { onCancel: () => void }) {
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
      setCheckError("One or more words do not match. Check your written copy; nothing has been saved yet.");
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
      setError(e instanceof Error ? e.message : "Could not save the account.");
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="create-title">
      <div className="row-between">
        <h2 id="create-title" style={{ margin: 0 }}>Create a vault account</h2>
        <ol className="mini-steps" aria-label="Setup steps">
          {(["phrase", "check", "passphrase"] as const).map((s, i) => (
            <li key={s} data-state={s === step ? "active" : ["phrase", "check", "passphrase"].indexOf(step) > i ? "done" : "todo"}>
              {["Recovery phrase", "Check", "Passphrase"][i]}
            </li>
          ))}
        </ol>
      </div>

      {step === "phrase" && (
        <>
          <p className="notice warn" style={{ margin: 0 }}>
            These 24 words are the only way to recover this vault account. Your wallet cannot recover it. Write them down on paper, in order, and keep them offline. Anyone with
            them can spend your shielded funds. Curveil will never ask for them.
          </p>
          <ol className="phrase-grid mono" aria-label="Recovery phrase">
            {words.map((w, i) => (
              <li key={i}>
                <span className="muted">{i + 1}</span> {w}
              </li>
            ))}
          </ol>
          <label className="check">
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} />
            <span>I wrote down all 24 words in order. I understand that losing them can mean losing my shielded funds for good.</span>
          </label>
          <div className="row-between">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" disabled={!wrote} onClick={() => setStep("check")}>Continue</button>
          </div>
        </>
      )}

      {step === "check" && (
        <>
          <p className="small muted" style={{ margin: 0 }}>Enter these words from your written copy. The account is saved only after this check passes.</p>
          <div className="grid-3">
            {positions.map((p, i) => (
              <label className="field" key={p}>
                <span className="field-label">Word {p + 1}</span>
                <input
                  className="text-input mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={answers[i]}
                  aria-invalid={answers[i]!.length > 2 && !isPhraseWord(answers[i]!)}
                  onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                />
                {answers[i]!.length > 2 && !isPhraseWord(answers[i]!) && <span className="field-error">Not a recovery word.</span>}
              </label>
            ))}
          </div>
          {checkError && <p className="notice bad" role="alert" style={{ margin: 0 }}>{checkError}</p>}
          <div className="row-between">
            <button className="btn" onClick={() => setStep("phrase")}>Show the words again</button>
            <button className="btn btn-primary" disabled={answers.some((a) => !a.trim())} onClick={check}>Check</button>
          </div>
        </>
      )}

      {step === "passphrase" && (
        <>
          <p className="notice good" style={{ margin: 0 }}>Backup check passed.</p>
          <PassphraseFields value={pass} confirm={confirm} onValue={setPass} onConfirm={setConfirm} />
          {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="row-between">
            <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={!passOk(pass, confirm) || busy} onClick={save}>{busy ? "Encrypting…" : "Save the account on this device"}</button>
          </div>
        </>
      )}
    </section>
  );
}

export function RecoverVault({ onCancel }: { onCancel: () => void }) {
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
      setError(e instanceof Error ? e.message : "Recovery failed.");
      setBusy(false);
    }
  }

  const ready = passOk(pass, confirm) && (mode === "phrase" ? phrase.trim().split(/\s+/).length === 24 : Boolean(file && filePass));

  return (
    <section className="panel stack" aria-labelledby="recover-title">
      <h2 id="recover-title" style={{ margin: 0 }}>Recover a vault account</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Recovery runs entirely in this browser. Your notes are rebuilt from the public encrypted events on-chain; nothing you type here is sent anywhere. This screen never asks for a
        wallet seed phrase.
      </p>
      <div className="choice-grid two" role="group" aria-label="Recover from">
        <button type="button" className="choice" aria-pressed={mode === "phrase"} onClick={() => setMode("phrase")}><strong>Recovery phrase</strong><span>The 24 words you wrote down.</span></button>
        <button type="button" className="choice" aria-pressed={mode === "file"} onClick={() => setMode("file")}><strong>Backup file</strong><span>An encrypted .json file and its passphrase.</span></button>
      </div>
      {mode === "phrase" ? (
        <label className="field">
          <span className="field-top"><span className="field-label">Your 24-word Curveil recovery phrase</span><span className="field-count">{phrase.trim() ? phrase.trim().split(/\s+/).length : 0}/24 words</span></span>
          <textarea className="text-input mono" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
      ) : (
        <div className="stack">
          <label className="upload">
            <span className="upload-thumb">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
            </span>
            <span className="upload-text">
              <strong>{file ? file.name : "Choose your backup file"}</strong>
              <span>{file ? "Ready. Choose again to use a different file." : "The encrypted .json file saved from the Backup tab."}</span>
            </span>
            <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Backup file" />
          </label>
          <label className="field">
            <span className="field-label">The passphrase that protected the backup file</span>
            <PasswordInput value={filePass} onChange={setFilePass} autoComplete="current-password" />
          </label>
        </div>
      )}
      <PassphraseFields value={pass} confirm={confirm} onValue={setPass} onConfirm={setConfirm} />
      {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="row-between">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={!ready || busy} onClick={recover}>{busy ? "Recovering…" : "Recover and scan"}</button>
      </div>
    </section>
  );
}

/**
 * The vault unlock, sized for a trade form: one line on why, the passphrase and the button on one
 * row. Recovery lives on the Vault page, linked below.
 */
export function UnlockInline() {
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
      setError(err instanceof Error ? err.message : "Could not unlock.");
      setBusy(false);
    }
  }
  return (
    <form className="vx-unlock" onSubmit={go} aria-label="Unlock your vault">
      <div className="vx-unlock-head">
        <span className="vx-lock" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3" /><rect x="4.5" y="11" width="15" height="10" rx="2" /></svg>
        </span>
        <span>
          <strong>Vault locked</strong>
          <span>Enter your passphrase to pay from your shielded balance.</span>
        </span>
      </div>
      <div className="vx-unlock-row">
        <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" invalid={Boolean(error)} />
        <button className="btn btn-primary" disabled={!pass || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
      </div>
      {error && <p className="small bad-ink" role="alert" style={{ margin: 0 }}>{error}</p>}
      <Link className="small muted vx-forgot" to="/app/vault">Forgot the passphrase?</Link>
    </form>
  );
}

export function UnlockVault() {
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
      setError(err instanceof Error ? err.message : "Could not unlock.");
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="unlock-title">
      <h2 id="unlock-title" style={{ margin: 0 }}>Unlock your vault</h2>
      <form className="stack" onSubmit={go}>
        <label className="field">
          <span className="small muted">Vault passphrase</span>
          <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" disabled={!pass || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
      </form>
      <details>
        <summary className="small muted">Forgot the passphrase?</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="small muted" style={{ margin: 0 }}>
            Remove this browser's copy, then recover from your 24-word phrase and set a new passphrase. Without the phrase or a backup file, removing it loses the account.
          </p>
          <label className="check">
            <input type="checkbox" checked={forgetting} onChange={(e) => setForgetting(e.target.checked)} />
            <span>I have my recovery phrase or a backup file.</span>
          </label>
          <button className="btn" disabled={!forgetting} onClick={() => void forgetDevice()}>Remove this browser's copy</button>
        </div>
      </details>
    </section>
  );
}
