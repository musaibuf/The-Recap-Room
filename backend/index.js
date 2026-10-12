const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

/* ================= GOOGLE SHEET: paste your sheet link here ================= */
// Or set GOOGLE_SHEET_URL in Render > Environment. Share the sheet with the client_email in credentials.json as Editor.
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '1zkQGwr8Zw2YmVtaqqVz8x8PqBbafy3Yr1bJTZPqKR6g';
const SHEET_TIMEZONE = process.env.SHEET_TIMEZONE || 'Asia/Karachi';

const PORT = process.env.PORT || 4000;
const FACILITATOR_PIN = String(process.env.FACILITATOR_PIN || '2468');
const MAX_LEN = 120;
const PER_TEAM = 3;
const VOTES_PER_PERSON = 3;
const PHASES = ['setup', 'submit', 'review', 'vote', 'reveal'];

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Recap Room backend is running'));
const VERSION = '2026-10-12-sheets';
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, sheet: sheetSync.status }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ---------------- state ---------------- */

let seq = 1;
const nextId = () => `s${seq++}`;

function makeTeams(count, prev = []) {
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    const old = prev.find((t) => t.id === id);
    return { id, name: old ? old.name : `Team ${id}`, submitted: false };
  });
}

function freshState(prev) {
  const teamCount = prev ? prev.teamCount : 10;
  return {
    phase: 'setup',
    title: prev ? prev.title : 'Key Takeaways',
    teamCount,
    expected: prev ? prev.expected : 80,
    revealCount: prev ? prev.revealCount : 5,
    teams: makeTeams(teamCount, prev ? prev.teams : []),
    statements: [], // { id, teamId, order, text, hidden, mergedInto, number }
    voters: {}, // deviceId -> [statementId]
    voteLog: [], // { at, ids } in the order votes arrived
    captains: {}, // deviceId -> teamId
    startedAt: null, // when submissions first opened
  };
}

let state = freshState();

const isActive = (s) => !s.hidden && !s.mergedInto;
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const votingStarted = () => Object.keys(state.voters).length > 0;

function renumber() {
  state.statements.forEach((s) => {
    s.number = null;
  });
  state.statements
    .filter(isActive)
    .sort((a, b) => a.teamId - b.teamId || a.order - b.order)
    .forEach((s, i) => {
      s.number = i + 1;
    });
}

function alsoFrom(s) {
  const ids = state.statements
    .filter((x) => x.mergedInto === s.id && x.teamId !== s.teamId)
    .map((x) => x.teamId);
  return [...new Set(ids)];
}

function voteCounts() {
  const counts = {};
  Object.values(state.voters).forEach((ids) =>
    ids.forEach((id) => {
      counts[id] = (counts[id] || 0) + 1;
    })
  );
  return counts;
}

function ranked() {
  const counts = voteCounts();
  return state.statements
    .filter(isActive)
    .map((s) => ({ ...publicStatement(s), votes: counts[s.id] || 0 }))
    .sort((a, b) => b.votes - a.votes || a.number - b.number);
}

function publicStatement(s) {
  return { id: s.id, number: s.number, teamId: s.teamId, text: s.text, alsoFrom: alsoFrom(s) };
}

function publicState() {
  return {
    phase: state.phase,
    title: state.title,
    teamCount: state.teamCount,
    expected: state.expected,
    revealCount: state.revealCount,
    teams: state.teams,
    statements: state.statements
      .filter(isActive)
      .sort((a, b) => a.number - b.number)
      .map(publicStatement),
    votersCount: Object.keys(state.voters).length,
    maxLen: MAX_LEN,
    perTeam: PER_TEAM,
    votesPerPerson: VOTES_PER_PERSON,
    results: state.phase === 'reveal' ? ranked() : null,
  };
}

function facState() {
  const counts = voteCounts();
  return {
    ...publicState(),
    results: ranked(),
    all: state.statements
      .slice()
      .sort((a, b) => a.teamId - b.teamId || a.order - b.order)
      .map((s) => ({ ...s, alsoFrom: alsoFrom(s), votes: counts[s.id] || 0 })),
    locked: votingStarted(),
    sheet: sheetSync.status,
  };
}

const meFor = (deviceId) => ({
  captainTeamId: (deviceId && state.captains[deviceId]) || null,
  votedIds: (deviceId && state.voters[deviceId]) || null,
});

function broadcast() {
  renumber();
  io.emit('state', publicState());
  io.to('fac').emit('facState', facState());
  sheetSync.schedule();
}

function broadcastMe() {
  io.sockets.sockets.forEach((s) => s.emit('me', meFor(s.data.deviceId)));
}

/* ---------------- Google Sheet rows ---------------- */

const PHASE_NAMES = { setup: 'Setup', submit: 'Takeaways', review: 'Review', vote: 'Voting', reveal: 'Reveal' };
const LIVE_TABS = ['Summary', 'Ranking', 'By Team', 'Team Summary', 'Votes'];
const HISTORY_TAB = 'History';
const HISTORY_HEADER = ['Session', 'Session date', 'Team', 'Takeaway #', 'Takeaway', 'Status', 'Ballot #', 'Votes', 'Rank', 'People voted'];

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: SHEET_TIMEZONE, dateStyle: 'medium', timeStyle: 'medium' }) : '';
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const teamNameOf = (id) => (state.teams.find((t) => t.id === id) || { name: `Team ${id}` }).name;
const statusOf = (s) => (s.hidden ? 'Hidden' : s.mergedInto ? 'Merged' : 'On ballot');

function sheetData() {
  renumber();
  const results = ranked();
  const counts = voteCounts();
  const rank = Object.fromEntries(results.map((r, i) => [r.id, i + 1]));
  const byId = Object.fromEntries(state.statements.map((s) => [s.id, s]));
  const voters = Object.keys(state.voters).length;
  const totalVotes = results.reduce((a, r) => a + r.votes, 0);
  const sorted = state.statements.slice().sort((a, b) => a.teamId - b.teamId || a.order - b.order);
  const label = (s) => [s.teamId, ...alsoFrom(s)].map(teamNameOf).join(' & ');

  const summary = [
    ['Recap Room: live results'],
    [],
    ['Session', state.title],
    ['Started', fmtTime(state.startedAt)],
    ['Last updated', fmtTime(new Date().toISOString())],
    ['Stage', PHASE_NAMES[state.phase] || state.phase],
    [],
    ['Teams', state.teams.length],
    ['Teams that submitted', state.teams.filter((t) => t.submitted).length],
    ['Takeaways submitted', state.statements.length],
    ['Takeaways on the ballot', results.length],
    ['Merged as duplicates', state.statements.filter((s) => s.mergedInto).length],
    ['Hidden by facilitator', state.statements.filter((s) => s.hidden).length],
    [],
    ['People expected', state.expected],
    ['People who voted', voters],
    ['Turnout %', pct(voters, state.expected)],
    ['Total votes cast', totalVotes],
    [],
    [`Top ${state.revealCount} takeaways`],
    ['Rank', 'Takeaway', 'Team', 'Votes', '% of voters'],
    ...results.slice(0, state.revealCount).map((r, i) => [i + 1, r.text, label(r), r.votes, pct(r.votes, voters)]),
    [],
    ['Key'],
    ['Summary', 'Headline numbers for the current session. Updates live while the session runs.'],
    ['Ranking', 'Every takeaway on the ballot, most votes first. % of voters adds to about 300% because each person picks 3.'],
    ['By Team', 'Every takeaway each team submitted, in the order the captain typed them. Merged ones show where their votes went.'],
    ['Team Summary', 'One row per team: how many takeaways, total votes and their best takeaway.'],
    ['Votes', 'One row per person who voted, in the order votes arrived. Anonymous: no names or phone details.'],
    ['History', 'Every finished session. A session is added here when the facilitator presses Reset.'],
    ['Status', 'On ballot: voted on. Merged: combined into a matching takeaway. Hidden: removed by the facilitator.'],
  ];

  const ranking = [
    ['Rank', 'Ballot #', 'Takeaway', 'Submitted by', 'Also submitted by (merged)', 'Votes', '% of voters', '% of all votes'],
    ...results.map((r, i) => [i + 1, r.number, r.text, teamNameOf(r.teamId), r.alsoFrom.map(teamNameOf).join(', '), r.votes, pct(r.votes, voters), pct(r.votes, totalVotes)]),
  ];

  const byTeam = [
    ['Team', 'Takeaway #', 'Takeaway', 'Status', 'Ballot #', 'Votes counted under', 'Votes', 'Rank'],
    ...sorted.map((s) => {
      const target = s.mergedInto ? byId[s.mergedInto] : null;
      const on = statusOf(s) === 'On ballot';
      return [teamNameOf(s.teamId), s.order + 1, s.text, statusOf(s), s.number || '', target ? `#${target.number || '-'} ${target.text}` : '', on ? counts[s.id] || 0 : '', rank[s.id] || ''];
    }),
  ];

  const teamSummary = [
    ['Team', 'Status', 'Submitted', 'On ballot', 'Merged', 'Hidden', 'Total votes', 'Best takeaway', 'Its votes', 'Its rank'],
    ...state.teams.map((t) => {
      const mine = state.statements.filter((s) => s.teamId === t.id);
      const on = mine.filter(isActive);
      const best = on.slice().sort((a, b) => (rank[a.id] || 999) - (rank[b.id] || 999))[0];
      return [
        t.name,
        t.submitted ? 'Submitted' : 'Not submitted',
        mine.length,
        on.length,
        mine.filter((s) => s.mergedInto).length,
        mine.filter((s) => s.hidden).length,
        on.reduce((a, s) => a + (counts[s.id] || 0), 0),
        best ? best.text : '',
        best ? counts[best.id] || 0 : '',
        best ? rank[best.id] : '',
      ];
    }),
  ];

  const pickLabel = (id) => {
    const s = byId[id];
    return s ? `#${s.number || '-'} ${s.text}` : '(removed)';
  };
  const votes = [
    ['Voter #', 'Time', 'Pick 1', 'Pick 2', 'Pick 3'],
    ...state.voteLog.map((v, i) => [i + 1, fmtTime(v.at), ...[0, 1, 2].map((k) => (v.ids[k] ? pickLabel(v.ids[k]) : ''))]),
  ];

  return [
    ['Summary', summary],
    ['Ranking', ranking],
    ['By Team', byTeam],
    ['Team Summary', teamSummary],
    ['Votes', votes],
  ];
}

function historyRows() {
  renumber();
  const results = ranked();
  const counts = voteCounts();
  const rank = Object.fromEntries(results.map((r, i) => [r.id, i + 1]));
  const voters = Object.keys(state.voters).length;
  const date = fmtTime(state.startedAt || new Date().toISOString());
  return state.statements
    .slice()
    .sort((a, b) => a.teamId - b.teamId || a.order - b.order)
    .map((s) => [
      state.title,
      date,
      teamNameOf(s.teamId),
      s.order + 1,
      s.text,
      statusOf(s),
      s.number || '',
      isActive(s) ? counts[s.id] || 0 : '',
      rank[s.id] || '',
      voters,
    ]);
}

/* ---------------- Google Sheet sync ---------------- */

const sheetSync = (() => {
  const status = { enabled: false, state: 'off', reason: null, lastSyncAt: null, error: null, url: null, email: null };
  const raw = String(GOOGLE_SHEET_URL || '').trim();
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = m ? m[1] : /^[a-zA-Z0-9-_]{30,}$/.test(raw) && !/PASTE/i.test(raw) ? raw : null;
  const dryRun = process.env.SHEETS_DRY_RUN === '1';
  const DEBOUNCE_MS = 4000;
  let api = null;
  let knownTabs = null;
  let timer = null;
  let queue = Promise.resolve();
  let clearPending = false;

  const notify = () => io.to('fac').emit('facState', facState());
  const setStatus = (patch) => {
    Object.assign(status, patch);
    notify();
  };
  const q = (title) => `'${title.replace(/'/g, "''")}'`;

  function loadCredentials() {
    if (process.env.GOOGLE_CREDENTIALS) return JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const files = [process.env.GOOGLE_APPLICATION_CREDENTIALS, path.join(__dirname, 'credentials.json'), '/etc/secrets/credentials.json'].filter(Boolean);
    const file = files.find((f) => fs.existsSync(f));
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  function dryApi() {
    const log = (name) => async (args) => {
      const body = args.requestBody || {};
      const detail = body.data ? body.data.map((d) => `${d.range} (${d.values.length} rows)`).join(', ') : body.ranges || body.values?.length || '';
      console.log(`[sheets:dry-run] ${name}`, detail);
      return { data: { sheets: (knownTabs ? [...knownTabs] : []).map((title) => ({ properties: { title } })), replies: [] } };
    };
    return {
      spreadsheets: {
        get: log('get'),
        batchUpdate: log('batchUpdate'),
        values: { batchClear: log('batchClear'), batchUpdate: log('values.batchUpdate'), append: log('append'), update: log('update') },
      },
    };
  }

  try {
    if (!spreadsheetId) {
      status.reason = 'No Google Sheet link set. Paste it into GOOGLE_SHEET_URL at the top of backend/index.js.';
      console.log('[sheets] Off:', status.reason);
    } else if (dryRun) {
      api = dryApi();
    } else {
      const creds = loadCredentials();
      if (!creds) {
        status.reason = 'credentials.json not found. Add it as a Secret File on Render (filename: credentials.json).';
        console.log('[sheets] Off:', status.reason);
      } else {
        const { sheets, auth } = require('@googleapis/sheets');
        api = sheets({ version: 'v4', auth: new auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
        status.email = creds.client_email || null;
      }
    }
  } catch (e) {
    status.reason = /Cannot find module/.test(e.message) ? 'Google package missing. Run: npm install @googleapis/sheets (in backend) and push.' : `Could not start: ${e.message}`;
    console.error('[sheets] Off:', status.reason);
    api = null;
  }

  if (api) {
    Object.assign(status, { enabled: true, state: 'idle', url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
    console.log(`[sheets] On${dryRun ? ' (dry run)' : ''}: ${status.url}`);
  }

  function explain(e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 403) return `No access. Share the sheet with ${status.email || 'the service account email'} as Editor.`;
    if (code === 404) return 'Sheet not found. Check the link.';
    if (code === 429) return 'Google rate limit hit. Retrying shortly.';
    return (e && e.message) || 'Unknown error';
  }

  async function ensureTabs() {
    if (knownTabs) return;
    const res = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    knownTabs = new Set(((res.data && res.data.sheets) || []).map((s) => s.properties.title));
    const missing = [...LIVE_TABS, HISTORY_TAB].filter((t) => !knownTabs.has(t));
    if (!missing.length) return;
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: title === 'Summary' ? 0 : 1 } } } })),
      },
    });
    missing.forEach((t) => knownTabs.add(t));
    if (missing.includes(HISTORY_TAB)) {
      await api.spreadsheets.values.update({ spreadsheetId, range: `${q(HISTORY_TAB)}!A1`, valueInputOption: 'RAW', requestBody: { values: [HISTORY_HEADER] } });
    }
  }

  // Runs one job at a time, in order
  const enqueue = (job) => {
    queue = queue.then(job).catch(() => {});
    return queue;
  };

  async function writeLive() {
    // Never overwrite the sheet with an empty session (e.g. right after a server restart) unless Reset asked for it
    const empty = !state.statements.length && !Object.keys(state.voters).length;
    if (empty && !clearPending) return;
    clearPending = false;
    setStatus({ state: 'saving' });
    try {
      await ensureTabs();
      const data = sheetData();
      await api.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges: LIVE_TABS.map((t) => `${q(t)}!A:Z`) } });
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: data.map(([t, values]) => ({ range: `${q(t)}!A1`, values })) },
      });
      setStatus({ state: 'saved', lastSyncAt: new Date().toISOString(), error: null });
    } catch (e) {
      knownTabs = null;
      setStatus({ state: 'error', error: explain(e) });
      console.error('[sheets] Sync failed:', explain(e));
      clearTimeout(timer);
      timer = setTimeout(() => enqueue(writeLive), 15000); // retry
    }
  }

  return {
    status,
    schedule() {
      if (!api) return;
      clearTimeout(timer);
      timer = setTimeout(() => enqueue(writeLive), DEBOUNCE_MS);
    },
    archive(rows) {
      if (!api || !rows.length) return;
      enqueue(async () => {
        try {
          await ensureTabs();
          await api.spreadsheets.values.append({
            spreadsheetId,
            range: `${q(HISTORY_TAB)}!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: rows },
          });
          console.log(`[sheets] Archived ${rows.length} rows to History`);
        } catch (e) {
          knownTabs = null;
          setStatus({ state: 'error', error: `History not saved: ${explain(e)}` });
          console.error('[sheets] Archive failed:', explain(e));
        }
      });
    },
    clearLive() {
      if (!api) return;
      clearPending = true;
    },
  };
})();

/* ---------------- sockets ---------------- */

io.on('connection', (socket) => {
  const reply = (cb, res) => typeof cb === 'function' && cb(res);
  const fail = (cb, error) => reply(cb, { ok: false, error });

  // Phones send their device id with every (re)connection, so taps queued while offline are never rejected
  const authId = socket.handshake.auth && socket.handshake.auth.deviceId;
  if (typeof authId === 'string' && authId.length > 0 && authId.length < 100) {
    socket.data.deviceId = authId;
    socket.emit('me', meFor(authId));
  }

  socket.emit('state', publicState());
  socket.on('state:get', () => socket.emit('state', publicState()));

  socket.on('hello', ({ deviceId } = {}) => {
    if (typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length < 100) {
      socket.data.deviceId = deviceId;
    }
    socket.emit('me', meFor(socket.data.deviceId));
  });

  socket.on('captain:submit', ({ teamId, statements } = {}, cb) => {
    const deviceId = socket.data.deviceId;
    if (!deviceId) return fail(cb, 'Please refresh the page and try again.');
    if (state.phase !== 'submit') return fail(cb, 'Sending is closed now.');
    const team = state.teams.find((t) => t.id === Number(teamId));
    if (!team) return fail(cb, 'Team not found.');
    if (team.submitted) return fail(cb, `${team.name} already sent their points.`);
    if (state.captains[deviceId]) return fail(cb, 'This phone already sent points for a team.');
    if (!Array.isArray(statements)) return fail(cb, 'Please write at least 1 point.');
    const clean = statements.map(cleanText).filter(Boolean);
    if (clean.length < 1) return fail(cb, 'Please write at least 1 point.');
    if (clean.length > PER_TEAM) return fail(cb, `You can send up to ${PER_TEAM} points.`);
    if (clean.some((t) => t.length > MAX_LEN)) return fail(cb, `Each point must be under ${MAX_LEN} letters.`);

    clean.forEach((text, order) =>
      state.statements.push({ id: nextId(), teamId: team.id, order, text, hidden: false, mergedInto: null, number: null })
    );
    team.submitted = true;
    state.captains[deviceId] = team.id;
    broadcast();
    socket.emit('me', meFor(deviceId));
    reply(cb, { ok: true });
  });

  socket.on('vote:submit', ({ ids } = {}, cb) => {
    const deviceId = socket.data.deviceId;
    if (!deviceId) return fail(cb, 'Please refresh the page and try again.');
    if (state.phase !== 'vote') return fail(cb, 'Voting has not started yet.');
    if (state.voters[deviceId]) return fail(cb, 'You already voted.');
    const activeIds = new Set(state.statements.filter(isActive).map((s) => s.id));
    const need = Math.min(VOTES_PER_PERSON, activeIds.size);
    const picked = Array.isArray(ids) ? [...new Set(ids)] : [];
    if (picked.length !== need || picked.some((id) => !activeIds.has(id))) {
      return fail(cb, `Please choose ${need} points.`);
    }
    state.voters[deviceId] = picked;
    state.voteLog.push({ at: new Date().toISOString(), ids: picked });
    broadcast();
    socket.emit('me', meFor(deviceId));
    reply(cb, { ok: true });
  });

  /* ----- facilitator ----- */

  socket.on('fac:auth', ({ pin } = {}, cb) => {
    if (String(pin) !== FACILITATOR_PIN) return fail(cb, 'Incorrect PIN.');
    socket.join('fac');
    socket.emit('facState', facState());
    reply(cb, { ok: true });
  });

  const fac = (event, handler) =>
    socket.on(event, (payload = {}, cb) => {
      if (!socket.rooms.has('fac')) return fail(cb, 'Not authorised.');
      try {
        const error = handler(payload || {});
        if (error) return fail(cb, error);
        broadcast();
        reply(cb, { ok: true });
      } catch (e) {
        console.error(e);
        fail(cb, 'Something went wrong.');
      }
    });

  fac('fac:config', ({ title, teamCount, expected, revealCount }) => {
    if (typeof title === 'string' && cleanText(title)) state.title = cleanText(title).slice(0, 80);
    if (expected !== undefined) state.expected = clampInt(expected, 1, 2000, state.expected);
    if (revealCount !== undefined) state.revealCount = clampInt(revealCount, 1, 10, state.revealCount);
    if (teamCount !== undefined) {
      const n = clampInt(teamCount, 2, 30, state.teamCount);
      if (n !== state.teamCount) {
        if (state.statements.length) return 'Team count can only change before any team submits.';
        state.teamCount = n;
        state.teams = makeTeams(n, state.teams);
      }
    }
    return null;
  });

  fac('fac:phase', ({ phase }) => {
    if (!PHASES.includes(phase)) return 'Unknown phase.';
    if ((phase === 'vote' || phase === 'reveal') && !state.statements.some(isActive)) {
      return 'There are no takeaways to vote on yet.';
    }
    state.phase = phase;
    if (phase === 'submit' && !state.startedAt) state.startedAt = new Date().toISOString();
    return null;
  });

  fac('fac:edit', ({ id, text }) => {
    const s = state.statements.find((x) => x.id === id);
    if (!s) return 'Takeaway not found.';
    const t = cleanText(text);
    if (!t) return 'Takeaway cannot be empty.';
    if (t.length > MAX_LEN) return `Keep it under ${MAX_LEN} characters.`;
    s.text = t;
    return null;
  });

  fac('fac:hide', ({ id, hidden }) => {
    if (votingStarted()) return 'The list is locked once voting has started.';
    const s = state.statements.find((x) => x.id === id);
    if (!s) return 'Takeaway not found.';
    s.hidden = Boolean(hidden);
    return null;
  });

  fac('fac:merge', ({ sourceId, targetId }) => {
    if (votingStarted()) return 'The list is locked once voting has started.';
    const source = state.statements.find((x) => x.id === sourceId);
    const target = state.statements.find((x) => x.id === targetId);
    if (!source || !target || source.id === target.id) return 'Pick two different takeaways.';
    if (!isActive(target)) return 'You can only merge into a visible takeaway.';
    source.mergedInto = target.id;
    state.statements.forEach((x) => {
      if (x.mergedInto === source.id) x.mergedInto = target.id;
    });
    return null;
  });

  fac('fac:unmerge', ({ id }) => {
    if (votingStarted()) return 'The list is locked once voting has started.';
    const s = state.statements.find((x) => x.id === id);
    if (!s) return 'Takeaway not found.';
    s.mergedInto = null;
    return null;
  });

  fac('fac:unlockTeam', ({ teamId }) => {
    if (votingStarted()) return 'Teams are locked once voting has started.';
    const team = state.teams.find((t) => t.id === Number(teamId));
    if (!team) return 'Team not found.';
    const removed = new Set(state.statements.filter((s) => s.teamId === team.id).map((s) => s.id));
    state.statements = state.statements.filter((s) => !removed.has(s.id));
    state.statements.forEach((s) => {
      if (removed.has(s.mergedInto)) s.mergedInto = null;
    });
    team.submitted = false;
    Object.keys(state.captains).forEach((d) => {
      if (state.captains[d] === team.id) delete state.captains[d];
    });
    setImmediate(broadcastMe);
    return null;
  });

  fac('fac:reset', () => {
    if (state.statements.length) sheetSync.archive(historyRows());
    state = freshState(state);
    sheetSync.clearLive();
    setImmediate(broadcastMe);
    return null;
  });
});

server.listen(PORT, () => console.log(`Recap Room backend listening on ${PORT}`));