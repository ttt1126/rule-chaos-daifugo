const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { createRoomManager } = require('./src/roomManager');
const { registerSocketHandlers } = require('./src/socketHandlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

const manager = createRoomManager();
const publicDir = path.join(__dirname, 'public');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.use(express.static(publicDir));

registerSocketHandlers(io, manager);

const port = process.env.PORT || 3000;
const host = '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Rule Chaos Daifugo listening on ${host}:${port}`);
});
