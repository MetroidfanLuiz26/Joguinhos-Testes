import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  const PORT = 3000;

  type ActionType = 'light' | 'heavy' | 'block' | 'heal';
  type PlayerState = {
    id: string;
    hp: number;
    mana: number;
    action: {
      type: ActionType;
      startedAt: number;
      resolveAt: number;
      expiresAt: number;
      resolved: boolean;
    } | null;
  };

  type RoomState = {
    id: string;
    players: Record<string, PlayerState>;
    status: 'waiting' | 'playing' | 'finished';
    winner: string | null;
    lastTick: number;
  };

  const rooms = new Map<string, RoomState>();
  let waitingPlayer: string | null = null;

  io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('join_matchmaking', () => {
      if (waitingPlayer && waitingPlayer !== socket.id) {
        const roomId = `room_${Date.now()}`;
        const room: RoomState = {
          id: roomId,
          players: {
            [waitingPlayer]: { id: waitingPlayer, hp: 100, mana: 100, action: null },
            [socket.id]: { id: socket.id, hp: 100, mana: 100, action: null }
          },
          status: 'playing',
          winner: null,
          lastTick: Date.now()
        };
        rooms.set(roomId, room);
        
        io.sockets.sockets.get(waitingPlayer)?.join(roomId);
        socket.join(roomId);
        
        io.to(roomId).emit('match_found', roomId);
        waitingPlayer = null;
      } else {
        waitingPlayer = socket.id;
        socket.emit('waiting');
      }
    });

    socket.on('do_action', ({ roomId, type }: { roomId: string, type: ActionType }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'playing') return;
      
      const p = room.players[socket.id];
      if (!p) return;
      
      const now = Date.now();
      if (p.action && now < p.action.expiresAt) return; // Busy

      if (type === 'light') {
        p.action = { type, startedAt: now, resolveAt: now + 300, expiresAt: now + 600, resolved: false };
      } else if (type === 'heavy') {
        if (p.mana < 30) return;
        p.mana -= 30;
        p.action = { type, startedAt: now, resolveAt: now + 800, expiresAt: now + 1200, resolved: false };
      } else if (type === 'block') {
        if (p.mana < 20) return;
        p.mana -= 20;
        p.action = { type, startedAt: now, resolveAt: now, expiresAt: now + 1000, resolved: false };
      } else if (type === 'heal') {
        if (p.mana < 40) return;
        p.mana -= 40;
        p.action = { type, startedAt: now, resolveAt: now + 600, expiresAt: now + 1000, resolved: false };
      }
    });

    socket.on('disconnect', () => {
      if (waitingPlayer === socket.id) waitingPlayer = null;
      for (const [roomId, room] of rooms.entries()) {
        if (room.players[socket.id]) {
          room.status = 'finished';
          const otherId = Object.keys(room.players).find(id => id !== socket.id);
          room.winner = otherId || null;
          io.to(roomId).emit('sync', room);
          rooms.delete(roomId);
        }
      }
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      if (room.status !== 'playing') continue;

      const pIds = Object.keys(room.players);
      if (pIds.length !== 2) continue;
      const p1 = room.players[pIds[0]];
      const p2 = room.players[pIds[1]];

      const dt = now - room.lastTick;
      if (dt > 50) {
        p1.mana = Math.min(100, p1.mana + (12 * dt / 1000)); // 12 mana per sec
        p2.mana = Math.min(100, p2.mana + (12 * dt / 1000));
        room.lastTick = now;
      }

      [[p1, p2], [p2, p1]].forEach(([attacker, defender]) => {
        if (attacker.action && now >= attacker.action.resolveAt && !attacker.action.resolved) {
          attacker.action.resolved = true;
          
          const isBlocked = defender.action?.type === 'block' && now < defender.action.expiresAt;

          if (attacker.action.type === 'light') {
            const dmg = isBlocked ? 2 : 10;
            defender.hp -= dmg;
            io.to(roomId).emit('combat_event', { type: 'hit', target: defender.id, damage: dmg, blocked: isBlocked });
          } else if (attacker.action.type === 'heavy') {
            const dmg = isBlocked ? 5 : 35;
            defender.hp -= dmg;
            io.to(roomId).emit('combat_event', { type: 'hit', target: defender.id, damage: dmg, blocked: isBlocked });
          } else if (attacker.action.type === 'heal') {
            attacker.hp = Math.min(100, attacker.hp + 30);
            io.to(roomId).emit('combat_event', { type: 'heal', target: attacker.id, amount: 30 });
          }
        }

        if (attacker.action && now >= attacker.action.expiresAt) {
          attacker.action = null;
        }
      });

      if (p1.hp <= 0 || p2.hp <= 0) {
        room.status = 'finished';
        if (p1.hp <= 0 && p2.hp <= 0) room.winner = 'draw';
        else room.winner = p1.hp <= 0 ? p2.id : p1.id;
      }

      io.to(roomId).emit('sync', room);
    }
  }, 1000 / 30);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}

startServer();
