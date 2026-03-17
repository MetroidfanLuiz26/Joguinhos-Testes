import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Sword, Shield, Heart, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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
};
type CombatEvent = {
  id: number;
  type: 'hit' | 'heal';
  target: string;
  damage?: number;
  amount?: number;
  blocked?: boolean;
};

const CastBar = ({ action }: { action: PlayerState['action'] }) => {
  const [progress, setProgress] = useState(0);
  
  useEffect(() => {
    if (!action) {
      setProgress(0);
      return;
    }
    let frame: number;
    const update = () => {
      const now = Date.now();
      if (!action.resolved) {
        const total = action.resolveAt - action.startedAt;
        const current = now - action.startedAt;
        setProgress(Math.min(100, Math.max(0, (current / total) * 100)));
      } else {
        const total = action.expiresAt - action.resolveAt;
        const current = now - action.resolveAt;
        setProgress(Math.max(0, 100 - (current / total) * 100));
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [action]);

  if (!action) return <div className="h-3 w-full bg-zinc-900 border-2 border-zinc-700 pixel-corners" />;

  const isRecovery = action.resolved;
  const color = action.type === 'heal' ? 'bg-emerald-500' : 
                action.type === 'block' ? 'bg-blue-500' : 
                isRecovery ? 'bg-zinc-500' : 'bg-amber-400';

  return (
    <div className="h-3 w-full bg-zinc-900 border-2 border-zinc-700 pixel-corners overflow-hidden relative">
      <div className={`h-full ${color}`} style={{ width: `${progress}%` }} />
      <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white uppercase drop-shadow-md z-10">
        {action.type} {isRecovery ? '(Rec)' : ''}
      </span>
    </div>
  );
};

const StatBar = ({ value, max, color, icon: Icon }: { value: number, max: number, color: string, icon: any }) => (
  <div className="flex items-center gap-2">
    <Icon size={14} className={color.replace('bg-', 'text-')} />
    <div className="flex-1 h-4 bg-zinc-900 border-2 border-zinc-700 pixel-corners relative overflow-hidden">
      <div className={`h-full ${color} transition-all duration-100`} style={{ width: `${(value / max) * 100}%` }} />
      <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white drop-shadow-md">
        {Math.ceil(value)}/{max}
      </span>
    </div>
  </div>
);

const Avatar = ({ player, isOpponent, events }: { player: PlayerState, isOpponent?: boolean, events: CombatEvent[] }) => {
  const myEvents = events.filter(e => e.target === player.id);
  const isHit = myEvents.some(e => e.type === 'hit');
  const isHealing = myEvents.some(e => e.type === 'heal');
  const isBlocking = player.action?.type === 'block' && !player.action.resolved;
  const isAttacking = (player.action?.type === 'light' || player.action?.type === 'heavy') && !player.action.resolved;

  return (
    <div className="relative flex flex-col items-center justify-center w-32 h-32">
      <motion.div 
        animate={{ 
          x: isHit ? [-5, 5, -5, 5, 0] : isAttacking ? (isOpponent ? [0, -20, 0] : [0, 20, 0]) : 0,
          scale: isAttacking ? 1.1 : 1
        }}
        transition={{ duration: isHit ? 0.2 : 0.3 }}
        className={`w-16 h-16 rounded-sm pixel-corners flex items-center justify-center text-3xl
          ${isOpponent ? 'bg-red-900/50 border-red-500' : 'bg-blue-900/50 border-blue-500'}
          border-4 ${isBlocking ? 'ring-4 ring-blue-400 bg-blue-800' : ''}
          ${isHealing ? 'ring-4 ring-emerald-400 bg-emerald-800' : ''}
          ${player.hp <= 0 ? 'opacity-50 grayscale' : 'animate-float'}
        `}
      >
        {player.hp <= 0 ? '💀' : isOpponent ? '👹' : '🥷'}
      </motion.div>

      <AnimatePresence>
        {myEvents.map(e => (
          <motion.div
            key={e.id}
            initial={{ opacity: 1, y: 0, scale: 0.5 }}
            animate={{ opacity: 0, y: -40, scale: 1.5 }}
            exit={{ opacity: 0 }}
            className={`absolute font-pixel text-sm drop-shadow-lg z-20 ${e.type === 'heal' ? 'text-emerald-400' : e.blocked ? 'text-blue-300' : 'text-red-500'}`}
          >
            {e.type === 'heal' ? `+${e.amount}` : `-${e.damage}`}
            {e.blocked && <span className="block text-[8px] text-center mt-1">BLOCKED</span>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameState, setGameState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<'idle' | 'waiting' | 'playing' | 'finished'>('idle');
  const [events, setEvents] = useState<CombatEvent[]>([]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('waiting', () => setStatus('waiting'));
    newSocket.on('match_found', () => {
      setStatus('playing');
      setEvents([]);
    });
    newSocket.on('sync', (room: RoomState) => {
      setGameState(room);
      if (room.status === 'finished') setStatus('finished');
    });
    newSocket.on('combat_event', (e: Omit<CombatEvent, 'id'>) => {
      const id = Date.now() + Math.random();
      setEvents(prev => [...prev, { ...e, id }]);
      setTimeout(() => {
        setEvents(prev => prev.filter(ev => ev.id !== id));
      }, 1000);
    });

    return () => { newSocket.close(); };
  }, []);

  const handleAction = useCallback((type: ActionType) => {
    if (socket && gameState?.id) {
      socket.emit('do_action', { roomId: gameState.id, type });
    }
  }, [socket, gameState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (status !== 'playing') return;
      if (e.key === 'q' || e.key === '1') handleAction('light');
      if (e.key === 'w' || e.key === '2') handleAction('heavy');
      if (e.key === 'e' || e.key === '3') handleAction('block');
      if (e.key === 'r' || e.key === '4') handleAction('heal');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleAction, status]);

  if (status === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 font-pixel text-white p-4 text-center">
        <h1 className="text-2xl md:text-4xl text-amber-400 mb-8 drop-shadow-[0_4px_0_rgba(180,83,9,1)]">PIXEL WARRIORS</h1>
        <p className="text-xs text-zinc-400 mb-8 max-w-sm leading-relaxed">
          1v1 Real-time combat.<br/><br/>
          Manage your mana and react to your opponent's attacks.<br/><br/>
          Heavy attacks deal massive damage but have a long cast time. Block them!
        </p>
        <button 
          onClick={() => socket?.emit('join_matchmaking')}
          className="bg-amber-500 hover:bg-amber-400 text-zinc-950 px-8 py-4 pixel-corners text-sm font-bold active:translate-y-1"
        >
          FIND MATCH
        </button>
      </div>
    );
  }

  if (status === 'waiting') {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 font-pixel text-white p-4 text-center">
        <div className="animate-pulse text-amber-400 mb-4">WAITING FOR OPPONENT...</div>
        <div className="text-[10px] text-zinc-500">Searching the realm...</div>
      </div>
    );
  }

  if (!gameState || !socket) return null;

  const me = gameState.players[socket.id];
  const opponentId = Object.keys(gameState.players).find(id => id !== socket.id)!;
  const opponent = gameState.players[opponentId];

  const isBusy = me.action !== null;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 font-pixel text-white max-w-md mx-auto relative overflow-hidden">
      
      {/* Opponent Area */}
      <div className="p-4 bg-zinc-900/50 border-b-4 border-zinc-800">
        <div className="flex justify-between items-end mb-2">
          <span className="text-[10px] text-red-400">ENEMY</span>
        </div>
        <div className="space-y-2">
          <StatBar value={opponent.hp} max={100} color="bg-red-500" icon={Heart} />
          <StatBar value={opponent.mana} max={100} color="bg-blue-500" icon={Zap} />
          <CastBar action={opponent.action} />
        </div>
      </div>

      {/* Arena */}
      <div className="flex-1 flex flex-col items-center justify-center relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-800 to-zinc-950">
        <Avatar player={opponent} isOpponent events={events} />
        <div className="h-8" /> {/* Spacer */}
        <Avatar player={me} events={events} />
        
        {status === 'finished' && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50">
            <h2 className={`text-3xl mb-4 ${gameState.winner === socket.id ? 'text-amber-400' : gameState.winner === 'draw' ? 'text-zinc-400' : 'text-red-500'}`}>
              {gameState.winner === socket.id ? 'VICTORY!' : gameState.winner === 'draw' ? 'DRAW' : 'DEFEAT'}
            </h2>
            <button 
              onClick={() => {
                setStatus('idle');
                setGameState(null);
              }}
              className="mt-8 bg-zinc-800 px-6 py-3 pixel-corners text-xs hover:bg-zinc-700 active:translate-y-1"
            >
              MAIN MENU
            </button>
          </div>
        )}
      </div>

      {/* Player Area */}
      <div className="p-4 bg-zinc-900/80 border-t-4 border-zinc-800">
        <div className="space-y-2 mb-4">
          <StatBar value={me.hp} max={100} color="bg-emerald-500" icon={Heart} />
          <StatBar value={me.mana} max={100} color="bg-blue-500" icon={Zap} />
          <CastBar action={me.action} />
        </div>

        {/* Controls */}
        <div className="grid grid-cols-4 gap-2">
          <button 
            disabled={isBusy}
            onClick={() => handleAction('light')}
            className="bg-zinc-800 border-b-4 border-zinc-900 active:border-b-0 active:translate-y-1 p-2 pixel-corners flex flex-col items-center gap-1 disabled:opacity-50 disabled:active:translate-y-0 disabled:active:border-b-4"
          >
            <Sword size={16} className="text-zinc-400" />
            <span className="text-[8px]">Light</span>
            <span className="text-[6px] text-zinc-500">[Q]</span>
          </button>
          <button 
            disabled={isBusy || me.mana < 30}
            onClick={() => handleAction('heavy')}
            className="bg-red-900/80 border-b-4 border-red-950 active:border-b-0 active:translate-y-1 p-2 pixel-corners flex flex-col items-center gap-1 disabled:opacity-50 disabled:active:translate-y-0 disabled:active:border-b-4"
          >
            <Sword size={16} className="text-red-400" />
            <span className="text-[8px]">Heavy</span>
            <span className="text-[6px] text-red-300/50">30MP [W]</span>
          </button>
          <button 
            disabled={isBusy || me.mana < 20}
            onClick={() => handleAction('block')}
            className="bg-blue-900/80 border-b-4 border-blue-950 active:border-b-0 active:translate-y-1 p-2 pixel-corners flex flex-col items-center gap-1 disabled:opacity-50 disabled:active:translate-y-0 disabled:active:border-b-4"
          >
            <Shield size={16} className="text-blue-400" />
            <span className="text-[8px]">Block</span>
            <span className="text-[6px] text-blue-300/50">20MP [E]</span>
          </button>
          <button 
            disabled={isBusy || me.mana < 40}
            onClick={() => handleAction('heal')}
            className="bg-emerald-900/80 border-b-4 border-emerald-950 active:border-b-0 active:translate-y-1 p-2 pixel-corners flex flex-col items-center gap-1 disabled:opacity-50 disabled:active:translate-y-0 disabled:active:border-b-4"
          >
            <Heart size={16} className="text-emerald-400" />
            <span className="text-[8px]">Heal</span>
            <span className="text-[6px] text-emerald-300/50">40MP [R]</span>
          </button>
        </div>
      </div>

    </div>
  );
}
