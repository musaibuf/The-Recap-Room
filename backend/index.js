const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const FACILITATOR_PIN = String(process.env.FACILITATOR_PIN || '2468');
const MAX_LEN = 120;
const PER_TEAM = 3;
const VOTES_PER_PERSON = 3;
const PHASES = ['setup', 'submit', 'review', 'vote', 'reveal'];

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Recap Room backend is running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

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
    captains: {}, // deviceId -> teamId
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
}

function broadcastMe() {
  io.sockets.sockets.forEach((s) => s.emit('me', meFor(s.data.deviceId)));
}

/* ---------------- sockets ---------------- */

io.on('connection', (socket) => {
  const reply = (cb, res) => typeof cb === 'function' && cb(res);
  const fail = (cb, error) => reply(cb, { ok: false, error });

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
    if (state.phase !== 'submit') return fail(cb, 'Submissions are closed.');
    const team = state.teams.find((t) => t.id === Number(teamId));
    if (!team) return fail(cb, 'Team not found.');
    if (team.submitted) return fail(cb, `${team.name} has already submitted.`);
    if (state.captains[deviceId]) return fail(cb, 'This phone has already submitted for a team.');
    if (!Array.isArray(statements)) return fail(cb, 'Add at least one takeaway.');
    const clean = statements.map(cleanText).filter(Boolean);
    if (clean.length < 1) return fail(cb, 'Add at least one takeaway.');
    if (clean.length > PER_TEAM) return fail(cb, `Up to ${PER_TEAM} takeaways per team.`);
    if (clean.some((t) => t.length > MAX_LEN)) return fail(cb, `Keep each takeaway under ${MAX_LEN} characters.`);

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
    if (state.phase !== 'vote') return fail(cb, 'Voting is not open.');
    if (state.voters[deviceId]) return fail(cb, 'You have already voted.');
    const activeIds = new Set(state.statements.filter(isActive).map((s) => s.id));
    const need = Math.min(VOTES_PER_PERSON, activeIds.size);
    const picked = Array.isArray(ids) ? [...new Set(ids)] : [];
    if (picked.length !== need || picked.some((id) => !activeIds.has(id))) {
      return fail(cb, `Pick exactly ${need} takeaways.`);
    }
    state.voters[deviceId] = picked;
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
    state = freshState(state);
    setImmediate(broadcastMe);
    return null;
  });
});

server.listen(PORT, () => console.log(`Recap Room backend listening on ${PORT}`));