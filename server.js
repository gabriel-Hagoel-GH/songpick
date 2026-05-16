const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 8888;
const ROOT = path.join(__dirname, 'public');
const INDEX = path.join(ROOT, 'index.html');

if (!fs.existsSync(INDEX)) {
  console.error(`\n❌ index.html not found at: ${INDEX}\n`);
  process.exit(1);
}

app.use(express.static(ROOT));
app.use(express.json());

// ── Spotify search proxy ───────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, type, roomCode } = req.query;
  if (!q || !type || !roomCode) return res.json({ items: [] });
  const room = rooms[roomCode.toUpperCase()];
  if (!room || !room.spotifyToken) return res.json({ items: [] });
  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=6&market=IL`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + room.spotifyToken } });
    if (!r.ok) return res.json({ items: [] });
    const data = await r.json();
    const items = type === 'track'
      ? (data.tracks?.items || []).map(t => ({ name: t.name, sub: t.artists.map(a=>a.name).join(', '), img: t.album?.images?.[2]?.url || '' }))
      : (data.artists?.items || []).map(a => ({ name: a.name, sub: a.genres?.slice(0,2).join(', ')||'', img: a.images?.[2]?.url||'' }));
    res.json({ items });
  } catch { res.json({ items: [] }); }
});

// ── Constants ──────────────────────────────────────────────
const POSITION_POINTS = [10, 8, 6, 4, 2, 1];
const ROUND_DURATION  = 20;
const EXTRA_DURATION  = 10;
const TILES           = 12;

function getPoints(pos) {
  return pos >= 1 ? (POSITION_POINTS[Math.min(pos - 1, POSITION_POINTS.length - 1)]) : 0;
}

// ── Helpers ────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildOptions(correctSong, allSongs) {
  const used = new Set([correctSong.id]);
  const distractors = [];

  function tryAdd(song) {
    if (!song || used.has(song.id) || distractors.length >= TILES - 1) return;
    used.add(song.id);
    distractors.push({ id: song.id, title: song.title, artist: song.artist });
  }

  const pool = allSongs.filter(s => s.id !== correctSong.id);
  const correctDecade = Math.floor((correctSong.releaseYear || 2000) / 10) * 10;
  const correctYear   = correctSong.releaseYear || 2000;

  // Max 2 from same artist — prevents obvious pattern
  shuffle(pool.filter(s => s.artist === correctSong.artist)).slice(0, 2).forEach(tryAdd);

  // ~2 from same year (±2 years) different artist — very close, tricky
  shuffle(pool.filter(s => Math.abs((s.releaseYear||2000) - correctYear) <= 2 && s.artist !== correctSong.artist)).slice(0, 2).forEach(tryAdd);

  // ~3 from same decade different artist
  shuffle(pool.filter(s => Math.floor((s.releaseYear||2000)/10)*10 === correctDecade && s.artist !== correctSong.artist && !used.has(s.id))).slice(0, 3).forEach(tryAdd);

  // ~2 from adjacent decade (decade before or after)
  shuffle(pool.filter(s => {
    const d = Math.floor((s.releaseYear||2000)/10)*10;
    return (d === correctDecade - 10 || d === correctDecade + 10) && !used.has(s.id);
  })).slice(0, 2).forEach(tryAdd);

  // Fill rest with random from entire pool
  shuffle(pool.filter(s => !used.has(s.id))).forEach(tryAdd);

  while (distractors.length < TILES - 1) {
    distractors.push({ id: 'ph_' + distractors.length, title: '— Unknown —', artist: '—' });
  }

  return shuffle([
    { id: correctSong.id, title: correctSong.title, artist: correctSong.artist, isCorrect: true },
    ...distractors.slice(0, TILES - 1).map(d => ({ ...d, isCorrect: false }))
  ]);
}

// ── Room factory ───────────────────────────────────────────
const rooms = {};

function makeRoom(hostId, hostName) {
  let code;
  do { code = Math.random().toString(36).slice(2,6).toUpperCase(); } while (rooms[code]);
  rooms[code] = {
    code, hostId,
    phase: 'lobby',
    players: {},
    songs: [], currentSongIdx: 0, currentSong: null, currentOptions: [],
    roundCount: 5,
    timerEnd: null, timerInterval: null, timerRunning: false,
    correctCount: 0,
    selectedGenres: [], selectedDecades: [], israeliMode: false,
    spotifyToken: null,
  };
  rooms[code].players[hostId] = { name: hostName, score: 0, isHost: true, pick: null, correct: null, finishPosition: null };
  return rooms[code];
}

function getRoomOf(id) { return Object.values(rooms).find(r => r.players[id]); }

function roomPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, isHost: p.isHost,
    correct: p.correct, finishPosition: p.finishPosition,
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', {
    phase: room.phase, players: roomPlayers(room),
    currentSongIdx: room.currentSongIdx, roundCount: room.roundCount,
    selectedGenres: room.selectedGenres, selectedDecades: room.selectedDecades, israeliMode: room.israeliMode,
  });
}

function resetRound(room) {
  Object.values(room.players).forEach(p => { p.pick = null; p.correct = null; p.finishPosition = null; });
  room.correctCount = 0;
}

// ── Timer ──────────────────────────────────────────────────
function startTimer(room, duration) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerEnd = Date.now() + duration * 1000;
  room.timerRunning = true;
  io.to(room.code).emit('timer_start', { duration });
  room.timerInterval = setInterval(() => {
    if (Math.ceil((room.timerEnd - Date.now()) / 1000) <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      room.timerRunning = false;
      onTimerEnd(room);
    }
  }, 300);
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  room.timerRunning = false;
}

function scorePicks(room) {
  const correct = room.currentOptions.find(o => o.isCorrect);
  if (!correct) return;
  const correctIdx = room.currentOptions.indexOf(correct);
  const players = Object.values(room.players).filter(p => !p.isHost);

  // Score correct pickers — randomise order (all submitted at same moment)
  const winners = shuffle(players.filter(p => p.pick === correctIdx));
  winners.forEach((p, i) => {
    p.correct = true;
    p.finishPosition = room.correctCount + i + 1;
    p.score += getPoints(p.finishPosition);
  });
  room.correctCount += winners.length;

  // Mark wrong pickers
  players.filter(p => p.pick !== null && p.pick !== correctIdx).forEach(p => { p.correct = false; });
}

function onTimerEnd(room) {
  if (room.phase !== 'playing') return;
  scorePicks(room);
  const anyCorrect = Object.values(room.players).some(p => p.correct === true);
  if (anyCorrect) {
    setTimeout(() => revealRound(room), 600);
  } else {
    room.phase = 'waiting_host';
    io.to(room.code).emit('no_correct_guesses');
    broadcastRoom(room);
  }
}

function revealRound(room) {
  if (room.phase === 'revealing' || room.phase === 'gameover') return;
  stopTimer(room);
  room.phase = 'revealing';
  const song = room.currentSong;
  const correctIdx = room.currentOptions.findIndex(o => o.isCorrect);
  io.to(room.code).emit('reveal', {
    song: { title: song.title, artist: song.artist, id: song.id, albumArt: song.albumArt, releaseYear: song.releaseYear },
    correctIdx,
    players: roomPlayers(room),
    isLast: room.currentSongIdx >= room.roundCount - 1,
  });
}

// ── Socket Events ──────────────────────────────────────────
io.on('connection', socket => {

  socket.on('create_room', ({ name }) => {
    const room = makeRoom(socket.id, name);
    socket.join(room.code);
    socket.emit('room_created', { code: room.code, playerId: socket.id });
    broadcastRoom(room);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    if (Object.keys(room.players).length >= 12) { socket.emit('error', 'Room is full'); return; }
    room.players[socket.id] = { name, score: 0, isHost: false, pick: null, correct: null, finishPosition: null };
    socket.join(code.toUpperCase());
    socket.emit('room_joined', { code: code.toUpperCase(), playerId: socket.id });
    broadcastRoom(room);
    io.to(room.code).emit('player_joined', { name });
  });

  socket.on('set_config', ({ roundCount, selectedGenres, selectedDecades, israeliMode }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    Object.assign(room, { roundCount, selectedGenres, selectedDecades, israeliMode });
    broadcastRoom(room);
  });

  socket.on('host_token', ({ token }) => {
    const room = getRoomOf(socket.id);
    if (room && room.hostId === socket.id) room.spotifyToken = token;
  });

  socket.on('set_status', ({ status }) => {
    const room = getRoomOf(socket.id);
    if (room && room.hostId === socket.id) io.to(room.code).emit('host_status', { status });
  });

  socket.on('songs_ready', ({ songs }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.songs = songs;
    room.currentSongIdx = 0;
    room.phase = 'playing';
    room.currentSong = songs[0];
    room.currentOptions = buildOptions(songs[0], songs);
    resetRound(room);
    io.to(room.code).emit('game_start', { roundCount: room.roundCount, options: room.currentOptions });
    broadcastRoom(room);
  });

  socket.on('song_playing', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id || room.timerRunning) return;
    startTimer(room, ROUND_DURATION);
    io.to(room.code).emit('song_playing');
  });

  // Player stores their current pick (can overwrite until timer ends)
  socket.on('submit_pick', ({ optionIdx }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.isHost) return;
    player.pick = optionIdx;
  });

  socket.on('extra_time', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'waiting_host') return;
    room.phase = 'playing';
    resetRound(room);
    startTimer(room, EXTRA_DURATION);
    io.to(room.code).emit('extra_time', { duration: EXTRA_DURATION });
  });

  socket.on('force_reveal', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    revealRound(room);
  });

  socket.on('next_song', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.currentSongIdx++;
    if (room.currentSongIdx >= room.roundCount || room.currentSongIdx >= room.songs.length) {
      room.phase = 'gameover';
      io.to(room.code).emit('game_over', { players: roomPlayers(room) });
      broadcastRoom(room); return;
    }
    room.currentSong = room.songs[room.currentSongIdx];
    room.currentOptions = buildOptions(room.currentSong, room.songs);
    room.phase = 'playing';
    resetRound(room);
    io.to(room.code).emit('next_song', { songIdx: room.currentSongIdx, roundCount: room.roundCount, options: room.currentOptions });
    broadcastRoom(room);
  });

  socket.on('play_again', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    stopTimer(room);
    Object.assign(room, { phase: 'lobby', songs: [], currentSongIdx: 0, currentSong: null, currentOptions: [], selectedGenres: [], selectedDecades: [], israeliMode: false });
    Object.values(room.players).forEach(p => { p.score = 0; p.pick = null; p.correct = null; p.finishPosition = null; });
    io.to(room.code).emit('back_to_lobby');
    broadcastRoom(room);
  });

  socket.on('end_game', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    stopTimer(room);
    room.phase = 'gameover';
    io.to(room.code).emit('game_over', { players: roomPlayers(room) });
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomOf(socket.id);
    if (!room) return;
    const name = room.players[socket.id]?.name;
    delete room.players[socket.id];
    if (room.hostId === socket.id) {
      stopTimer(room);
      io.to(room.code).emit('host_left');
      delete rooms[room.code];
    } else {
      io.to(room.code).emit('player_left', { name });
      broadcastRoom(room);
    }
  });
});

// ── Cleanup stale rooms ────────────────────────────────────
setInterval(() => {
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    if (Object.keys(room.players).length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      delete rooms[code];
    }
  });
}, 30 * 60 * 1000);

app.get('*', (req, res) => res.sendFile(INDEX));

httpServer.listen(PORT, () => {
  console.log(`\n🎵 Song-Pick  →  http://localhost:${PORT}`);
  console.log(`   Files from: ${ROOT}\n`);
});
