import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check, ChevronLeft, ChevronRight, CircleCheck, Clock, Copy, Download, Eye, EyeOff, GitMerge, Hourglass,
  KeyRound, ListChecks, LoaderCircle, Lock, LockOpen, MonitorPlay, Pencil, RotateCcw, Send, Settings2,
  Trophy, Undo2, Users, WifiOff, X,
} from 'lucide-react';

/* Recap Room: participant (/), projector (?view=dashboard), facilitator (?view=facilitator) */

const view = new URLSearchParams(window.location.search).get('view');

export default function App() {
  return (
    <>
      <style>{CSS}</style>
      {view === 'dashboard' ? <Dashboard /> : view === 'facilitator' ? <Facilitator /> : <Participant />}
    </>
  );
}

/* ================= SOCKET ================= */

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:4000';

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'],
  // Sent with every (re)connection so the server knows this phone before any queued tap arrives
  auth: (cb) => {
    try {
      cb({ deviceId: getDeviceId() });
    } catch {
      cb({});
    }
  },
});

function emit(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, error: 'Connection problem. Please try again.' } : res);
    });
  });
}

function useSessionState() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onState = (s) => setState(s);
    const onConnect = () => {
      setConnected(true);
      socket.emit('state:get');
    };
    const onDisconnect = () => setConnected(false);
    socket.on('state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) socket.emit('state:get');
    return () => {
      socket.off('state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return { state, connected };
}

/* ================= HELPERS ================= */

const DEVICE_KEY = 'recap-room-device';

const randomId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    if (!window.__recapDevice) window.__recapDevice = randomId();
    return window.__recapDevice;
  }
}

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function teamName(teams, id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : `Team ${id}`;
}

function teamLabel(statement, teams) {
  return [statement.teamId, ...(statement.alsoFrom || [])].map((id) => teamName(teams, id)).join(' & ');
}

const joinUrl = () => `${window.location.origin}${window.location.pathname}`;

/* ================= LOGO ================= */

function Logo({ className = '' }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`logo-text ${className}`}>carnelian</span>;
  return <img className={className} src="/logo.png" alt="Carnelian" onError={() => setFailed(true)} />;
}

/* ================= PARTICIPANT ================= */

function Participant() {
  const { state, connected } = useSessionState();
  const [me, setMe] = useState({ captainTeamId: null, votedIds: null });

  useEffect(() => {
    const deviceId = getDeviceId();
    const hello = () => socket.emit('hello', { deviceId });
    const onMe = (m) => setMe(m);
    socket.on('connect', hello);
    socket.on('me', onMe);
    if (socket.connected) hello();
    return () => {
      socket.off('connect', hello);
      socket.off('me', onMe);
    };
  }, []);

  let body;
  if (!state) {
    body = <StateCard icon={LoaderCircle} spin title="Connecting" text="One moment." />;
  } else if (state.phase === 'setup') {
    body = <StateCard icon={Clock} title="We'll begin shortly" text="Keep this page open. It updates on its own." />;
  } else if (state.phase === 'submit') {
    body = me.captainTeamId ? <CaptainDone state={state} teamId={me.captainTeamId} /> : <CaptainFlow state={state} />;
  } else if (state.phase === 'review') {
    body = me.captainTeamId ? (
      <CaptainDone state={state} teamId={me.captainTeamId} />
    ) : (
      <StateCard icon={Hourglass} title="Voting opens in a moment" text="All team takeaways are in. Keep this page open." />
    );
  } else if (state.phase === 'vote') {
    body = me.votedIds ? <VoteDone state={state} ids={me.votedIds} /> : <VoteFlow state={state} />;
  } else {
    body = <RevealView state={state} />;
  }

  return (
    <div className="p-shell">
      <header className="p-top">
        <Logo className="p-logo" />
        {state && <div className="p-title">{state.title}</div>}
      </header>
      {!connected && state && (
        <div className="p-offline">
          <WifiOff size={15} /> Reconnecting...
        </div>
      )}
      <main className="p-body">{body}</main>
    </div>
  );
}

function StateCard({ icon: Icon, title, text, ok, spin, children }) {
  return (
    <div className="state-card">
      <div className={`state-icon ${ok ? 'ok' : ''}`}>
        <Icon size={28} className={spin ? 'spin' : ''} />
      </div>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

/* ---------------- Phase 1: captains ---------------- */

function CaptainFlow({ state }) {
  const [teamId, setTeamId] = useState(null);
  const team = state.teams.find((t) => t.id === teamId);

  useEffect(() => {
    if (team && team.submitted) setTeamId(null);
  }, [team]);

  if (!team) {
    return (
      <>
        <div className="p-intro">
          <div className="eyebrow">Team captains</div>
          <h1>Pick your team</h1>
          <p>Add the takeaways your team agreed on. Not a captain? Stay on this page, voting opens next.</p>
        </div>
        <div className="team-grid">
          {state.teams.map((t) => (
            <button key={t.id} className="team-btn" disabled={t.submitted} onClick={() => setTeamId(t.id)}>
              {t.name}
              {t.submitted && (
                <small>
                  <Lock size={11} /> Submitted
                </small>
              )}
            </button>
          ))}
        </div>
      </>
    );
  }

  return <TakeawayForm state={state} team={team} onBack={() => setTeamId(null)} />;
}

function TakeawayForm({ state, team, onBack }) {
  const draftKey = `recap-draft-${team.id}`;
  const [values, setValues] = useState(() => store.get(draftKey, Array(state.perTeam).fill('')));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const update = (i, v) => {
    const next = values.slice();
    next[i] = v;
    setValues(next);
    store.set(draftKey, next);
  };

  const filled = values.filter((v) => v.trim()).length;

  const submit = async () => {
    setSending(true);
    setError('');
    const res = await emit('captain:submit', { teamId: team.id, statements: values });
    setSending(false);
    if (res && res.ok) store.remove(draftKey);
    else setError((res && res.error) || 'Could not submit. Try again.');
  };

  return (
    <>
      <button className="btn btn-ghost back" onClick={onBack}>
        <ChevronLeft size={16} /> Change team
      </button>
      <div className="p-intro">
        <div className="eyebrow">{team.name}</div>
        <h1>Your team's takeaways</h1>
        <p>Write each one as a behaviour your team commits to after today.</p>
      </div>
      {values.map((v, i) => (
        <div className="field" key={i}>
          <label htmlFor={`t${i}`}>
            Takeaway {i + 1}
            <span>
              {v.length}/{state.maxLen}
            </span>
          </label>
          <textarea
            id={`t${i}`}
            rows={3}
            maxLength={state.maxLen}
            value={v}
            placeholder={i === 0 ? 'e.g. We will give credit openly in team meetings' : ''}
            onChange={(e) => update(i, e.target.value)}
          />
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={!filled || sending} onClick={submit}>
        {sending ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}
        Submit {filled} takeaway{filled === 1 ? '' : 's'}
      </button>
      <p className="note">Once submitted, your team's entry is locked.</p>
    </>
  );
}

function CaptainDone({ state, teamId }) {
  const team = state.teams.find((t) => t.id === teamId);
  const mine = state.statements.filter((s) => s.teamId === teamId);
  return (
    <StateCard
      icon={CircleCheck}
      ok
      title={`${team ? team.name : 'Your team'} is in`}
      text="Your takeaways are on the main screen. Voting opens next, keep this page open."
    >
      {mine.length > 0 && (
        <ul className="recap-list">
          {mine.map((s, i) => (
            <li key={s.id}>
              <span className="badge-n">{i + 1}</span>
              {s.text}
            </li>
          ))}
        </ul>
      )}
    </StateCard>
  );
}

/* ---------------- Phase 2: voting ---------------- */

function VoteFlow({ state }) {
  const need = Math.min(state.votesPerPerson, state.statements.length);
  const [picked, setPicked] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const validIds = useMemo(() => new Set(state.statements.map((s) => s.id)), [state.statements]);
  const current = picked.filter((id) => validIds.has(id));
  const full = current.length >= need;

  const toggle = (id) => {
    setError('');
    if (current.includes(id)) setPicked(current.filter((x) => x !== id));
    else if (!full) setPicked([...current, id]);
  };

  const submit = async () => {
    setSending(true);
    const res = await emit('vote:submit', { ids: current });
    setSending(false);
    if (!res || !res.ok) setError((res && res.error) || 'Could not submit. Try again.');
  };

  return (
    <>
      <div className="p-intro">
        <div className="eyebrow">Vote</div>
        <h1>Pick the top {need}</h1>
        <p>Choose the {need} takeaways you believe matter most. Numbers match the main screen.</p>
      </div>
      <ul className="vote-list">
        {state.statements.map((s) => {
          const on = current.includes(s.id);
          return (
            <li key={s.id}>
              <button
                className={`vote-item ${on ? 'is-on' : ''} ${full && !on ? 'is-dim' : ''}`}
                aria-pressed={on}
                onClick={() => toggle(s.id)}
              >
                <span className="badge-n">{s.number}</span>
                <span className="txt">
                  {s.text}
                  <small>{teamLabel(s, state.teams)}</small>
                </span>
                <span className="check">{on && <Check size={14} strokeWidth={3} />}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="vote-bar">
        <div className="count">
          {current.length} of {need} selected
          <div className="dots">
            {Array.from({ length: need }, (_, i) => (
              <i key={i} className={i < current.length ? 'on' : ''} />
            ))}
          </div>
          {error && <div className="bar-error">{error}</div>}
        </div>
        <button className="btn btn-primary" disabled={current.length !== need || sending} onClick={submit}>
          {sending ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}
          Submit vote
        </button>
      </div>
    </>
  );
}

function VoteDone({ state, ids }) {
  const mine = ids.map((id) => state.statements.find((s) => s.id === id)).filter(Boolean);
  return (
    <StateCard icon={CircleCheck} ok title="Your vote is in" text="Watch the main screen for the results.">
      <ul className="recap-list">
        {mine.map((s) => (
          <li key={s.id}>
            <span className="badge-n">{s.number}</span>
            {s.text}
          </li>
        ))}
      </ul>
    </StateCard>
  );
}

/* ---------------- Phase 3: reveal ---------------- */

function RevealView({ state }) {
  const top = (state.results || []).slice(0, 3);
  return (
    <StateCard icon={MonitorPlay} title="Results are on the main screen" text="Here are the room's top takeaways.">
      <ul className="recap-list">
        {top.map((s, i) => (
          <li key={s.id} className={i === 0 ? 'is-top' : ''}>
            <span className="badge-n">{i === 0 ? <Trophy size={14} /> : i + 1}</span>
            <span>
              {s.text}
              <small>{teamLabel(s, state.teams)}</small>
            </span>
          </li>
        ))}
      </ul>
    </StateCard>
  );
}

/* ================= DASHBOARD ================= */

const PHASE_LABEL = {
  setup: 'Starting soon',
  submit: 'Team takeaways',
  review: 'Preparing the vote',
  vote: 'Voting open',
  reveal: 'Results',
};

function Dashboard() {
  const { state, connected } = useSessionState();
  const url = joinUrl();

  if (!state) {
    return (
      <div className="dash dash-center">
        <LoaderCircle size={40} className="spin" />
      </div>
    );
  }

  let content;
  if (state.phase === 'setup') content = <Splash state={state} url={url} />;
  else if (state.phase === 'submit' || state.phase === 'review') content = <SubmitBoard state={state} url={url} />;
  else if (state.phase === 'vote') content = <VoteBoard state={state} url={url} />;
  else content = <Results state={state} />;

  return (
    <div className="dash">
      <header className="dash-top">
        <span className="logo-chip">
          <Logo />
        </span>
        <span className="tagline">Convey meaning, create significance</span>
        <div className="dash-title">{state.phase !== 'setup' && state.title}</div>
        <span className="phase-pill">
          {!connected ? <WifiOff size={14} /> : <span className="live-dot" />}
          {connected ? PHASE_LABEL[state.phase] : 'Reconnecting'}
        </span>
      </header>
      <main className="dash-main">{content}</main>
    </div>
  );
}

function QrCard({ url, label = 'Scan to join', large }) {
  return (
    <div className={`qr-card ${large ? 'qr-large' : ''}`}>
      <QRCodeSVG value={url} size={512} level="M" marginSize={0} fgColor="#282547" />
      <div className="lbl">{label}</div>
      <div className="url">{url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>
    </div>
  );
}

function Stat({ value, total, label }) {
  const pct = total ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="stat-card">
      <div className="big">
        {value}
        <span> / {total}</span>
      </div>
      <div className="lbl">{label}</div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------- setup ---------------- */

function Splash({ state, url }) {
  return (
    <div className="splash">
      <div className="splash-copy">
        <div className="eyebrow">Recap Room</div>
        <h1>{state.title}</h1>
        <p>Team captains share what your team commits to. Then the whole room votes for the takeaways that matter most.</p>
      </div>
      <QrCard url={url} large />
    </div>
  );
}

/* ---------------- phase 1: team wall ---------------- */

function SubmitBoard({ state, url }) {
  const submitted = state.teams.filter((t) => t.submitted).length;
  const n = state.teams.length;
  const rows = n <= 3 ? 1 : n <= 10 ? 2 : n <= 18 ? 3 : 4;
  const cols = Math.ceil(n / rows);
  const showNumbers = state.phase === 'review';

  const byTeam = useMemo(() => {
    const map = {};
    state.statements.forEach((s) => {
      (map[s.teamId] = map[s.teamId] || []).push(s);
    });
    return map;
  }, [state.statements]);

  return (
    <>
      <div className="wall" style={{ '--cols': cols }}>
        {state.teams.map((t) => {
          const items = byTeam[t.id] || [];
          return (
            <article key={t.id} className={`team-card ${t.submitted ? 'is-in' : ''}`}>
              <header>
                <span>{t.name}</span>
                {t.submitted ? <CircleCheck size={18} /> : <span className="wait">Waiting</span>}
              </header>
              {t.submitted ? (
                <ol>
                  {items.map((s, i) => (
                    <li key={s.id}>
                      <span className="n">{showNumbers ? s.number : i + 1}</span>
                      <span>
                        {s.text}
                        {s.alsoFrom.length > 0 && <span className="also">Also from {s.alsoFrom.map((id) => teamName(state.teams, id)).join(', ')}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="placeholder">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </article>
          );
        })}
      </div>
      <aside className="dash-side">
        {state.phase === 'submit' ? (
          <QrCard url={url} label="Captains, scan here" />
        ) : (
          <div className="stat-card prep">
            <LoaderCircle size={28} className="spin" />
            <div className="lbl">Combining similar takeaways. Voting opens in a moment.</div>
          </div>
        )}
        <Stat value={submitted} total={n} label="Teams submitted" />
      </aside>
    </>
  );
}

/* ---------------- phase 2: voting ---------------- */

function VoteBoard({ state, url }) {
  const count = state.statements.length;
  const listRef = useRef(null);
  const fitKey = state.statements.map((s) => s.id + s.text).join('|');

  // Auto-fit: largest font size at which every takeaway fits on screen
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const fit = () => {
      let lo = 10;
      let hi = Math.max(lo + 1, Math.round(window.innerHeight / 22));
      el.style.fontSize = `${hi}px`;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        el.style.fontSize = `${mid}px`;
        if (el.scrollHeight <= el.clientHeight + 1) lo = mid;
        else hi = mid;
      }
      el.style.fontSize = `${lo}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [fitKey]);

  return (
    <>
      <section className="vb">
        <h2>
          Pick your top {Math.min(state.votesPerPerson, count)} on your phone
        </h2>
        <div className="vb-list" ref={listRef}>
          {state.statements.map((s) => (
            <div key={s.id} className="vb-item">
              <span className="n">{s.number}</span>
              <p>
                {s.text}
                <small>{teamLabel(s, state.teams)}</small>
              </p>
            </div>
          ))}
        </div>
      </section>
      <aside className="dash-side">
        <QrCard url={url} label="Everyone, scan to vote" />
        <Stat value={state.votersCount} total={state.expected} label="People voted" />
        <div className="side-note">
          <EyeOff size={16} />
          Results stay hidden until the reveal.
        </div>
      </aside>
    </>
  );
}

/* ---------------- reveal ---------------- */

function Results({ state }) {
  const top = (state.results || []).slice(0, state.revealCount);
  const max = Math.max(1, ...top.map((r) => r.votes));
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= top.length) clearInterval(timer);
    }, 1400);
    return () => clearInterval(timer);
    // replay only when the reveal list itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top.map((r) => r.id).join(',')]);

  return (
    <section className="results">
      <h2>
        <Trophy size={34} /> The room's top takeaways
      </h2>
      {top.map((r, i) => {
        const visible = i >= top.length - shown;
        return (
          <div key={r.id} className={`res-row ${i === 0 ? 'first' : ''} ${visible ? 'show' : ''}`}>
            <div className="res-rank">{i + 1}</div>
            <div className="res-text">
              {r.text}
              <small>{teamLabel(r, state.teams)}</small>
              <div className="res-bar">
                <i style={{ width: visible ? `${(r.votes / max) * 100}%` : 0 }} />
              </div>
            </div>
            <div className="res-votes">
              {r.votes}
              <small>vote{r.votes === 1 ? '' : 's'}</small>
            </div>
          </div>
        );
      })}
      <div className="res-foot">
        <Users size={16} /> {state.votersCount} people voted
      </div>
    </section>
  );
}

/* ================= FACILITATOR ================= */

const STEPS = [
  { key: 'setup', label: 'Setup', next: 'Open submissions' },
  { key: 'submit', label: 'Takeaways', next: 'Close submissions' },
  { key: 'review', label: 'Review', next: 'Open voting' },
  { key: 'vote', label: 'Voting', next: 'Reveal results' },
  { key: 'reveal', label: 'Reveal', next: null },
];

const PIN_KEY = 'recap-room-pin';
const getPin = () => {
  try {
    return sessionStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
};
const setPin = (pin) => {
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {}
};

function Facilitator() {
  const [fs, setFs] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const onFs = (s) => setFs(s);
    const reauth = () => {
      const pin = getPin();
      if (pin) socket.emit('fac:auth', { pin }, (r) => r && r.ok && setAuthed(true));
    };
    socket.on('facState', onFs);
    socket.on('connect', reauth);
    if (socket.connected) reauth();
    return () => {
      socket.off('facState', onFs);
      socket.off('connect', reauth);
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const run = async (event, payload) => {
    const res = await emit(event, payload);
    if (!res || !res.ok) setToast((res && res.error) || 'Something went wrong.');
    return res;
  };

  if (!authed) return <PinGate onAuthed={() => setAuthed(true)} />;
  if (!fs) {
    return (
      <div className="gate">
        <LoaderCircle size={32} className="spin" color="#fff" />
      </div>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.key === fs.phase);
  const goTo = (i) => run('fac:phase', { phase: STEPS[i].key });

  return (
    <div className="fac">
      <header className="fac-top">
        <Logo />
        <h1>Recap Room</h1>
        <div className="links">
          <a className="btn btn-sm btn-outline" href="?view=dashboard" target="_blank" rel="noreferrer">
            <MonitorPlay size={15} /> Open projector
          </a>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              navigator.clipboard && navigator.clipboard.writeText(joinUrl());
              setToast('Join link copied');
            }}
          >
            <Copy size={15} /> Copy join link
          </button>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => exportExcel(fs).catch(() => setToast('Export failed. Please try again.'))}
          >
            <Download size={15} /> Export Excel
          </button>
          <button
            className="btn btn-sm btn-danger-outline"
            onClick={() => window.confirm('Reset the session? All takeaways and votes will be cleared.') && run('fac:reset')}
          >
            <RotateCcw size={15} /> Reset
          </button>
        </div>
      </header>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            className={`step ${i < stepIndex ? 'is-done' : ''} ${i === stepIndex ? 'is-current' : ''}`}
            onClick={() => i !== stepIndex && goTo(i)}
          >
            <span className="i">{i < stepIndex ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
            {s.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn btn-sm btn-outline" disabled={stepIndex === 0} onClick={() => goTo(stepIndex - 1)}>
          <ChevronLeft size={15} /> Back
        </button>
        {STEPS[stepIndex].next && (
          <button className="btn btn-sm btn-primary" onClick={() => goTo(stepIndex + 1)}>
            {STEPS[stepIndex].next} <ChevronRight size={15} />
          </button>
        )}
      </div>

      <div className="fac-grid">
        <div className="col">
          <SettingsPanel fs={fs} run={run} />
          <TeamsPanel fs={fs} run={run} />
        </div>
        <ModerationPanel fs={fs} run={run} />
        <ResultsPanel fs={fs} />
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function PinGate({ onAuthed }) {
  const [pin, setPinValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const res = await emit('fac:auth', { pin });
    setBusy(false);
    if (res && res.ok) {
      setPin(pin);
      onAuthed();
    } else setError((res && res.error) || 'Could not connect.');
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Logo className="gate-logo" />
        <h2>Facilitator access</h2>
        <p>Enter the session PIN to control Recap Room.</p>
        <input
          className="input"
          type="password"
          inputMode="numeric"
          autoFocus
          placeholder="PIN"
          value={pin}
          onChange={(e) => setPinValue(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={!pin || busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />} Continue
        </button>
      </form>
    </div>
  );
}

function SettingsPanel({ fs, run }) {
  const [form, setForm] = useState({
    title: fs.title,
    teamCount: fs.teamCount,
    expected: fs.expected,
    revealCount: fs.revealCount,
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const teamsLocked = fs.all.length > 0;

  return (
    <section className="panel">
      <h3>
        <span>
          <Settings2 size={16} /> Session
        </span>
      </h3>
      <div className="form-row">
        <label>Title on screen</label>
        <input className="input" value={form.title} maxLength={80} onChange={set('title')} />
      </div>
      <div className="form-split">
        <div className="form-row">
          <label>Teams</label>
          <input
            className="input"
            type="number"
            min={2}
            max={30}
            value={form.teamCount}
            disabled={teamsLocked}
            onChange={set('teamCount')}
          />
        </div>
        <div className="form-row">
          <label>People</label>
          <input className="input" type="number" min={1} value={form.expected} onChange={set('expected')} />
        </div>
        <div className="form-row">
          <label>Reveal top</label>
          <input className="input" type="number" min={1} max={10} value={form.revealCount} onChange={set('revealCount')} />
        </div>
      </div>
      <button
        className="btn btn-sm btn-primary btn-block"
        onClick={() => run('fac:config', teamsLocked ? { ...form, teamCount: undefined } : form)}
      >
        Save settings
      </button>
      {teamsLocked && <p className="hint">Team count is fixed once a team has submitted.</p>}
    </section>
  );
}

function TeamsPanel({ fs, run }) {
  const done = fs.teams.filter((t) => t.submitted).length;
  return (
    <section className="panel">
      <h3>
        <span>
          <Users size={16} /> Teams
        </span>
        <span className="meta">
          {done} / {fs.teams.length} submitted
        </span>
      </h3>
      <div className="team-rows">
        {fs.teams.map((t) => (
          <div key={t.id} className={`team-row ${t.submitted ? 'is-in' : ''}`}>
            {t.name}
            <span className="st">
              {t.submitted ? (
                <>
                  <Lock size={13} /> Submitted
                </>
              ) : (
                'Waiting'
              )}
            </span>
            <button
              className="icon-btn"
              title="Unlock so the team can resubmit"
              disabled={!t.submitted || fs.locked}
              onClick={() =>
                window.confirm(`Unlock ${t.name}? Their takeaways will be removed so the captain can resubmit.`) &&
                run('fac:unlockTeam', { teamId: t.id })
              }
            >
              <LockOpen size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModerationPanel({ fs, run }) {
  const active = fs.all.filter((s) => !s.hidden && !s.mergedInto);
  return (
    <section className="panel">
      <h3>
        <span>
          <ListChecks size={16} /> Takeaways
        </span>
        <span className="meta">{active.length} on the ballot</span>
      </h3>
      {fs.locked && (
        <p className="hint lock-hint">
          <Lock size={13} /> Voting has started. You can still fix typos, but the list is locked.
        </p>
      )}
      {fs.all.length === 0 ? (
        <p className="empty">Takeaways appear here as captains submit.</p>
      ) : (
        <div className="mod-list">
          {fs.all.map((s) => (
            <ModItem key={s.id} s={s} fs={fs} active={active} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModItem({ s, fs, active, run }) {
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [text, setText] = useState(s.text);
  const target = s.mergedInto && fs.all.find((x) => x.id === s.mergedInto);
  const status = s.hidden ? 'is-hidden' : s.mergedInto ? 'is-merged' : '';

  const save = async () => {
    const res = await run('fac:edit', { id: s.id, text });
    if (res && res.ok) setEditing(false);
  };

  return (
    <div className={`mod-item ${status}`}>
      <span className="badge-n">{s.number || '-'}</span>
      <div className="body">
        {editing ? (
          <>
            <textarea className="input" rows={2} maxLength={fs.maxLen} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row-actions">
              <button className="btn btn-sm btn-primary" onClick={save}>
                <Check size={14} /> Save
              </button>
              <button
                className="btn btn-sm btn-outline"
                onClick={() => {
                  setText(s.text);
                  setEditing(false);
                }}
              >
                <X size={14} /> Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="txt">{s.text}</div>
        )}
        <div className="meta">
          <span className="tag">{teamName(fs.teams, s.teamId)}</span>
          {s.alsoFrom.length > 0 && <span>Also from {s.alsoFrom.map((id) => teamName(fs.teams, id)).join(', ')}</span>}
          {s.hidden && <span className="tag muted">Hidden</span>}
          {target && <span className="tag muted">Merged into #{target.number || '-'}</span>}
          {!s.hidden && !s.mergedInto && fs.phase !== 'setup' && fs.phase !== 'submit' && <span>{s.votes} vote{s.votes === 1 ? '' : 's'}</span>}
        </div>
        {merging && (
          <select
            className="input merge-select"
            defaultValue=""
            onChange={async (e) => {
              const res = await run('fac:merge', { sourceId: s.id, targetId: e.target.value });
              if (res && res.ok) setMerging(false);
            }}
          >
            <option value="" disabled>
              Merge into...
            </option>
            {active
              .filter((x) => x.id !== s.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  #{x.number} {x.text.length > 70 ? `${x.text.slice(0, 70)}...` : x.text}
                </option>
              ))}
          </select>
        )}
      </div>
      <div className="actions">
        <button className="icon-btn" title="Edit text" onClick={() => setEditing(!editing)}>
          <Pencil size={15} />
        </button>
        {s.mergedInto ? (
          <button className="icon-btn" title="Undo merge" disabled={fs.locked} onClick={() => run('fac:unmerge', { id: s.id })}>
            <Undo2 size={15} />
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title="Merge into a similar takeaway"
              disabled={fs.locked || s.hidden}
              onClick={() => setMerging(!merging)}
            >
              <GitMerge size={15} />
            </button>
            <button
              className="icon-btn"
              title={s.hidden ? 'Show' : 'Hide'}
              disabled={fs.locked}
              onClick={() => run('fac:hide', { id: s.id, hidden: !s.hidden })}
            >
              {s.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ResultsPanel({ fs }) {
  const max = Math.max(1, ...fs.results.map((r) => r.votes));
  const showVotes = fs.phase === 'vote' || fs.phase === 'reveal';
  return (
    <section className="panel">
      <h3>
        <span>
          <Trophy size={16} /> Live results
        </span>
        <span className="meta">
          {fs.votersCount} / {fs.expected} voted
        </span>
      </h3>
      {fs.phase === 'vote' && (
        <p className="hint">
          <EyeOff size={13} /> Only you can see these. The projector shows them at the reveal.
        </p>
      )}
      {!showVotes ? (
        <p className="empty">Vote counts appear here once voting opens.</p>
      ) : (
        <div className="res-mini">
          {fs.results.slice(0, 12).map((r, i) => (
            <div key={r.id} className={`rm-row ${i < fs.revealCount ? 'in-top' : ''}`}>
              <span className="badge-n">{r.number}</span>
              <div className="rm-body">
                <div className="rm-txt" title={r.text}>{r.text}</div>
                <div className="rm-bar">
                  <i style={{ width: `${(r.votes / max) * 100}%` }} />
                </div>
              </div>
              <strong>{r.votes}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- Excel export ---------------- */

const PHASE_NAMES = { setup: 'Setup', submit: 'Takeaways', review: 'Review', vote: 'Voting', reveal: 'Reveal' };

async function exportExcel(fs) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const tn = (id) => teamName(fs.teams, id);
  const voters = fs.votersCount;
  const totalVotes = fs.results.reduce((a, r) => a + r.votes, 0);
  const rank = {};
  fs.results.forEach((r, i) => {
    rank[r.id] = i + 1;
  });
  const byId = Object.fromEntries(fs.all.map((s) => [s.id, s]));
  const status = (s) => (s.hidden ? 'Hidden' : s.mergedInto ? 'Merged' : 'On ballot');
  const pct = (n, d) => (d ? n / d : 0);

  const addSheet = (name, rows, widths, { filter = false, pctCols = [] } = {}) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    if (filter && rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: range.e.c } }) };
    pctCols.forEach((c) => {
      for (let r = 1; r <= range.e.r; r += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.v === 'number') cell.z = '0%';
      }
    });
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  /* 1. Summary */
  const submittedTeams = fs.teams.filter((t) => t.submitted).length;
  const top = fs.results.slice(0, fs.revealCount);
  const summary = [
    ['Recap Room results', ''],
    ['', ''],
    ['Session', fs.title],
    ['Exported', new Date().toLocaleString()],
    ['Stage at export', PHASE_NAMES[fs.phase] || fs.phase],
    ['', ''],
    ['Teams', fs.teams.length],
    ['Teams that submitted', submittedTeams],
    ['Takeaways submitted', fs.all.length],
    ['Takeaways on the ballot', fs.results.length],
    ['Merged as duplicates', fs.all.filter((s) => s.mergedInto).length],
    ['Hidden by facilitator', fs.all.filter((s) => s.hidden).length],
    ['', ''],
    ['People expected', fs.expected],
    ['People who voted', voters],
    ['Turnout', pct(voters, fs.expected)],
    ['Total votes cast', totalVotes],
    ['', ''],
    [`Top ${fs.revealCount} takeaways`, ''],
    ['Rank', 'Takeaway', 'Team', 'Votes', '% of voters'],
    ...top.map((r, i) => [i + 1, r.text, [r.teamId, ...r.alsoFrom].map(tn).join(' & '), r.votes, pct(r.votes, voters)]),
    ['', ''],
    ['Key', ''],
    ['Takeaways submitted', 'Every takeaway captains entered, including ones later hidden or merged.'],
    ['On the ballot', 'Takeaways people could vote for after the facilitator review.'],
    ['Turnout', 'People who voted divided by people expected.'],
    ['% of voters', 'Share of voters who picked this takeaway as one of their 3.'],
    ['Sheets', 'Ranking: every ballot item by votes. By Team: what each team submitted. Team Summary: one row per team.'],
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summary);
  summaryWs['!cols'] = [{ wch: 26 }, { wch: 70 }, { wch: 22 }, { wch: 8 }, { wch: 12 }];
  summaryWs.B16.z = '0%';
  top.forEach((_, i) => {
    const cell = summaryWs[XLSX.utils.encode_cell({ r: 20 + i, c: 4 })];
    if (cell) cell.z = '0%';
  });
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  /* 2. Ranking: every ballot item, most votes first */
  addSheet(
    'Ranking',
    [
      ['Rank', 'Ballot #', 'Takeaway', 'Submitted by', 'Also submitted by (merged)', 'Votes', '% of voters', 'Share of all votes'],
      ...fs.results.map((r, i) => [
        i + 1,
        r.number,
        r.text,
        tn(r.teamId),
        r.alsoFrom.map(tn).join(', '),
        r.votes,
        pct(r.votes, voters),
        pct(r.votes, totalVotes),
      ]),
    ],
    [7, 9, 60, 14, 24, 8, 12, 16],
    { filter: true, pctCols: [6, 7] }
  );

  /* 3. By Team: every takeaway in submission order */
  const byTeam = fs.all
    .slice()
    .sort((a, b) => a.teamId - b.teamId || a.order - b.order)
    .map((s) => {
      const target = s.mergedInto ? byId[s.mergedInto] : null;
      return [
        tn(s.teamId),
        s.order + 1,
        s.text,
        status(s),
        s.number || '',
        target ? `#${target.number || '-'} ${target.text}` : '',
        status(s) === 'On ballot' ? s.votes : '',
        rank[s.id] || '',
      ];
    });
  addSheet(
    'By Team',
    [['Team', 'Takeaway #', 'Takeaway', 'Status', 'Ballot #', 'Votes counted under', 'Votes', 'Rank'], ...byTeam],
    [12, 11, 60, 11, 9, 50, 8, 7],
    { filter: true }
  );

  /* 4. Team Summary: one row per team */
  const teamRows = fs.teams.map((t) => {
    const mine = fs.all.filter((s) => s.teamId === t.id);
    const onBallot = mine.filter((s) => status(s) === 'On ballot');
    const best = onBallot.slice().sort((a, b) => (rank[a.id] || 999) - (rank[b.id] || 999))[0];
    return [
      t.name,
      t.submitted ? 'Submitted' : 'Not submitted',
      mine.length,
      onBallot.length,
      mine.filter((s) => s.mergedInto).length,
      mine.filter((s) => s.hidden).length,
      onBallot.reduce((a, s) => a + s.votes, 0),
      best ? best.text : '',
      best ? best.votes : '',
      best ? rank[best.id] : '',
    ];
  });
  addSheet(
    'Team Summary',
    [['Team', 'Status', 'Submitted', 'On ballot', 'Merged', 'Hidden', 'Total votes', 'Best takeaway', 'Its votes', 'Its rank'], ...teamRows],
    [12, 14, 10, 10, 8, 8, 11, 55, 9, 8],
    { filter: true }
  );

  /* 5. Key: what every column means */
  addSheet(
    'Key',
    [
      ['Sheet', 'Column', 'Meaning'],
      ['Ranking', 'Rank', 'Position by votes, same order as the projector reveal. Ties keep ballot order.'],
      ['Ranking', 'Ballot #', 'The number shown next to the takeaway on phones and the projector.'],
      ['Ranking', 'Also submitted by (merged)', 'Other teams whose matching takeaway was merged into this one.'],
      ['Ranking', '% of voters', 'Votes divided by people who voted. Each person picked 3, so these add up to about 300%.'],
      ['Ranking', 'Share of all votes', 'Votes divided by all votes cast. These add up to 100%.'],
      ['By Team', 'Takeaway #', 'Order the captain entered it in (1 to 3).'],
      ['By Team', 'Status', 'On ballot: voted on. Merged: combined into a matching takeaway. Hidden: removed by the facilitator.'],
      ['By Team', 'Votes counted under', 'For merged takeaways, the ballot item that received their votes.'],
      ['By Team', 'Votes / Rank', 'Shown only for takeaways that were on the ballot.'],
      ['Team Summary', 'Total votes', 'Sum of votes for the team\'s takeaways on the ballot.'],
      ['Team Summary', 'Best takeaway', 'The team\'s highest ranked takeaway.'],
    ],
    [14, 26, 95]
  );

  const name = `${fs.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'recap-room'}-results.xlsx`;
  XLSX.writeFile(wb, name);
}

/* ================= STYLES ================= */

const CSS = `
:root {
  --red: #bc1823;
  --red-hi: #f01921;
  --navy: #282547;
  --navy-deep: #1f1d39;
  --navy-soft: #34315a;
  --orange: #ff7c00;
  --white: #ffffff;
  --ink: #201e3a;
  --muted: #6c6987;
  --line: #e6e4ee;
  --bg: #f5f4f8;
  --ok: #1d8f62;
  --font: 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
button { font: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; }
a { color: inherit; text-decoration: none; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.logo-text { font-weight: 800; letter-spacing: -0.02em; color: #fff; font-size: 22px; }
.eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--red);
  margin-bottom: 8px;
}

/* ---------- buttons & inputs ---------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 14px 18px;
  font-weight: 700;
  font-size: 15px;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.btn-primary { background: var(--red); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--red-hi); }
.btn-primary:disabled { background: #dcb6b9; }
.btn-ghost { background: none; color: var(--navy); padding: 6px 0; gap: 4px; font-size: 14px; }
.btn-block { width: 100%; }
.btn-sm { padding: 8px 12px; font-size: 13px; border-radius: 9px; gap: 6px; }
.btn-outline { background: #fff; border-color: var(--line); color: var(--navy); }
.btn-outline:hover:not(:disabled) { border-color: var(--navy); }
.btn-outline:disabled { opacity: 0.45; }
.btn-danger-outline { background: #fff; border-color: #f0cfd2; color: var(--red); }
.btn-danger-outline:hover { border-color: var(--red); }

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 11px;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  background: #fff;
  outline: none;
}
.input:focus { border-color: var(--navy); }
.input:disabled { background: var(--bg); color: var(--muted); }

.error {
  background: #fdecee;
  color: var(--red);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
  margin-bottom: 12px;
}

.badge-n {
  flex: none;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--navy);
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  display: grid;
  place-items: center;
}

/* ================= PARTICIPANT ================= */

.p-shell {
  min-height: 100%;
  max-width: 560px;
  margin: 0 auto;
  background: #fff;
  display: flex;
  flex-direction: column;
}
.p-top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  background: var(--navy);
}
.p-logo { height: 46px; display: block; }
.p-title {
  margin-left: auto;
  text-align: right;
  font-weight: 700;
  font-size: 14px;
  color: #fff;
}
.p-offline {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  background: #fff4e8;
  color: #9a4b00;
  font-size: 13px;
  font-weight: 600;
}
.p-body { flex: 1; padding: 22px 18px 130px; }
.p-intro h1 { margin: 0 0 6px; font-size: 25px; color: var(--navy); letter-spacing: -0.015em; }
.p-intro p { margin: 0 0 22px; color: var(--muted); line-height: 1.55; font-size: 15px; }
.back { margin: -6px 0 12px; }

.team-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.team-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 6px;
  border: 1.5px solid var(--line);
  border-radius: 12px;
  background: #fff;
  color: var(--navy);
  font-weight: 700;
  font-size: 15px;
  transition: border-color 0.15s, transform 0.1s;
}
.team-btn:not(:disabled):hover { border-color: var(--red); }
.team-btn:not(:disabled):active { transform: scale(0.97); }
.team-btn:disabled { background: var(--bg); color: #aaa8bb; }
.team-btn small { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; }

.field { margin-bottom: 16px; }
.field label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--navy);
}
.field label span { color: var(--muted); font-weight: 500; }
.field textarea {
  width: 100%;
  min-height: 84px;
  padding: 12px 14px;
  border: 1.5px solid var(--line);
  border-radius: 12px;
  font: inherit;
  font-size: 16px;
  line-height: 1.45;
  color: var(--ink);
  resize: none;
  outline: none;
  transition: border-color 0.15s;
}
.field textarea:focus { border-color: var(--navy); }
.note { margin: 10px 0 0; text-align: center; font-size: 13px; color: var(--muted); }

.state-card { padding: 44px 4px 12px; text-align: center; }
.state-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 18px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #efeef6;
  color: var(--navy);
}
.state-icon.ok { background: #e6f5ee; color: var(--ok); }
.state-card h2 { margin: 0 0 8px; font-size: 22px; color: var(--navy); }
.state-card p { margin: 0 auto; max-width: 34ch; color: var(--muted); line-height: 1.55; }

.recap-list { list-style: none; margin: 26px 0 0; padding: 0; display: grid; gap: 10px; text-align: left; }
.recap-list li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg);
  font-size: 15px;
  line-height: 1.45;
}
.recap-list small { display: block; margin-top: 3px; font-size: 12px; font-weight: 600; color: var(--muted); }
.recap-list li.is-top { background: #fdf0f1; }
.recap-list li.is-top .badge-n { background: var(--red); }

.vote-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.vote-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  text-align: left;
  background: #fff;
  border: 1.5px solid var(--line);
  border-radius: 12px;
  color: var(--ink);
  transition: border-color 0.15s, background 0.15s, opacity 0.15s;
}
.vote-item .txt { flex: 1; font-size: 15px; line-height: 1.45; }
.vote-item small { display: block; margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.vote-item.is-on { border-color: var(--red); background: #fdf3f4; }
.vote-item.is-on .badge-n { background: var(--red); }
.vote-item.is-dim { opacity: 0.45; }
.check {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  display: grid;
  place-items: center;
  color: #fff;
}
.is-on .check { background: var(--red); border-color: var(--red); }

.vote-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid var(--line);
  box-shadow: 0 -8px 24px rgba(40, 37, 71, 0.07);
}
.vote-bar .count { flex: 1; font-size: 14px; font-weight: 700; color: var(--navy); }
.dots { display: flex; gap: 6px; margin-top: 6px; }
.dots i { width: 22px; height: 5px; border-radius: 3px; background: var(--line); transition: background 0.15s; }
.dots i.on { background: var(--red); }
.bar-error { margin-top: 6px; font-size: 12px; color: var(--red); font-weight: 600; }

/* ================= DASHBOARD ================= */

.dash {
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--navy);
  color: #fff;
  font-size: clamp(12px, 0.95vw, 22px);
}
.dash-center { align-items: center; justify-content: center; }
.dash-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1.2vw;
  padding: 1.6vh 2vw;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.logo-chip { display: inline-flex; align-items: center; }
.logo-chip img { height: 6.5vh; display: block; }
.tagline { padding-left: 1.2vw; border-left: 1px solid rgba(255, 255, 255, 0.18); color: rgba(255, 255, 255, 0.62); font-size: 0.9em; }
.dash-title { margin-left: auto; font-weight: 800; font-size: 1.45em; letter-spacing: -0.01em; }
.phase-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.55em;
  padding: 0.5em 1em;
  border-radius: 999px;
  background: rgba(255, 124, 0, 0.14);
  color: var(--orange);
  font-weight: 700;
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.live-dot { width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--orange); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }

.dash-main { flex: 1; min-height: 0; display: flex; gap: 1.6vw; padding: 2.2vh 2vw; }
.dash-side { flex: none; width: 19vw; display: flex; flex-direction: column; gap: 1.6vh; }

.qr-card { padding: 1.4vw; border-radius: 16px; background: #fff; color: var(--navy); text-align: center; }
.qr-card svg { display: block; width: 100%; height: auto; }
.qr-card .lbl { margin-top: 1.2vh; font-weight: 800; font-size: 1.1em; }
.qr-card .url { margin-top: 0.3vh; font-size: 0.75em; color: var(--muted); word-break: break-all; }
.qr-large { width: 26vw; padding: 2vw; }
.qr-large .lbl { font-size: 1.5em; }
.qr-large .url { font-size: 0.95em; }

.stat-card { padding: 1.4vw; border-radius: 16px; background: var(--navy-soft); }
.stat-card .big { font-size: 3em; font-weight: 800; line-height: 1; }
.stat-card .big span { font-size: 0.42em; font-weight: 600; color: rgba(255, 255, 255, 0.55); }
.stat-card .lbl { margin-top: 0.8vh; font-size: 0.9em; color: rgba(255, 255, 255, 0.72); line-height: 1.4; }
.stat-card.prep { color: var(--orange); }
.progress { height: 0.8vh; margin-top: 1.4vh; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, 0.12); }
.progress i { display: block; height: 100%; border-radius: inherit; background: var(--orange); transition: width 0.6s ease; }
.side-note { display: flex; gap: 0.6em; font-size: 0.85em; line-height: 1.45; color: rgba(255, 255, 255, 0.6); }

.splash { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6vw; }
.splash-copy { max-width: 42vw; }
.splash .eyebrow { color: var(--orange); font-size: 1em; }
.splash h1 { margin: 0 0 2.4vh; font-size: 4.4em; line-height: 1.04; letter-spacing: -0.025em; }
.splash p { margin: 0; font-size: 1.4em; line-height: 1.45; color: rgba(255, 255, 255, 0.72); }

.wall {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
  gap: 1.1vw;
}
.team-card {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 1vw 1.1vw;
  border-radius: 14px;
  border: 1px dashed rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.03);
}
.team-card.is-in { border: 1px solid transparent; background: #fff; color: var(--ink); animation: pop 0.55s cubic-bezier(0.2, 0.9, 0.3, 1.2); }
@keyframes pop { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: none; } }
.team-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1vh;
  font-size: 0.82em;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.5);
}
.team-card.is-in header { color: var(--red); }
.team-card .wait { font-weight: 600; letter-spacing: 0.04em; }
.team-card ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.9vh; }
.team-card li { display: flex; gap: 0.6vw; font-size: 0.95em; font-weight: 500; line-height: 1.32; }
.team-card li .n { flex: none; min-width: 1.4em; font-weight: 800; color: var(--orange); }
.team-card .also { display: block; margin-top: 0.2vh; font-size: 0.78em; color: var(--muted); font-weight: 600; }
.placeholder { display: flex; flex-direction: column; gap: 1.2vh; margin-top: 0.4vh; }
.placeholder span { height: 0.9vh; border-radius: 99px; background: rgba(255, 255, 255, 0.08); }
.placeholder span:nth-child(2) { width: 80%; }
.placeholder span:nth-child(3) { width: 58%; }

.vb { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.vb h2 { margin: 0 0 1.8vh; font-size: 1.7em; letter-spacing: -0.01em; }
.vb-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  justify-content: center;
  gap: 0.5em 0.5em;
  font-size: 24px;
}
.vb-item {
  display: inline-flex;
  align-items: flex-start;
  gap: 0.5em;
  max-width: min(100%, 20em);
  padding: 0.45em 0.75em 0.5em 0.5em;
  border-radius: 0.55em;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.08);
  animation: pop 0.45s ease;
}
.vb-item .n {
  flex: none;
  min-width: 1.7em;
  height: 1.7em;
  padding: 0 0.3em;
  border-radius: 0.4em;
  display: grid;
  place-items: center;
  background: var(--orange);
  color: var(--navy);
  font-weight: 800;
  font-size: 0.78em;
  margin-top: 0.08em;
}
.vb-item p { margin: 0; font-size: 1em; font-weight: 600; line-height: 1.25; }
.vb-item small { display: block; margin-top: 0.2em; font-size: 0.58em; font-weight: 600; color: rgba(255, 255, 255, 0.5); }

.results { flex: 1; width: 100%; max-width: 74vw; margin: 0 auto; display: flex; flex-direction: column; justify-content: center; }
.results h2 { display: flex; align-items: center; gap: 0.5em; margin: 0 0 3vh; font-size: 2.4em; letter-spacing: -0.02em; }
.results h2 svg { color: var(--orange); }
.res-row {
  display: grid;
  grid-template-columns: 3.4em 1fr 6em;
  align-items: center;
  gap: 1.4vw;
  margin-bottom: 1.4vh;
  padding: 1.6vh 1.4vw;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.06);
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.res-row.show { opacity: 1; transform: none; }
.res-row.first { background: var(--red); padding-top: 2.2vh; padding-bottom: 2.2vh; }
.res-rank { font-size: 2.3em; font-weight: 800; color: var(--orange); text-align: center; }
.first .res-rank { color: #fff; }
.res-text { font-size: 1.25em; font-weight: 600; line-height: 1.3; }
.first .res-text { font-size: 1.45em; }
.res-text small { display: block; margin-top: 0.4vh; font-size: 0.62em; color: rgba(255, 255, 255, 0.62); }
.res-bar { height: 0.8vh; margin-top: 1.1vh; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, 0.14); }
.res-bar i { display: block; height: 100%; border-radius: inherit; background: var(--orange); transition: width 1.2s ease 0.3s; }
.first .res-bar i { background: #fff; }
.res-votes { text-align: right; font-size: 1.9em; font-weight: 800; line-height: 1; }
.res-votes small { display: block; margin-top: 0.3vh; font-size: 0.42em; font-weight: 600; color: rgba(255, 255, 255, 0.62); }
.res-foot { display: flex; align-items: center; gap: 0.5em; margin-top: 1.4vh; font-size: 0.9em; color: rgba(255, 255, 255, 0.6); }

/* ================= FACILITATOR ================= */

.gate { min-height: 100vh; display: grid; place-items: center; background: var(--navy); padding: 20px; }
.gate-card { width: min(360px, 100%); padding: 30px 26px; border-radius: 16px; background: #fff; text-align: center; }
.gate-logo { height: 34px; margin-bottom: 18px; }
.gate-card h2 { margin: 0 0 6px; color: var(--navy); font-size: 20px; }
.gate-card p { margin: 0 0 18px; font-size: 14px; color: var(--muted); }
.gate-card .input { margin-bottom: 12px; padding: 12px; font-size: 16px; text-align: center; letter-spacing: 0.2em; }

.fac { min-height: 100%; background: var(--bg); }
.fac-top {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 24px;
  background: var(--navy);
}
.fac-top img { height: 46px; display: block; }
.fac-top h1 { margin: 0; padding-left: 14px; border-left: 1px solid rgba(255, 255, 255, 0.2); font-size: 16px; color: #fff; }
.fac-top .links { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }

.stepper { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 18px 24px; }
.stepper .spacer { flex: 1; }
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px 7px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  font-weight: 600;
  font-size: 13px;
}
.step .i { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--bg); font-size: 11px; font-weight: 800; }
.step.is-done { color: var(--navy); }
.step.is-done .i { background: var(--navy); color: #fff; }
.step.is-current { border-color: var(--red); color: var(--red); }
.step.is-current .i { background: var(--red); color: #fff; }

.fac-grid { display: grid; grid-template-columns: 330px minmax(0, 1fr) 360px; gap: 16px; align-items: start; padding: 0 24px 40px; }
.fac-grid > *, .fac-grid .col > * { min-width: 0; }
.fac-grid .col { display: grid; gap: 16px; }
@media (max-width: 1200px) { .fac-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) { .fac-grid { grid-template-columns: 1fr; } .fac-top { flex-wrap: wrap; } }

.panel { padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
.panel h3 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 14px; font-size: 14px; color: var(--navy); }
.panel h3 > span:first-child { display: flex; align-items: center; gap: 8px; }
.panel h3 .meta { font-size: 12px; font-weight: 600; color: var(--muted); }
.hint { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 12px; color: var(--muted); }
.lock-hint { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: #fff4e8; color: #9a4b00; }
.empty { margin: 0; padding: 22px 0; text-align: center; font-size: 13px; color: var(--muted); }

.form-row { margin-bottom: 12px; }
.form-row label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.form-split { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }

.team-rows { display: grid; gap: 6px; }
.team-row { display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 12px; border-radius: 9px; background: var(--bg); font-size: 14px; font-weight: 600; color: var(--navy); }
.team-row .st { margin-left: auto; display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
.team-row.is-in .st { color: var(--ok); }

.icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border: none; border-radius: 8px; background: none; color: var(--muted); }
.icon-btn:hover:not(:disabled) { background: var(--bg); color: var(--navy); }
.icon-btn:disabled { opacity: 0.3; }

.mod-list { display: grid; gap: 8px; }
.mod-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 10px 10px 12px; border: 1px solid var(--line); border-radius: 11px; }
.mod-item.is-hidden, .mod-item.is-merged { background: var(--bg); }
.mod-item.is-hidden .txt, .mod-item.is-merged .txt { color: var(--muted); text-decoration: line-through; }
.mod-item.is-hidden .badge-n, .mod-item.is-merged .badge-n { background: #c9c7d6; }
.mod-item .body { flex: 1; min-width: 0; }
.mod-item .txt { font-size: 14px; line-height: 1.45; }
.mod-item .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted); }
.mod-item .actions { display: flex; gap: 2px; }
.row-actions { display: flex; gap: 6px; margin-top: 6px; }
.merge-select { margin-top: 8px; font-size: 13px; }
.tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 99px; background: #efeef6; color: var(--navy); font-size: 11px; font-weight: 700; }
.tag.muted { background: #fff4e8; color: #9a4b00; }

.res-mini { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.rm-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rm-row .badge-n { background: #c9c7d6; }
.rm-row.in-top .badge-n { background: var(--red); }
.rm-body { flex: 1; min-width: 0; }
.rm-txt { font-size: 13px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rm-bar { height: 6px; margin-top: 5px; overflow: hidden; border-radius: 99px; background: var(--bg); }
.rm-bar i { display: block; height: 100%; border-radius: inherit; background: var(--orange); transition: width 0.4s ease; }
.rm-row strong { flex: none; min-width: 26px; text-align: right; font-size: 15px; color: var(--navy); }
.panel h3 + .hint { align-items: flex-start; margin: 0 0 14px; line-height: 1.45; }
.panel h3 + .hint svg { flex: none; margin-top: 2px; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  z-index: 50;
  transform: translateX(-50%);
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--navy);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 10px 30px rgba(31, 29, 57, 0.25);
}
`;