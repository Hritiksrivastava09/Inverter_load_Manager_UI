import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 3000;

async function api(path, options) {
  try {
    const res = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" }, ...options });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data };
    const d = data.detail;
    let message = "Something went wrong.";
    if (typeof d === "string") message = d;
    else if (Array.isArray(d)) message = d.map((e) => `${e.loc?.slice(-1)[0]}: ${e.msg}`).join("; ");
    else if (d?.message) message = d.message;
    return { ok: false, message };
  } catch {
    return { ok: false, message: "Can't reach the server. Is the backend running on port 8000?" };
  }
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

export default function App() {
  const [snap, setSnap] = useState(null);
  const [events, setEvents] = useState([]);
  const [notices, setNotices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState(null); // appliance whose switch was just clicked
  const [tab, setTab] = useState("all");
  const nid = useRef(0);

  const notify = useCallback((kind, text) => {
    const id = ++nid.current;
    setNotices((n) => [...n, { id, kind, text }].slice(-5));
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 9000);
  }, []);

  const refresh = useCallback(async () => {
    const [s, e] = await Promise.all([api("/state"), api("/events?limit=40")]);
    if (s.ok) setSnap(s.data);
    if (e.ok) setEvents(e.data);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(path, options, id = null) {
    setBusy(true);
    setPendingId(id);
    const r = await api(path, options);
    if (r.ok) {
      (r.data.changes || []).forEach((c) => notify(c.type === "shed" ? "shed" : "restore", c.message));
      if (r.data.state) setSnap(r.data.state);
    } else {
      notify("error", r.message);
    }
    await refresh();
    setPendingId(null);
    setBusy(false);
    return r;
  }

  if (!snap) return <main className="page"><p>Connecting to the inverter…</p></main>;

  const { appliances, load_w, free_w, capacity_w } = snap;
  const running = appliances.filter((a) => a.state === "running").sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const waiting = appliances.filter((a) => a.state === "shed").sort((a, b) => a.priority - b.priority || a.shed_seq - b.shed_seq);
  const maxPrio = Math.max(3, ...appliances.map((a) => a.priority));
  const counts = { all: appliances.length, running: running.length, shed: waiting.length, off: appliances.length - running.length - waiting.length };
  const shown = tab === "all" ? appliances : appliances.filter((a) => (tab === "running" ? a.state === "running" : a.state === tab));
  const TABS = [["all", "All"], ["running", "Running"], ["shed", "Shed"], ["off", "Off"]];
  const pct = Math.round((load_w / capacity_w) * 100);

  const shade = (p) => `hsl(165 ${55 - (p - 1) * 4}% ${22 + ((p - 1) / Math.max(1, maxPrio - 1)) * 28}%)`;

  const toggle = (a) => act(`/appliances/${a.id}/${a.state === "running" || a.state === "shed" ? "off" : "on"}`, { method: "POST" }, a.id);
  const tryNow = (a) => act(`/appliances/${a.id}/on`, { method: "POST" }, a.id);
  const remove = (a) => { if (window.confirm(`Delete ${a.name}?`)) act(`/appliances/${a.id}`, { method: "DELETE" }); };

  return (
    <main className="page">
      <h1>Inverter Load Manager</h1>

      <section className="card capacity">
        <div className="cap-top">
          <div><span className="big">{load_w} W</span> <span className="mute">in use of {capacity_w} W</span></div>
          <div className="free">{free_w} W free</div>
        </div>
        <div className="bar" role="img" aria-label={`${load_w} of ${capacity_w} watts in use`}>
          {running.map((a) => (
            <div key={a.id} className="seg" style={{ width: `${(a.wattage / capacity_w) * 100}%`, background: shade(a.priority) }} title={`${a.name}: ${a.wattage} W (priority ${a.priority})`}>
              {a.wattage / capacity_w > 0.07 && a.name}
            </div>
          ))}
        </div>
        <div className="cap-bottom">
          <span className="mute">{pct}% loaded. Darker segments are higher priority.</span>
          {waiting.length > 0 && (
            <span className="waiting-note">Waiting for power: {waiting.map((a) => `${a.name} (${a.wattage} W)`).join(", ")}</span>
          )}
        </div>
      </section>

      {/* <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`}>
            <span>{n.text}</span>
            <button onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div> */}

      <div className="grid">
        <section className="col">
          <h2>Appliances</h2>
          <div className="tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab ${k} ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
                {label} <span className="count">{counts[k]}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 && <p className="mute">{appliances.length === 0 ? "No appliances yet. Add one on the right." : `Nothing is ${tab} right now.`}</p>}
          <ul className="list">
            {shown.map((a) => {
              const need = Math.max(0, a.wattage - free_w);
              const label = a.state === "running" ? "Running" : a.state === "shed" ? "Paused, waiting" : "Off";
              // While the request is in flight, show the switch where the user is sending it.
              // If the server rejects the request, it slides back when the real state arrives.
              const pending = pendingId === a.id;
              const view = pending ? (a.state === "running" ? "off" : "running") : a.state;
              return (
                <li key={a.id} className={`row ${a.state}`}>
                  <span className="dot" />
                  <div className="info">
                    <div className="title">
                      <span className="name">{a.name}</span>
                      <span className="meta">{a.wattage} W</span>
                      <span className="pill">Priority {a.priority}</span>
                    </div>
                    {a.state === "shed" && (
                      <p className="why">
                        Paused by the system. {need > 0 ? `Needs ${need} W more free to come back.` : "Enough power is free now; it will return shortly."} It returns on its own, highest priority first.
                      </p>
                    )}
                  </div>
                  <span className={`badge ${a.state}`}>{label}</span>
                  {a.state === "shed" ? (
                    <>
                      <button className="btn dark" disabled={busy} onClick={() => tryNow(a)}>Try now</button>
                      <button className="btn" disabled={busy} onClick={() => toggle(a)} title="Stop waiting; it stays off until you switch it on">Stop waiting</button>
                    </>
                  ) : (
                    <button
                      role="switch"
                      aria-checked={view === "running"}
                      aria-label={a.state === "running" ? `Turn ${a.name} off` : `Turn ${a.name} on`}
                      className={`toggle ${view}${pending ? " pending" : ""}`}
                      disabled={busy}
                      onClick={() => toggle(a)}
                    ><span className="knob" /></button>
                  )}
                  <button className="link" disabled={busy} onClick={() => remove(a)}>Delete</button>
                </li>
              );
            })}
          </ul>
        </section>

        <aside className="col">
          <AddForm busy={busy} onAdd={(body) => act("/appliances", { method: "POST", body: JSON.stringify(body) })} />
          {/* <section className="card logcard">
            <h2>What happened</h2>
            {events.length === 0 && <p className="mute">Nothing yet.</p>}
            <ul className="log">
              {events.map((e) => (
                <li key={e.id} className={e.kind}><time>{fmtTime(e.ts)}</time><span>{e.message}</span></li>
              ))}
            </ul>
          </section> */}
        </aside>
      </div>
    </main>
  );
}

function AddForm({ onAdd, busy }) {
  const [name, setName] = useState("");
  const [wattage, setWattage] = useState("");
  const [priority, setPriority] = useState("1");

  async function submit(e) {
    e.preventDefault();
    const r = await onAdd({ name, wattage: Number(wattage), priority: Number(priority) });
    if (r.ok) { setName(""); setWattage(""); }
  }

  return (
    <section className="card">
      <h2>Add an appliance</h2>
      <form className="form" onSubmit={submit}>
        <label className="full">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Refrigerator" required maxLength={60} /></label>
        <label>Watts<input type="number" min="1" step="1" value={wattage} onChange={(e) => setWattage(e.target.value)} placeholder="300" required /></label>
        <label>Priority<input type="number" min="1" step="1" value={priority} onChange={(e) => setPriority(e.target.value)} required /></label>
        <p className="mute hint full">Priority 1 is the most important. Wattage and priority can't be changed later.</p>
        <button type="submit" className="btn dark full" disabled={busy}>Add appliance</button>
      </form>
    </section>
  );
}