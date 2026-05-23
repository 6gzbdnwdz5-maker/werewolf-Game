const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const ROOM_CODE = '0609';
const MAX_PLAYERS = 5;

const ROLE_DECK = [
    '隐藏娃', '隐藏娃',
    '棒棒娃', '贴贴娃', '预知娃', '闹春娃', '转运娃', '集福娃'
];

let room = {
    seats: [null, null, null, null, null],
    gameState: 'waiting',
    currentPickerSeat: 1,
    deck: [],
    playerRoles: {},
    bottomCards: [],
    copiedSkills: {},
    finalRoles: {},
    wolves: [],
    votes: {},
    actionResolvers: new Map()
};

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function initGame() {
    let newDeck = shuffleArray([...ROLE_DECK]);
    room.deck = newDeck;
    room.playerRoles = {};
    room.bottomCards = [];
    room.copiedSkills = {};
    room.finalRoles = {};
    room.wolves = [];
    room.votes = {};
    room.currentPickerSeat = 1;
    room.gameState = 'picking';
    room.actionResolvers.clear();
}

function distributeRoles() {
    let selectedIndices = [];
    for (let seat = 1; seat <= MAX_PLAYERS; seat++) {
        let role = room.playerRoles[seat];
        let idx = room.deck.findIndex((r, i) => r === role && !selectedIndices.includes(i));
        if (idx !== -1) selectedIndices.push(idx);
    }
    room.bottomCards = room.deck.filter((_, idx) => !selectedIndices.includes(idx));
    if (room.bottomCards.length !== 3) room.bottomCards = room.deck.slice(-3);

    room.wolves = [];
    for (let seat = 1; seat <= MAX_PLAYERS; seat++) {
        if (room.playerRoles[seat] === '隐藏娃') room.wolves.push(seat);
    }
    room.finalRoles = { ...room.playerRoles };
}

function determineWinner(votedSeats) {
    const final = room.finalRoles;
    for (let seat of votedSeats) {
        if (final[seat] === '集福娃') return '集福娃独自获胜';
        for (let p in final) {
            if (room.copiedSkills[p] === '集福娃' && final[p] === '贴贴娃' && parseInt(p) === seat) {
                return '贴贴娃(复制集福娃)独自获胜';
            }
        }
    }
    const hasWolf = votedSeats.some(seat => final[seat] === '隐藏娃');
    if (hasWolf) return '接福阵营获胜';
    const isStick = votedSeats.some(seat => final[seat] === '棒棒娃');
    if (isStick) return '福星阵营获胜';
    const anyGood = votedSeats.some(seat => {
        const role = final[seat];
        return role === '贴贴娃' || role === '预知娃' || role === '闹春娃' || role === '转运娃';
    });
    if (anyGood) return '福星阵营获胜';
    if (room.wolves.length === 0 && votedSeats.includes(room.stickTarget) && final[room.stickTarget] === '棒棒娃') {
        return '接福阵营获胜';
    }
    return '福星阵营获胜';
}

async function runNightPhase() {
    room.gameState = 'night';
    const actionOrder = ['贴贴娃', '隐藏娃', '棒棒娃', '预知娃', '闹春娃', '转运娃'];
    for (let actionRole of actionOrder) {
        let candidates = [];
        for (let seat = 1; seat <= MAX_PLAYERS; seat++) {
            let currentRole = room.finalRoles[seat];
            if (currentRole === actionRole) candidates.push(seat);
            if (room.copiedSkills[seat] === actionRole && room.finalRoles[seat] === '贴贴娃') {
                candidates.push(seat);
            }
        }
        for (let seat of candidates) {
            await triggerPlayerAction(seat, actionRole);
        }
    }
    room.gameState = 'day';
    io.to(ROOM_CODE).emit('dayPhaseStart');
}

function triggerPlayerAction(seat, roleName) {
    return new Promise((resolve) => {
        const socketId = room.seats[seat];
        if (!socketId) return resolve();
        const client = io.sockets.sockets.get(socketId);
        if (!client) return resolve();

        let actionData = {};
        if (roleName === '隐藏娃') {
            actionData = { isAlone: (room.wolves.length === 1), wolves: room.wolves };
        } else if (roleName === '棒棒娃') {
            actionData = { hiddenSeats: room.wolves };
        }

        client.emit('actionTrigger', { actionName: `${roleName}行动`, actionData, timeout: 60000 });

        const resolver = (result) => {
            if (roleName === '贴贴娃' && result && result.copiedCard) {
                room.copiedSkills[seat] = result.copiedCard;
            } else if (roleName === '闹春娃' && result && result.swap) {
                const { a, b } = result.swap;
                if (a && b && a !== b && a >= 1 && a <= 5 && b >= 1 && b <= 5) {
                    let temp = room.finalRoles[a];
                    room.finalRoles[a] = room.finalRoles[b];
                    room.finalRoles[b] = temp;
                }
            } else if (roleName === '转运娃' && result && result.exchanged) {
                if (room.bottomCards.length > 0) {
                    const rand = Math.floor(Math.random() * room.bottomCards.length);
                    const bottomCard = room.bottomCards[rand];
                    const myCurrent = room.finalRoles[seat];
                    room.finalRoles[seat] = bottomCard;
                    room.bottomCards[rand] = myCurrent;
                }
            }
            resolve();
        };

        room.actionResolvers.set(`${seat}_${roleName}`, resolver);
        setTimeout(() => {
            if (room.actionResolvers.has(`${seat}_${roleName}`)) {
                room.actionResolvers.delete(`${seat}_${roleName}`);
                resolve();
            }
        }, 45000);

        client.once('actionDone', (data) => {
            if (data.seat === seat && data.actionName === `${roleName}行动`) {
                const fn = room.actionResolvers.get(`${seat}_${roleName}`);
                if (fn) fn(data.result);
                room.actionResolvers.delete(`${seat}_${roleName}`);
            }
        });
    });
}

async function runPickingPhase() {
    for (let order = 1; order <= MAX_PLAYERS; order++) {
        room.currentPickerSeat = order;
        const socketId = room.seats[order];
        if (!socketId) continue;
        const client = io.sockets.sockets.get(socketId);
        if (client) {
            client.emit('selectPhaseStart', { deck: room.deck, currentPickerSeat: order });
            await new Promise(resolve => {
                const onPick = (data) => {
                    if (data.seat === order && data.cardIndex !== undefined && data.cardIndex >= 0 && data.cardIndex < room.deck.length) {
                        const chosen = room.deck[data.cardIndex];
                        room.playerRoles[order] = chosen;
                        room.deck.splice(data.cardIndex, 1);
                        client.emit('assignRole', { role: chosen });
                        client.off('pickCard', onPick);
                        resolve();
                    } else {
                        client.emit('errorMsg', '选牌无效，请重新选择');
                    }
                };
                client.on('pickCard', onPick);
                setTimeout(() => {
                    if (!room.playerRoles[order]) {
                        const fallback = room.deck[0];
                        room.playerRoles[order] = fallback;
                        room.deck.shift();
                        client.emit('assignRole', { role: fallback });
                        client.off('pickCard', onPick);
                        resolve();
                    }
                }, 30000);
            });
        }
    }
    distributeRoles();
    await runNightPhase();
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ roomCode }) => {
        if (roomCode !== ROOM_CODE) {
            socket.emit('errorMsg', '房间号错误');
            return;
        }
        let seat = -1;
        for (let i = 1; i <= MAX_PLAYERS; i++) {
            if (!room.seats[i]) { seat = i; break; }
        }
        if (seat === -1) {
            socket.emit('errorMsg', '房间已满');
            return;
        }
        room.seats[seat] = socket.id;
        socket.emit('roomJoined', { seat, roomCode, playerCount: room.seats.filter(s => s).length });
        io.to(ROOM_CODE).emit('playerCountUpdate', room.seats.filter(s => s).length);

        const filled = room.seats.filter(s => s).length;
        if (filled === MAX_PLAYERS && room.gameState === 'waiting') {
            initGame();
            io.to(ROOM_CODE).emit('gameStarting');
            runPickingPhase();
        }
    });

    socket.on('actionRequestDetail', (data) => {
        const seat = data.seat;
        const client = io.sockets.sockets.get(socket.id);
        if (!client) return;
        const action = data.action;
        if (action === '贴贴娃查看底牌') {
            if (room.bottomCards.length) {
                const viewed = room.bottomCards[Math.floor(Math.random() * room.bottomCards.length)];
                client.emit('privateMessage', { title: '贴贴娃结果', content: `你查看了底牌: ${viewed}，你将复制它的技能与阵营` });
                socket.emit('actionDone', { seat, actionName: '贴贴娃行动', result: { copiedCard: viewed } });
            }
        } else if (action === '独狼看底牌') {
            if (room.wolves.length === 1 && room.bottomCards.length) {
                let first = room.bottomCards[0];
                client.emit('privateMessage', { title: '独狼窥探', content: `底牌为: ${first}` });
                if (first === '隐藏娃' && room.bottomCards.length >= 2) {
                    let second = room.bottomCards[1];
                    client.emit('privateMessage', { title: '额外查看', content: `再查看第二张底牌: ${second}` });
                }
                socket.emit('actionDone', { seat, actionName: '隐藏娃行动', result: { viewBottom: true } });
            }
        } else if (action === '狼队友确认') {
            const teammates = room.wolves.filter(w => w !== seat);
            client.emit('privateMessage', { title: '狼队友', content: `你的队友是: ${teammates.length ? '玩家' + teammates.join(',') : '无队友（独狼情况）'}` });
            socket.emit('actionDone', { seat, actionName: '隐藏娃行动', result: { confirmed: true } });
        } else if (action === '棒棒娃确认') {
            socket.emit('actionDone', { seat, actionName: '棒棒娃行动', result: { known: true } });
        } else if (action === '预知娃看底牌双张') {
            if (room.bottomCards.length >= 2) {
                client.emit('privateMessage', { title: '预知娃占卜', content: `两张底牌: ${room.bottomCards[0]}, ${room.bottomCards[1]}` });
            }
            socket.emit('actionDone', { seat, actionName: '预知娃行动', result: { seen: true } });
        } else if (action === '预知娃看玩家' && data.targetPlayer) {
            const targetRole = room.finalRoles[data.targetPlayer] || '未知';
            client.emit('privateMessage', { title: '预知娃洞察', content: `玩家${data.targetPlayer}的身份是: ${targetRole}` });
            socket.emit('actionDone', { seat, actionName: '预知娃行动', result: { seenPlayer: true } });
        } else if (action === '闹春娃交换' && data.playerA && data.playerB) {
            socket.emit('actionDone', { seat, actionName: '闹春娃行动', result: { swap: { a: data.playerA, b: data.playerB } } });
        } else if (action === '转运娃交换底牌') {
            socket.emit('actionDone', { seat, actionName: '转运娃行动', result: { exchanged: true } });
        }
    });

    socket.on('castVote', (data) => {
        const { seat, targetSeat } = data;
        if (room.gameState !== 'day') return;
        room.votes[seat] = targetSeat;
        const totalVoted = Object.keys(room.votes).length;
        if (totalVoted === MAX_PLAYERS) {
            const voteCount = {};
            for (let s = 1; s <= MAX_PLAYERS; s++) {
                const target = room.votes[s];
                if (target) voteCount[target] = (voteCount[target] || 0) + 1;
            }
            let maxVotes = 0;
            let winners = [];
            for (let t in voteCount) {
                if (voteCount[t] > maxVotes) {
                    maxVotes = voteCount[t];
                    winners = [parseInt(t)];
                } else if (voteCount[t] === maxVotes) {
                    winners.push(parseInt(t));
                }
            }
            const winnerMsg = determineWinner(winners);
            io.to(ROOM_CODE).emit('voteResult', { resultMsg: `得票最多: ${winners.join(',')}`, winner: winnerMsg });
            room.gameState = 'finished';
        }
    });

    socket.on('disconnect', () => {
        for (let i = 1; i <= MAX_PLAYERS; i++) {
            if (room.seats[i] === socket.id) {
                room.seats[i] = null;
                io.to(ROOM_CODE).emit('playerCountUpdate', room.seats.filter(s => s).length);
                break;
            }
        }
    });
});

server.listen(3000, () => {
    console.log('游戏服务器已启动 -> http://localhost:3000');
});
